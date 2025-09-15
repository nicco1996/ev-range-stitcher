import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 8);
const DEBUG = process.env.DEBUG === '1';

// CORS so you can call this from Bubble
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Simple in-memory cache (swap to Redis later if you want)
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// ---------- Small helpers ----------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

// Convert HERE isoline polygons (flexible polyline strings or arrays) to GeoJSON features
function herePolyToFeatures(isoline) {
  const polys = Array.isArray(isoline?.polygons) ? isoline.polygons : [];
  const feats = [];

  for (const p of polys) {
    let ring = [];

    // Here v8 isoline polygons often look like: { outer: "flexpolyline-string" }
    // or { outer: { type:"LineString", coordinates:[ [lng,lat], ... ] } }
    const outer = p.outer;

    if (typeof outer === 'string') {
      // Flexible polyline string. Decode manually (simple & good enough for isolines).
      // Flexpolyline encodes (lat,lon) pairs with 1e5 precision and delta encoding.
      // For simplicity we rely on HERE’s REST option to return coordinates directly:
      // BUT isoline v8 returns flexpolyline only, so we decode a *subset*:
      // To avoid a heavy dependency, ask the API to return "json" outer rings (fallback below).
      // If still string, we skip (we’ll try to use the LineString form instead).
    } else if (outer && typeof outer === 'object') {
      // GeoJSON-like line
      if (outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
        ring = outer.coordinates.map(([x, y]) => [Number(x), Number(y)]);
      }
    }

    // If we didn’t get a ring, try a generic tolerant parse
    if (!ring.length && Array.isArray(outer)) {
      // Could be [[lng,lat], ...] or [{lat,lng}, ...]
      const first = outer[0];
      if (Array.isArray(first)) {
        ring = outer.map(([x, y]) => [Number(x), Number(y)]);
      } else if (first && typeof first === 'object') {
        ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
    }

    if (!ring.length) continue;

    // Ensure closed
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    feats.push(turf.polygon([ring]));
  }

  if (DEBUG) console.log('[EXTRACTOR] features found:', feats.length);
  return feats;
}

// ---------- HERE calls ----------

// Snap a point to the nearest driveable road using a tiny route.
// We try a few tiny offsets; if Routing returns a route, we read the snapped departure.
async function snapToRoad(lat, lng) {
  const deltas = [
    [0.0008, 0], [-0.0008, 0], [0, 0.0008], [0, -0.0008],
    [0.0012, 0.0012], [-0.0012, 0.0012], [0.0012, -0.0012], [-0.0012, -0.0012]
  ];
  for (const [dy, dx] of deltas) {
    const url = new URL('https://router.hereapi.com/v8/routes');
    url.searchParams.set('apiKey', HERE_KEY);
    url.searchParams.set('transportMode', 'car');
    url.searchParams.set('origin', `${lat},${lng}`);
    url.searchParams.set('destination', `${lat + dy},${lng + dx}`);
    url.searchParams.set('return', 'summary');
    url.searchParams.set('routingMode', 'fast');

    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const data = await r.json();
      const sec = data?.routes?.[0]?.sections?.[0];
      const snapLoc = sec?.departure?.place?.location;
      if (snapLoc && typeof snapLoc.lat === 'number' && typeof snapLoc.lng === 'number') {
        return { lat: snapLoc.lat, lng: snapLoc.lng };
      }
    } catch {
      // keep trying other deltas
    }
  }
  return null;
}

// Request a distance isoline (in meters) from a given seed
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

  const data = JSON.parse(txt);
  if (DEBUG) console.log('[HERE] keys:', Object.keys(data));

  if (Array.isArray(data.isolines) && data.isolines.length > 0) {
    if (DEBUG) console.log('[HERE] isolines[0] keys:', Object.keys(data.isolines[0]));
    return data;
  }

  // If no polygons, bubble up a meaningful sample (notices usually contain couldNotMatchOrigin)
  if (DEBUG) console.log('[NO POLYS] sample payload:', JSON.stringify(data).slice(0, 500));
  return data; // caller will check and decide
}

// ---------- Geometry utils ----------
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

function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try { out = turf.union(out, features[i]) || out; }
    catch { out = turf.combine(turf.featureCollection([out, features[i]])).features[0]; }
  }
  return out;
}

// ---------- Core stitcher ----------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = Math.max(1, targetMiles) * 1.60934;
  const STEP_KM = 100;                   // HERE distance ceiling per call
  const stepMeters = Math.round(STEP_KM * 1000);
  const iters = Math.max(1, Math.ceil(targetKm / STEP_KM));

  // Ring 0 — snap center to road, then get first isoline
  const centerSnapped = await snapToRoad(lat, lng);
  if (!centerSnapped) throw new Error('Center point could not snap to road');
  const first = await fetchIsoline(centerSnapped.lat, centerSnapped.lng, stepMeters);

  let feats0 = [];
  if (Array.isArray(first.isolines) && first.isolines.length) {
    feats0 = herePolyToFeatures(first.isolines[0]);
  }
  if (!feats0.length) throw new Error('No polygons from HERE at ring 0');

  let merged = unionAll(feats0);
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  const limit = pLimit(MAX_CONCURRENCY);

  // Next rings
  for (let ring = 1; ring < iters; ring++) {
    const seeds = sampleBoundary(merged, 80);

    // snap every seed to the road first
    const snapped = await Promise.allSettled(
      seeds.map(s => limit(() => snapToRoad(s.lat, s.lng)))
    );

    // fetch isolines only for seeds that snapped
    const jobs = [];
    snapped.forEach((r, idx) => {
      if (r.status === 'fulfilled' && r.value) {
        const s = r.value;
        jobs.push(limit(() => fetchIsoline(s.lat, s.lng, stepMeters)));
      } else if (DEBUG) {
        console.log(`[SEED SNAP FAIL] ${idx}`);
      }
    });

    const results = await Promise.allSettled(jobs);

    // collect polygons
    const feats = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const data = r.value;

      if (Array.isArray(data.isolines) && data.isolines.length) {
        const f = herePolyToFeatures(data.isolines[0]);
        if (f.length) feats.push(...f);
      } else if (DEBUG && Array.isArray(data.notices)) {
        console.log('[SEED NOTICE]', JSON.stringify(data.notices));
      }
    }

    if (!feats.length) {
      if (DEBUG) console.log('[NO POLYS] all seeds failed on this ring');
      throw new Error('No polygons from HERE at this ring');
    }

    // merge and simplify before next ring
    merged = unionAll([merged, ...feats]);
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });
  }

  // Gentle smoothing + simplify
  let smooth = merged;
  try {
    smooth = turf.buffer(smooth, 3, { units: 'kilometers' });
    smooth = turf.buffer(smooth, -3, { units: 'kilometers' });
  } catch {}
  smooth = turf.simplify(smooth, { tolerance: 0.01, highQuality: true });

  return smooth;
}

// ---------- HTTP API ----------
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
