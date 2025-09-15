// server.js (diagnostic build)
import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;

const HERE_KEY = process.env.HERE_API_KEY;
const LAND_URL = process.env.LAND_URL;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 18);
const LAND_ERODE_KM = Number(process.env.LAND_ERODE_KM || 2);
const DEBUG = !!Number(process.env.DEBUG || 0);

// ---------------- CORS ----------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------- Cache ----------------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// ---------------- Land mask ----------------
let LAND_FEATURE = null;
let LAND_INNER = null;

async function loadLandMask() {
  if (!LAND_URL) throw new Error('Missing LAND_URL');
  const r = await fetch(LAND_URL, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Failed to fetch LAND_URL: ${r.status}`);
  const gj = await r.json();

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
  if (!features.length) throw new Error('Land file had no geometries');

  // dissolve
  let merged = features[0];
  for (let i = 1; i < features.length; i++) {
    try { merged = turf.union(merged, features[i]) || merged; }
    catch { merged = turf.combine(turf.featureCollection([merged, features[i]])).features[0]; }
  }
  LAND_FEATURE = merged;

  try {
    const eroded = turf.buffer(merged, -LAND_ERODE_KM, { units: 'kilometers', steps: 16 });
    LAND_INNER = (eroded && eroded.geometry) ? eroded : null;
  } catch { LAND_INNER = null; }

  console.log('[LAND] loaded type=', LAND_FEATURE?.geometry?.type,
              '| inner=', LAND_INNER ? LAND_INNER.geometry.type : 'none',
              '| erode=', LAND_ERODE_KM, 'km');
}

function pointOnLand(lat, lng) {
  if (!LAND_FEATURE) return true;
  try { return turf.booleanPointInPolygon([lng, lat], LAND_FEATURE); }
  catch { return true; }
}
function pointInInnerLand(lat, lng) {
  if (!LAND_INNER) return false;
  try { return turf.booleanPointInPolygon([lng, lat], LAND_INNER); }
  catch { return false; }
}

function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKeyFor(lat, lng, miles) {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:car`;
}

/** Aggressive inland snapper (tries toward center, then ±90°, up to 250 km) */
function snapSeedInland(lat, lng, centerLat, centerLng) {
  if (pointInInnerLand(lat, lng)) return { lat, lng };
  const from = turf.point([lng, lat]);
  const center = turf.point([centerLng, centerLat]);
  const bearing = turf.bearing(from, center);
  const ladder = [1,2,3,5,8,13,21,34,55,75,100,125,150,200,250];

  // try to land in inner
  for (const d of ladder) {
    const dest = turf.destination(from, d, bearing, { units: 'kilometers' });
    const [x, y] = dest.geometry.coordinates;
    if (pointInInnerLand(y, x)) return { lat: y, lng: x };
  }
  // or just land
  for (const d of ladder) {
    const dest = turf.destination(from, d, bearing, { units: 'kilometers' });
    const [x, y] = dest.geometry.coordinates;
    if (pointOnLand(y, x)) return { lat: y, lng: x };
  }
  // perpendicular
  for (const side of [-90, +90]) {
    for (const d of ladder) {
      const dest = turf.destination(from, d, bearing + side, { units: 'kilometers' });
      const [x, y] = dest.geometry.coordinates;
      if (pointInInnerLand(y, x) || pointOnLand(y, x)) return { lat: y, lng: x };
    }
  }
  return { lat, lng };
}

// ---------------- HERE helpers ----------------
function herePolysToFeatures(isoline) {
  const polys = isoline?.polygons || [];
  const out = [];
  for (const p of polys) {
    const o = p.outer;
    let ring = [];
    if (Array.isArray(o) && o.length) {
      if (typeof o[0] === 'object') ring = o.map(pt => [Number(pt.lng), Number(pt.lat)]);
      else if (Array.isArray(o[0])) ring = o.map(([x,y]) => [Number(x), Number(y)]);
    } else if (o && o.type === 'LineString' && Array.isArray(o.coordinates)) {
      ring = o.coordinates.map(([x,y]) => [Number(x), Number(y)]);
    }
    if (!ring.length) continue;
    const [fx, fy] = ring[0]; const [lx, ly] = ring[ring.length-1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    out.push(turf.polygon([ring]));
  }
  return out;
}

async function fetchIsoline(lat, lng, meters) {
  const url = new URL('https://isoline.router.hereapi.com/v8/isolines');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('range[values]', String(meters));
  url.searchParams.set('range[type]', 'distance');
  url.searchParams.set('transportMode', 'car');

  const res = await fetch(url);
  const txt = await res.text();
  let data = {};
  try { data = JSON.parse(txt); } catch { data = {}; }

  if (DEBUG) {
    const keys = Object.keys(data || {});
    console.log('[HERE] keys:', keys);
    if (data?.notices?.length) console.log('[HERE] notices:', JSON.stringify(data.notices));
  }
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

function sampleBoundary(feature, n = 60) {
  try {
    const line = turf.polygonToLine(feature);
    const length = turf.length(line, { units: 'kilometers' });
    const step = Math.max(length / n, 0.001);
    const pts = [];
    for (let i = 0; i < n; i++) {
      const p = turf.along(line, i * step, { units: 'kilometers' });
      const [x,y] = p.geometry.coordinates;
      pts.push({ lat: y, lng: x });
    }
    return pts;
  } catch {
    const [minX,minY,maxX,maxY] = turf.bbox(feature);
    return [{lat:minY,lng:minX},{lat:minY,lng:maxX},{lat:maxY,lng:maxX},{lat:maxY,lng:minX}];
  }
}

// ---------------- Stitcher ----------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100;
  const stepMeters = Math.round(STEP_KM * 1000);
  const rings = Math.max(1, Math.ceil(targetKm / STEP_KM));
  const limit = pLimit(MAX_CONCURRENCY);

  let seeds = [{ lat, lng }];
  let merged = null;

  for (let ring = 0; ring < rings; ring++) {
    const inland = seeds.map(s => snapSeedInland(s.lat, s.lng, lat, lng));
    if (DEBUG) console.log(`-- ring ${ring} seeds=${inland.length}`);

    const jobs = inland.map(s => limit(async () => {
      const data = await fetchIsoline(s.lat, s.lng, stepMeters);
      if (!data.isolines?.length) return [];
      const feats = herePolysToFeatures(data.isolines[0]);
      if (DEBUG) console.log(`[EXTRACTOR] features found: ${feats.length}`);
      return feats;
    }));

    const results = await Promise.allSettled(jobs);
    const feats = [];
    for (const r of results) if (r.status === 'fulfilled' && r.value.length) feats.push(...r.value);
    if (!feats.length) {
      if (DEBUG) console.log('[NO POLYS] all seeds failed on this ring');
      throw new Error('No polygons from HERE at this ring');
    }

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);
    try { merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true }); } catch {}

    const boundarySeeds = sampleBoundary(merged, 60);
    const seen = new Set(); const nextSeeds = [];
    for (const p of boundarySeeds) {
      const k = `${Math.round(p.lat*100)/100}_${Math.round(p.lng*100)/100}`;
      if (!seen.has(k)) { seen.add(k); nextSeeds.push(p); }
    }
    seeds = nextSeeds.slice(0, 64);
  }

  try {
    merged = turf.buffer(merged, 3, { units: 'kilometers' });
    merged = turf.buffer(merged, -3, { units: 'kilometers' });
  } catch {}
  try { merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true }); } catch {}

  return merged;
}

// ---------------- API ----------------
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

// ---------- Diagnostics ----------
app.get('/diag/land', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const centerLat = Number(req.query.clat ?? lat);
  const centerLng = Number(req.query.clng ?? lng);
  const onLand = pointOnLand(lat, lng);
  const onInner = pointInInnerLand(lat, lng);
  const snapped = snapSeedInland(lat, lng, centerLat, centerLng);
  res.json({ onLand, onInner, snapped, erodeKm: LAND_ERODE_KM });
});

app.get('/diag/here', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const meters = Number(req.query.meters ?? 100000);
  const s = snapSeedInland(lat, lng, lat, lng);
  const data = await fetchIsoline(s.lat, s.lng, meters);
  res.json({ snapped: s, keys: Object.keys(data || {}), sample: data.isolines?.[0] ?? data.notices ?? data });
});

// ------------- boot -------------
await loadLandMask();
app.listen(PORT, () => console.log('Server on :' + PORT));
