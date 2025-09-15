// server.js
import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;

const HERE_KEY = process.env.HERE_API_KEY;        // required
const LAND_URL = process.env.LAND_URL;            // required: public URL to your land-10m.geojson
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 18);
const LAND_ERODE_KM = Number(process.env.LAND_ERODE_KM || 2); // how much to shave off coasts

// ------------- CORS (so Bubble can call directly) ----------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------- Simple cache (24h) --------------------------------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// ------------- Land mask (loaded once at boot) -------------------
let LAND_FEATURE = null;    // dissolved (Multi)Polygon
let LAND_INNER = null;      // eroded land (buffer negative), safer for snapping

async function loadLandMask() {
  if (!LAND_URL) throw new Error('Missing LAND_URL env var');

  const r = await fetch(LAND_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch LAND_URL (${r.status})`);
  const gj = await r.json();

  // Normalize to features[]
  let features = [];
  if (gj.type === 'FeatureCollection') {
    features = (gj.features || []).filter(f => f && f.geometry);
  } else if (gj.type === 'GeometryCollection') {
    features = (gj.geometries || []).map(g => turf.feature(g)).filter(Boolean);
  } else if (gj.type === 'Feature' && gj.geometry) {
    features = [gj];
  } else if (gj.type) {
    features = [turf.feature(gj)];
  }

  if (!features.length) throw new Error('LAND_URL contained no geometries');

  // Dissolve to one polygon/multipolygon
  let merged = features[0];
  for (let i = 1; i < features.length; i++) {
    try { merged = turf.union(merged, features[i]) || merged; }
    catch {
      // fallback combine if union triangulation fails
      merged = turf.combine(turf.featureCollection([merged, features[i]])).features[0];
    }
  }

  LAND_FEATURE = merged;
  // Erode (shrink) coastlines to avoid seeds sitting exactly on the shoreline
  try {
    const eroded = turf.buffer(LAND_FEATURE, -LAND_ERODE_KM, { units: 'kilometers', steps: 16 });
    // buffer(-) can return MultiPolygon/Polygon or null (if too aggressive); keep if valid
    if ( eroded && eroded.geometry && (eroded.geometry.type === 'Polygon' || eroded.geometry.type === 'MultiPolygon') ) {
      LAND_INNER = eroded;
    } else {
      LAND_INNER = null;
    }
  } catch {
    LAND_INNER = null;
  }

  console.log('[LAND] mask ready. Type:', LAND_FEATURE?.geometry?.type,
              '| inner eroded:',
              LAND_INNER ? LAND_INNER.geometry.type : 'none');
}

function pointOnLand(lat, lng) {
  if (!LAND_FEATURE) return true; // fail-open if mask missing
  try { return turf.booleanPointInPolygon([lng, lat], LAND_FEATURE); }
  catch { return true; }
}

function pointInInnerLand(lat, lng) {
  if (!LAND_INNER) return false;
  try { return turf.booleanPointInPolygon([lng, lat], LAND_INNER); }
  catch { return false; }
}

/**
 * Snap a seed point robustly onto land (prefer inner-land shaved by LAND_ERODE_KM).
 * March toward a center bearing in increasing distances up to ~150 km.
 * Also try ±90° perpendicular bearings if needed.
 */
function snapSeedInland(lat, lng, centerLat, centerLng) {
  // If already safely inside inner-land, return
  if (pointInInnerLand(lat, lng)) return { lat, lng };
  // If on land (coastline), we’ll still try to nudge to inner-land
  const from = turf.point([lng, lat]);
  const center = turf.point([centerLng, centerLat]);
  const toCenterBearing = turf.bearing(from, center);

  // distances in km to try along the center bearing
  const ladder = [1, 2, 3, 5, 8, 13, 21, 34, 55, 75, 100, 125, 150];

  // 1) Prefer to land *inside* inner-land
  for (const d of ladder) {
    const dest = turf.destination(from, d, toCenterBearing, { units: 'kilometers' });
    const [dx, dy] = dest.geometry.coordinates;
    if (pointInInnerLand(dy, dx)) return { lat: dy, lng: dx };
  }

  // 2) If inner-land not hit, accept first point that is at least on land
  for (const d of ladder) {
    const dest = turf.destination(from, d, toCenterBearing, { units: 'kilometers' });
    const [dx, dy] = dest.geometry.coordinates;
    if (pointOnLand(dy, dx)) return { lat: dy, lng: dx };
  }

  // 3) Try perpendicular ±90° bearings (might cross narrow peninsulas)
  for (const side of [-90, +90]) {
    for (const d of ladder) {
      const dest = turf.destination(from, d, toCenterBearing + side, { units: 'kilometers' });
      const [dx, dy] = dest.geometry.coordinates;
      if (pointInInnerLand(dy, dx) || pointOnLand(dy, dx)) return { lat: dy, lng: dx };
    }
  }

  // 4) Give up: return original (HERE may reject it, but this is rare now)
  return { lat, lng };
}

// ------------- Utility helpers ----------------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

// Parse HERE polygons → Turf features (supports array+LineString)
function herePolyToFeatures(isoline) {
  const polys = isoline?.polygons || [];
  const out = [];

  for (const p of polys) {
    const outer = p.outer;
    let ring = [];

    if (Array.isArray(outer)) {
      if (outer.length) {
        if (typeof outer[0] === 'object' && (('lat' in outer[0]) || ('lng' in outer[0]))) {
          ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
        } else if (Array.isArray(outer[0])) {
          ring = outer.map(pair => [Number(pair[0]), Number(pair[1])]);
        }
      }
    } else if (outer && typeof outer === 'object' && outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      ring = outer.coordinates.map(([x, y]) => [Number(x), Number(y)]);
    }

    if (!ring.length) continue;
    // close ring
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    out.push(turf.polygon([ring]));
  }

  return out;
}

async function fetchIsoline(lat, lng, stepMeters) {
  const url = new URL('https://isoline.router.hereapi.com/v8/isolines');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('range[values]', String(stepMeters));
  url.searchParams.set('range[type]', 'distance');
  url.searchParams.set('transportMode', 'car');

  const res = await fetch(url);
  const txt = await res.text();
  if (!res.ok) throw new Error(`HERE isoline ${res.status}: ${txt}`);

  let data = {};
  try { data = JSON.parse(txt); } catch { data = {}; }
  return data;
}

function unionAll(features) {
  if (!features || !features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try { out = turf.union(out, features[i]) || out; }
    catch {
      try { out = turf.combine(turf.featureCollection([out, features[i]])).features[0]; }
      catch {}
    }
  }
  return out;
}

function sampleBoundary(feature, n = 60) {
  try {
    const line = turf.polygonToLine(feature);
    const length = turf.length(line, { units: 'kilometers' });
    const step = Math.max(length / n, 0.001);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = turf.along(line, i * step, { units: 'kilometers' });
      const [x, y] = p.geometry.coordinates;
      pts.push({ lat: y, lng: x });
    }
    return pts;
  } catch {
    const b = turf.bbox(feature);
    const [minX, minY, maxX, maxY] = b;
    return [
      { lat: minY, lng: minX }, { lat: minY, lng: maxX },
      { lat: maxY, lng: maxX }, { lat: maxY, lng: minX }
    ];
  }
}

// ------------- Core stitcher (multi-ring) ------------------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100;                         // HERE distance ceiling
  const stepMeters = Math.round(STEP_KM * 1000);
  const rings = Math.max(1, Math.ceil(targetKm / STEP_KM));

  let seeds = [{ lat, lng }];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < rings; ring++) {
    // Project all seeds safely onto land first
    const inlandSeeds = seeds.map(s => snapSeedInland(s.lat, s.lng, lat, lng));

    const jobs = inlandSeeds.map(s => limit(async () => {
      const data = await fetchIsoline(s.lat, s.lng, stepMeters);
      if (!data.isolines || !data.isolines.length) return [];
      return herePolyToFeatures(data.isolines[0]);
    }));

    const results = await Promise.allSettled(jobs);
    const feats = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.length) feats.push(...r.value);
    }
    if (!feats.length) throw new Error('No polygons from HERE at this ring');

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);

    try { merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true }); } catch {}

    // Next ring seeds from the current boundary (dedup coarse, cap count)
    const boundarySeeds = sampleBoundary(merged, 60);
    const seen = new Set(); const nextSeeds = [];
    for (const p of boundarySeeds) {
      const k = `${Math.round(p.lat*100)/100}_${Math.round(p.lng*100)/100}`;
      if (!seen.has(k)) { seen.add(k); nextSeeds.push(p); }
    }
    seeds = nextSeeds.slice(0, 64);
  }

  // Light smooth to remove sharp unions, then final simplify
  try {
    merged = turf.buffer(merged, 3, { units: 'kilometers' });
    merged = turf.buffer(merged, -3, { units: 'kilometers' });
  } catch {}
  try { merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true }); } catch {}

  return merged;
}

// ------------- API ----------------------------------------------
function cacheKeyFor(lat, lng, miles) {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:car`;
}

app.get('/range', async (req, res) => {
  try {
    if (!HERE_KEY) throw new Error('Missing HERE_API_KEY');
    if (!LAND_FEATURE) throw new Error('Land mask not loaded yet');

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(miles)) {
      return res.status(400).json({ error: 'lat,lng,miles required' });
    }

    const key = cacheKeyFor(lat, lng, miles);
    const hit = cache.get(key);
    if (hit) return res.json({ cached: true, geojson: hit });

    const safeMiles = Math.min(miles, 450); // guardrail
    const t0 = Date.now();
    const feature = await computeStitchedPolygon(lat, lng, safeMiles);
    const ms = Date.now() - t0;

    cache.set(key, feature, 60 * 60 * 24);
    res.json({ cached: false, ms, geojson: feature });
  } catch (e) {
    console.error('ERROR /range', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/health', (_, res) => res.send('ok'));

// Boot: load land, then start server
await loadLandMask();
app.listen(PORT, () => console.log('Server on :' + PORT));
