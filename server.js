import { decode } from '@here/flexpolyline';
import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY;
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

// Helpers ---------------------------------------------------------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

function herePolyToFeatures(isoline) {
  const polys = isoline?.polygons || [];
  const features = [];

  function normalizeOuter(outer) {
    // A) Array
    if (Array.isArray(outer)) {
      if (!outer.length) return [];
      // A1) [{lat, lng}, ...]
      if (typeof outer[0] === 'object' && (('lat' in outer[0]) || ('lng' in outer[0]))) {
        return outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
      // A2) [[lng, lat], ...]
      if (Array.isArray(outer[0])) {
        return outer.map(pair => [Number(pair[0]), Number(pair[1])]);
      }
    }

    // B) GeoJSON-like line object
    if (outer && typeof outer === 'object' && outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      const c = outer.coordinates;
      if (!c.length) return [];
      if (Array.isArray(c[0])) {
        // [[lng,lat], ...]
        return c.map(pair => [Number(pair[0]), Number(pair[1])]);
      }
      // [{lat, lng}, ...]
      if (typeof c[0] === 'object' && (('lat' in c[0]) || ('lng' in c[0]))) {
        return c.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
    }

    // C) HERE flexible polyline string
    if (typeof outer === 'string') {
      try {
        // decode returns [ [lat,lng], [lat,lng], ... ]
        const coords = decode(outer);
        return coords.map(([lat, lng]) => [Number(lng), Number(lat)]);
      } catch {
        return [];
      }
    }

    return [];
  }

  for (const p of polys) {
    const ring = normalizeOuter(p.outer);
    if (!ring.length) continue;

    // ensure closed ring
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    features.push(turf.polygon([ring], {}));
  }

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
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HERE isoline ${res.status}: ${txt}`);
  }
  const data = await res.json();
  if (!data.isolines || !data.isolines.length) throw new Error('No isolines returned');
  return data;
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

function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try { out = turf.union(out, features[i]) || out; }
    catch {
      out = turf.combine(turf.featureCollection([out, features[i]])).features[0];
    }
  }
  return out;
}

// Core stitcher ---------------------------------------------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100; // HERE distance ceiling per call
  const stepMeters = Math.round(STEP_KM * 1000);
  const iters = Math.max(1, Math.ceil(targetKm / STEP_KM));

  let seeds = [{ lat, lng }];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < iters; ring++) {
    const jobs = seeds.map(s => limit(() => fetchIsoline(s.lat, s.lng, stepMeters)));
    const results = await Promise.allSettled(jobs);

    const feats = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        const features = herePolyToFeatures(r.value.isolines[0]);
        feats.push(...features);
      }
    }
    if (!feats.length) throw new Error('No polygons from HERE at this ring');

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);

    // keep geometry manageable as it grows
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

    // new seeds along boundary
    const boundarySeeds = sampleBoundary(merged, 80);
    const seen = new Set(); const nextSeeds = [];
    for (const p of boundarySeeds) {
      const k = `${Math.round(p.lat*100)/100}_${Math.round(p.lng*100)/100}`;
      if (!seen.has(k)) { seen.add(k); nextSeeds.push(p); }
    }
    seeds = nextSeeds;
  }

  // smooth corners and final simplify
  let smooth = merged;
  try {
    smooth = turf.buffer(smooth, 3, { units: 'kilometers' });
    smooth = turf.buffer(smooth, -3, { units: 'kilometers' });
  } catch {}
  smooth = turf.simplify(smooth, { tolerance: 0.01, highQuality: true });

  return smooth;
}

// API -------------------------------------------------------------
app.get('/range', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!HERE_KEY) throw new Error('Missing HERE_API_KEY');
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(miles)) {
      return res.status(400).json({ error: 'lat,lng,miles required' });
    }

    // cache lookup
    const key = cacheKey(lat, lng, miles);
    const hit = cache.get(key);
    if (hit) return res.json({ cached: true, geojson: hit });

    // protect quotas a little
    const safeMiles = Math.min(miles, 450);

    const t0 = Date.now();
    const feature = await computeStitchedPolygon(lat, lng, safeMiles);
    const ms = Date.now() - t0;

    cache.set(key, feature, 60 * 60 * 24); // 24h TTL
    res.json({ cached: false, ms, geojson: feature });
  } catch (e) {
    console.error('ERROR /range', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/health', (_, res) => res.send('ok'));

app.listen(PORT, () => console.log('Server on :' + PORT));
