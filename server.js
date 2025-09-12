// server.js
import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;

const HERE_KEY = process.env.HERE_API_KEY;
const LAND_URL = process.env.LAND_URL;           // <= ADD THIS in Render env
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 20);

// ---- CORS so Bubble can call this from the browser ----
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// In-memory cache (swap for Redis later)
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false }); // 24h

/* ------------------------------------------------------------------ *
 * LAND MASK LOADING
 * We fetch your land multipolygon once at boot and keep it in memory.
 * It can be: FeatureCollection | Feature | GeometryCollection
 * ------------------------------------------------------------------ */
let LAND_FEATURE = null;

async function loadLandMask() {
  if (!LAND_URL) throw new Error('Missing LAND_URL env var');
  const r = await fetch(LAND_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch LAND_URL: ${r.status}`);
  const gj = await r.json();

  // Normalize to one (Multi)Polygon feature
  let features = [];
  if (gj.type === 'FeatureCollection') {
    features = gj.features.filter(f => !!f.geometry);
  } else if (gj.type === 'GeometryCollection') {
    features = gj.geometries.map(g => turf.feature(g));
  } else if (gj.type === 'Feature' && gj.geometry) {
    features = [gj];
  } else if (gj.type) {
    features = [turf.feature(gj)];
  }

  if (!features.length) throw new Error('LAND_URL contained no geometries');

  // Dissolve to one feature
  let merged = features[0];
  for (let i = 1; i < features.length; i++) {
    try { merged = turf.union(merged, features[i]) || merged; }
    catch { merged = turf.combine(turf.featureCollection([merged, features[i]])).features[0]; }
  }

  LAND_FEATURE = merged;
  console.log('[LAND] mask ready → type:', LAND_FEATURE.geometry.type);
}

function isOnLand(lat, lng) {
  if (!LAND_FEATURE) return true; // fail open
  const pt = turf.point([lng, lat]);
  try { return turf.booleanPointInPolygon(pt, LAND_FEATURE); }
  catch { return true; }
}

/* Move point toward center in small steps until it is on land (or we give up) */
function movePointInland(lat, lng, centerLat, centerLng) {
  if (isOnLand(lat, lng)) return { lat, lng };

  const start = turf.point([lng, lat]);
  const center = turf.point([centerLng, centerLat]);

  const bearingToCenter = turf.bearing(start, center);
  // Try increasing steps up to ~60 km
  const stepsKm = [1, 2, 3, 5, 8, 13, 21, 34, 55, 60];

  for (const d of stepsKm) {
    const dest = turf.destination(start, d, bearingToCenter, { units: 'kilometers' });
    const [x, y] = dest.geometry.coordinates;
    if (isOnLand(y, x)) return { lat: y, lng: x };
  }

  // Plan B: also try perpendicular nudges (±90°) a bit
  for (const side of [-90, +90]) {
    for (const d of [2, 5, 10, 20, 40, 60]) {
      const dest = turf.destination(start, d, bearingToCenter + side, { units: 'kilometers' });
      const [x, y] = dest.geometry.coordinates;
      if (isOnLand(y, x)) return { lat: y, lng: x };
    }
  }

  // Give up – return original (HERE may still reject it)
  return { lat, lng };
}

/* ------------------------------------------------------------------ *
 * HELPERS
 * ------------------------------------------------------------------ */
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

/* HERE → extract polygons into Turf features regardless of format */
function herePolyToFeatures(isoline) {
  const polys = isoline?.polygons || [];
  const out = [];

  for (const p of polys) {
    const outer = p.outer;
    let ring = [];

    // 1) Array of points
    if (Array.isArray(outer)) {
      if (outer.length) {
        if (typeof outer[0] === 'object' && ('lat' in outer[0] || 'lng' in outer[0])) {
          ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
        } else if (Array.isArray(outer[0])) {
          ring = outer.map(pair => [Number(pair[0]), Number(pair[1])]);
        }
      }
    }

    // 2) GeoJSON-like LineString
    if (!ring.length && outer && typeof outer === 'object' &&
        outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      ring = outer.coordinates.map(([x, y]) => [Number(x), Number(y)]);
    }

    if (!ring.length) continue;

    // ensure closed ring
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
  if (!res.ok) throw new Error(`HERE ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data;
}

function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try { out = turf.union(out, features[i]) || out; }
    catch { out = turf.combine(turf.featureCollection([out, features[i]])).features[0]; }
  }
  return out;
}

function sampleBoundary(feature, n = 80) {
  const line = turf.polygonToLine(feature);
  const length = turf.length(line, { units: 'kilometers' });
  const step = length / n;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = turf.along(line, i * step, { units: 'kilometers' });
    const [x, y] = p.geometry.coordinates;
    pts.push({ lat: y, lng: x });
  }
  return pts;
}

/* ------------------------------------------------------------------ *
 * CORE STITCHER (with inland seeding)
 * ------------------------------------------------------------------ */
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100;                       // HERE distance ceiling per call
  const stepMeters = Math.round(STEP_KM * 1000);
  const rings = Math.max(1, Math.ceil(targetKm / STEP_KM));

  let seeds = [{ lat, lng }];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < rings; ring++) {
    // Snap all seeds onto land before calling HERE
    const inlandSeeds = seeds.map(s => movePointInland(s.lat, s.lng, lat, lng));

    const jobs = inlandSeeds.map(s => limit(async () => {
      const data = await fetchIsoline(s.lat, s.lng, stepMeters);

      if (!data.isolines || !data.isolines.length) {
        // log to help diagnose quota/network issues
        if (data.notices) {
          console.warn('[SEED NOTICE]', ring, JSON.stringify(data.notices));
        }
        return [];
      }

      const feats = herePolyToFeatures(data.isolines[0]);
      return feats;
    }));

    const results = await Promise.allSettled(jobs);
    const feats = [];
    for (const r of results) {
      if (r.status === 'fulfilled') feats.push(...r.value);
    }

    if (!feats.length) throw new Error('No polygons from HERE at this ring');

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

    const boundarySeeds = sampleBoundary(merged, 80);
    const seen = new Set(); const nextSeeds = [];
    for (const p of boundarySeeds) {
      const key = `${Math.round(p.lat*100)/100}_${Math.round(p.lng*100)/100}`;
      if (!seen.has(key)) { seen.add(key); nextSeeds.push(p); }
    }
    seeds = nextSeeds;
  }

  // smooth corners & final simplify
  try {
    merged = turf.buffer(merged, 3, { units: 'kilometers' });
    merged = turf.buffer(merged, -3, { units: 'kilometers' });
  } catch {}
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  return merged;
}

/* ------------------------------------------------------------------ *
 * API
 * ------------------------------------------------------------------ */
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

    const key = cacheKey(lat, lng, miles);
    const hit = cache.get(key);
    if (hit) return res.json({ cached: true, geojson: hit });

    const safeMiles = Math.min(miles, 450);
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

/* Boot: load land mask once, then start server */
await loadLandMask();
app.listen(PORT, () => console.log('Server on :' + PORT));
