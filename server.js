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
const DEBUG = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// ---------------- CORS (allow Bubble/frontend) ----------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------- In-memory cache (24h) -----------------------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// ---------------- Minimal HERE Flex-Polyline decoder ----------
/** Spec: https://github.com/heremaps/flexible-polyline
 *  Returns: [ [lat,lng(,z?)], ... ] */
function decodeFlexPolyline(str) {
  let index = 0;

  const decodeUnsignedVarint = () => {
    let result = 0, shift = 0, b;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result;
  };
  const decodeSignedVarint = () => {
    const u = decodeUnsignedVarint();
    return (u & 1) ? ~(u >> 1) : (u >> 1);
  };

  const precision = decodeUnsignedVarint();
  const thirdDim = decodeUnsignedVarint();
  const thirdDimPrecision = decodeUnsignedVarint();

  const factor = Math.pow(10, precision);
  const thirdFactor = Math.pow(10, thirdDimPrecision);
  const hasZ = thirdDim !== 0;

  let lastLat = 0, lastLng = 0, lastZ = 0;
  const coords = [];

  while (index < str.length) {
    lastLat += decodeSignedVarint();
    lastLng += decodeSignedVarint();
    const rec = [lastLat / factor, lastLng / factor];
    if (hasZ) {
      lastZ += decodeSignedVarint();
      rec.push(lastZ / thirdFactor);
    }
    coords.push(rec);
  }
  return coords;
}

// ---------------- Helpers ------------------------------------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

// Walk the whole HERE response and collect any "outer" rings we can decode
function hereResponseToFeatures(data) {
  const features = [];

  function normalizeOuter(outer) {
    // A) Array
    if (Array.isArray(outer)) {
      if (!outer.length) return [];
      // A1) [{lat,lng}, ...]
      if (typeof outer[0] === 'object' && (('lat' in outer[0]) || ('lng' in outer[0]))) {
        return outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
      // A2) [[lng,lat], ...]
      if (Array.isArray(outer[0])) {
        return outer.map(pair => [Number(pair[0]), Number(pair[1])]);
      }
    }

    // B) GeoJSON-like LineString
    if (outer && typeof outer === 'object' && outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      const c = outer.coordinates;
      if (!c.length) return [];
      if (Array.isArray(c[0])) return c.map(pair => [Number(pair[0]), Number(pair[1])]); // [[lng,lat],...]
      if (typeof c[0] === 'object' && (('lat' in c[0]) || ('lng' in c[0]))) {
        return c.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
    }

    // C) HERE flexible polyline (string)
    if (typeof outer === 'string') {
      try {
        const coords = decodeFlexPolyline(outer); // [[lat,lng(,z)], ...]
        return coords.map(([lat, lng]) => [Number(lng), Number(lat)]);
      } catch {
        return [];
      }
    }

    return [];
  }

  function ringToPolygon(ring) {
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);
    return turf.polygon([ring], {});
  }

  // Depth-first search through entire object to find polygons/outer rings
  function dfs(obj) {
    if (!obj || typeof obj !== 'object') return;

    if (Array.isArray(obj.polygons)) {
      for (const poly of obj.polygons) {
        const ring = normalizeOuter(poly?.outer);
        if (ring.length) features.push(ringToPolygon(ring));
      }
    }

    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') dfs(v);
      if (Array.isArray(v)) for (const it of v) dfs(it);
    }
  }

  dfs(data);
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

  if (DEBUG) {
    try {
      console.log('[HERE] keys:', Object.keys(data || {}));
      const iso0 = data?.isolines?.[0] || null;
      if (iso0) console.log('[HERE] isolines[0] keys:', Object.keys(iso0));
    } catch {}
  }

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
      // fallback if union fails (occasionally turf.union throws)
      out = turf.combine(turf.featureCollection([out, features[i]])).features[0];
    }
  }
  return out;
}

// --------------- Core stitcher (rings of ~100 km) ---------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100; // HERE max distance per call
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
        const features = hereResponseToFeatures(r.value);
        feats.push(...features);
      }
    }

    if (!feats.length) {
      if (DEBUG) {
        const firstOk = results.find(r => r.status === 'fulfilled')?.value;
        console.log('[STITCH] Empty feature set; sample HERE payload:',
          JSON.stringify(firstOk)?.slice(0, 1200));
      }
      throw new Error('No polygons from HERE at this ring');
    }

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

// ---------------------- API routes -----------------------------
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

    cache.set(key, feature, 60 * 60 * 24); // 24h
    res.json({ cached: false, ms, geojson: feature });
  } catch (e) {
    console.error('ERROR /range', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/health', (_, res) => res.send('ok'));

app.listen(PORT, () => console.log('Server on :' + PORT));
