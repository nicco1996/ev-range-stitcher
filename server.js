import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 18);
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ---------------- CORS ----------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------- Cache (24h) --------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// Minimal flexible-polyline decoder (no external package)
function decodeFlexPolyline(str) {
  if (typeof str !== 'string' || !str.length) return [];
  let i = 0;
  const uvar = () => {
    let res = 0, shift = 0, b;
    do {
      b = str.charCodeAt(i++) - 63;
      res |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return res;
  };
  const svar = () => {
    const u = uvar();
    return (u & 1) ? ~(u >> 1) : (u >> 1);
  };

  const precision = uvar();
  const thirdDim = uvar();
  const thirdPrec = uvar();

  const factor = Math.pow(10, precision);
  const thirdFactor = Math.pow(10, thirdPrec);
  const hasZ = thirdDim !== 0;

  let lat = 0, lng = 0, z = 0;
  const out = [];
  while (i < str.length) {
    lat += svar();
    lng += svar();
    const rec = [lat / factor, lng / factor];
    if (hasZ) { z += svar(); rec.push(z / thirdFactor); }
    out.push(rec);
  }
  return out; // [[lat,lng,(z)]...]
}

function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

// Robust extractor: collect any polygon ring in the HERE payload
function hereResponseToFeatures(data) {
  const features = [];

  const normalizeOuter = (outer) => {
    if (Array.isArray(outer)) {
      if (!outer.length) return [];
      if (typeof outer[0] === 'object' && outer[0] &&
          (('lat' in outer[0]) || ('lng' in outer[0]))) {
        return outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
      if (Array.isArray(outer[0])) {
        return outer.map(pair => [Number(pair[0]), Number(pair[1])]);
      }
    }
    if (outer && typeof outer === 'object' &&
        outer.type === 'LineString' &&
        Array.isArray(outer.coordinates)) {
      const c = outer.coordinates;
      if (!Array.isArray(c) || !c.length) return [];
      if (Array.isArray(c[0])) return c.map(p => [Number(p[0]), Number(p[1])]);
      if (typeof c[0] === 'object' && c[0] && (('lat' in c[0]) || ('lng' in c[0]))) {
        return c.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
    }
    if (typeof outer === 'string') {
      try {
        const coords = decodeFlexPolyline(outer); // [[lat,lng,(z)]...]
        return coords.map(([la, ln]) => [Number(ln), Number(la)]);
      } catch {}
    }
    return [];
  };

  const ringToPolygon = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring = [...ring, [fx, fy]];
    try { return turf.polygon([ring], {}); }
    catch { return null; }
  };

  const dfs = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if ('outer' in obj) {
      const ring = normalizeOuter(obj.outer);
      const poly = ringToPolygon(ring);
      if (poly) features.push(poly);
    }
    if (Array.isArray(obj.polygons)) for (const it of obj.polygons) dfs(it);
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (Array.isArray(v)) for (const x of v) dfs(x);
      else if (v && typeof v === 'object') dfs(v);
    }
  };

  dfs(data);
  if (DEBUG) console.log(`[EXTRACTOR] features found: ${features.length}`);
  return features;
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

  if (DEBUG) {
    const iso0 = data?.isolines?.[0];
    console.log('[HERE] keys:', Object.keys(data || {}));
    if (iso0) console.log('[HERE] isolines[0] keys:', Object.keys(iso0));
  }
  return data;
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

// ----------- geometry helpers -----------
function nudgeToward(lat, lng, centerLat, centerLng, km = 3) {
  const from = turf.point([lng, lat]);
  const to = turf.point([centerLng, centerLat]);
  const bearing = turf.bearing(from, to);
  const dest = turf.destination(from, km, bearing, { units: 'kilometers' });
  const [nx, ny] = dest.geometry.coordinates;
  return { lat: ny, lng: nx };
}

// Try HERE multiple times per seed with increasing inland distances
async function isolineFromSeedWithRetries(seed, center, stepMeters) {
  const attemptsKm = [0, 3, 6, 10, 15, 25]; // 0 = as-is, then stronger nudges
  for (const km of attemptsKm) {
    const p = km === 0 ? seed : nudgeToward(seed.lat, seed.lng, center.lat, center.lng, km);
    try {
      const data = await fetchIsoline(p.lat, p.lng, stepMeters);
      const feats = hereResponseToFeatures(data);
      if (feats.length) return feats;
      if (DEBUG && data?.notices?.length) {
        console.log('[SEED NOTICE]', km, JSON.stringify(data.notices).slice(0, 200));
      }
    } catch (e) {
      if (DEBUG) console.log('[SEED FAIL]', km, e.message);
    }
  }
  return []; // all attempts failed
}

// --------------- Stitcher ----------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100;
  const stepMeters = Math.round(STEP_KM * 1000);
  const iters = Math.max(1, Math.ceil(targetKm / STEP_KM));

  let seeds = [{ lat, lng }];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < iters; ring++) {
    // Evaluate all seeds with retry nudges
    const centroidSeed = { lat: lat, lng: lng }; // fallback center if not merged yet
    const centerPt = merged
      ? (() => {
          const [clng, clat] = turf.center(merged).geometry.coordinates;
          return { lat: clat, lng: clng };
        })()
      : centroidSeed;

    const jobs = seeds.map(s => limit(() => isolineFromSeedWithRetries(s, centerPt, stepMeters)));
    const results = await Promise.allSettled(jobs);

    const feats = [];
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value?.length) feats.push(...r.value);
    }
    if (!feats.length) {
      if (DEBUG) {
        const ok = results.find(r => r.status === 'fulfilled')?.value;
        console.log('[NO POLYS] all seeds failed on this ring');
      }
      throw new Error('No polygons from HERE at this ring');
    }

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);
    try { merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true }); } catch {}

    // Next seeds from boundary; de-dup coarse; fewer seeds to reduce calls
    const boundarySeeds = sampleBoundary(merged, 60);
    const seen = new Set();
    const nextSeeds = [];
    for (const p of boundarySeeds) {
      const k = `${Math.round(p.lat * 100) / 100}_${Math.round(p.lng * 100) / 100}`;
      if (!seen.has(k)) { seen.add(k); nextSeeds.push(p); }
    }
    seeds = nextSeeds.slice(0, 64); // cap
  }

  // smoothing pass
  let smooth = merged;
  try {
    smooth = turf.buffer(smooth, 3, { units: 'kilometers' });
    smooth = turf.buffer(smooth, -3, { units: 'kilometers' });
  } catch {}
  try { smooth = turf.simplify(smooth, { tolerance: 0.01, highQuality: true }); } catch {}

  return smooth;
}

// ---------------- API -------------------
app.get('/range', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!HERE_KEY) throw new Error('Missing HERE_API_KEY');
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
app.listen(PORT, () => console.log('Server on :' + PORT));
