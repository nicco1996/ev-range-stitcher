import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 16);
const DEBUG = process.env.DEBUG === '1';

// --------------------- CORS ---------------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// --------------------- Cache --------------------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// -------- Flexible Polyline decode (no deps) ----
const DECODING_TABLE = (() => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const map = new Map();
  for (let i = 0; i < chars.length; i++) map.set(chars[i], i);
  return map;
})();

function decodeUnsignedValue(str, idxObj) {
  let result = 0;
  let shift = 0;
  let value;
  while (true) {
    const c = str[idxObj.i++];
    if (c === undefined) throw new Error('Unexpected EoS while decoding');
    const d = DECODING_TABLE.get(c);
    if (d === undefined) throw new Error(`Bad char '${c}' in flex polyline`);
    value = d & 0x1f;
    result |= (value << shift);
    if ((d & 0x20) === 0) break;
    shift += 5;
  }
  return result;
}
function toSigned(val) { return (val & 1) ? ~(val >> 1) : (val >> 1); }

/**
 * Returns array of [lng, lat] pairs.
 */
function decodeFlexiblePolyline(str) {
  const idx = { i: 0 };
  const version = decodeUnsignedValue(str, idx);           // should be 1
  const header  = decodeUnsignedValue(str, idx);

  const precision = header & 15;
  const thirdDim  = (header >> 4) & 7;      // 0 = none
  const thirdPrec = (header >> 7) & 15;

  const scale = Math.pow(10, precision);
  const scaleZ = Math.pow(10, thirdPrec);

  let lastLat = 0, lastLng = 0, lastZ = 0;
  const coords = [];

  while (idx.i < str.length) {
    lastLat += toSigned(decodeUnsignedValue(str, idx));
    lastLng += toSigned(decodeUnsignedValue(str, idx));
    let z = null;
    if (thirdDim !== 0) { lastZ += toSigned(decodeUnsignedValue(str, idx)); z = lastZ / scaleZ; }
    const lat = lastLat / scale;
    const lng = lastLng / scale;
    coords.push([lng, lat]); // GeoJSON order
  }
  return coords;
}

// -------------- Helpers -------------------------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles) { return `${snap(lat)},${snap(lng)}:${Math.round(miles)}`; }

function herePolyToFeatures(isoline) {
  const polys = Array.isArray(isoline?.polygons) ? isoline.polygons : [];
  const feats = [];

  for (const p of polys) {
    let ring = [];
    const outer = p.outer;

    if (typeof outer === 'string') {
      // Flexible polyline
      ring = decodeFlexiblePolyline(outer);
    } else if (Array.isArray(outer)) {
      // [{lat,lng}] or [[lng,lat]]
      if (outer.length && typeof outer[0] === 'object' && ('lat' in outer[0] || 'lng' in outer[0])) {
        ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      } else if (outer.length && Array.isArray(outer[0])) {
        ring = outer.map(pair => [Number(pair[0]), Number(pair[1])]);
      }
    } else if (outer && typeof outer === 'object' && outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      ring = outer.coordinates.map(pair => [Number(pair[0]), Number(pair[1])]);
    }

    if (!ring.length) continue;

    // close ring if needed
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    feats.push(turf.polygon([ring]));
  }

  if (DEBUG) console.log('[EXTRACTOR] features found:', feats.length);
  return feats;
}

async function fetchIsoline(lat, lng, stepMeters) {
  const url = new URL('https://isoline.router.hereapi.com/v8/isolines');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('range[values]', String(stepMeters));
  url.searchParams.set('range[type]', 'distance');
  url.searchParams.set('transportMode', 'car');

  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));

  if (DEBUG) {
    if (!data || typeof data !== 'object') {
      console.log('[HERE] non-JSON response');
    } else {
      const keys = Object.keys(data);
      console.log('[HERE] keys:', keys);
      if (data.isolines?.[0]) {
        console.log('[HERE] isolines[0] keys:', Object.keys(data.isolines[0]));
      }
      if (data.notices) {
        console.log('[HERE notices]', JSON.stringify(data.notices));
      }
    }
  }

  if (!res.ok) {
    throw new Error(`HERE ${res.status}`);
  }

  const isolines = Array.isArray(data?.isolines) ? data.isolines : [];
  if (!isolines.length) {
    const noteTxt = data?.notices ? ` notices=${JSON.stringify(data.notices)}` : '';
    throw new Error(`No isolines returned${noteTxt}`);
  }
  return data;
}

/**
 * Sample the boundary of a Polygon/MultiPolygon uniformly.
 * Handles polygonToLine returning a Feature or a FeatureCollection.
 */
function sampleBoundary(feature, n = 80) {
  const lineFC = turf.polygonToLine(feature);
  const lines = lineFC.type === 'FeatureCollection' ? lineFC.features : [lineFC];

  const lengths = lines.map(l => turf.length(l, { units: 'kilometers' }));
  const total = lengths.reduce((a, b) => a + b, 0);
  if (total === 0) return [];

  const pts = [];
  const step = total / n;

  for (let k = 0; k < n; k++) {
    let target = k * step;
    let idx = 0;
    while (idx < lines.length && target > lengths[idx]) {
      target -= lengths[idx];
      idx++;
    }
    const L = lines[Math.min(idx, lines.length - 1)];
    const p = turf.along(L, Math.max(0, Math.min(target, lengths[Math.min(idx, lengths.length - 1)] - 1e-9)), { units: 'kilometers' });
    const [x, y] = p.geometry.coordinates;
    pts.push({ lat: y, lng: x });
  }
  return pts;
}

function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try {
      const u = turf.union(out, features[i]);
      if (u) out = u;
    } catch {
      const c = turf.combine(turf.featureCollection([out, features[i]]));
      out = c.features[0];
    }
  }
  return out;
}

// --- HERE snap-to-road using Map Matching (robust) ---
async function snapToRoad(lat, lng) {
  const url = new URL('https://match.router.hereapi.com/v8/match');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('mode', 'car');
  url.searchParams.set('attributes', 'streetAttributes,matchType');
  url.searchParams.set('points', `${lat},${lng}`);
  // small radius + confidence
  url.searchParams.set('routemode', 'fast'); // best-effort
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const sec = data?.routes?.[0]?.sections?.[0];
  const p = sec?.spans?.[0]?.offset?.lat && sec?.spans?.[0]?.offset?.lng
    ? { lat: sec.spans[0].offset.lat, lng: sec.spans[0].offset.lng }
    : sec?.departure?.place?.location;
  return (p && isFinite(p.lat) && isFinite(p.lng)) ? p : null;
}

// ------------------ core stitcher -------------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;

  // HERE distance limit ~100 km per call. Use 80 km steps to be safe.
  const STEP_KM = 80;
  const stepMeters = Math.round(STEP_KM * 1000);
  const rings = Math.max(1, Math.ceil(targetKm / STEP_KM));

  // seed 0: snap the origin to road once
  let origin = await snapToRoad(lat, lng);
  if (!origin) origin = { lat, lng };

  let seeds = [origin];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < rings; ring++) {
    // fetch isolines concurrently for all seeds for this ring
    const jobs = seeds.map(s => limit(() => fetchIsoline(s.lat, s.lng, stepMeters).catch(e => e)));
    const results = await Promise.all(jobs);

    const feats = [];
    for (const r of results) {
      if (r instanceof Error) {
        if (DEBUG) console.log('[ring fetch error]', r.message);
        continue;
      }
      const f = herePolyToFeatures(r.isolines[0]); // only first isoline (range[0])
      feats.push(...f);
    }

    if (!feats.length) {
      throw new Error(`No isolines returned at ring ${ring}`);
    }

    // merge this ring into the accumulated hull
    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);

    // simplify a bit for performance
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

    // sample boundary -> seeds for next ring
    const boundarySeeds = sampleBoundary(merged, 48); // keep modest fan-out
    // snap each seed to road; keep only successful snaps
    const snapped = await Promise.all(boundarySeeds.map(p => snapToRoad(p.lat, p.lng)));
    seeds = snapped.filter(Boolean);

    // if snapping failed a lot, fall back to unsnapped seeds to avoid dead-ends
    if (seeds.length < 8) seeds = boundarySeeds;
  }

  // light smoothing
  let smooth = merged;
  try {
    smooth = turf.buffer(smooth, 2, { units: 'kilometers' });
    smooth = turf.buffer(smooth, -2, { units: 'kilometers' });
  } catch {}
  smooth = turf.simplify(smooth, { tolerance: 0.01, highQuality: true });

  return smooth;
}

// ------------------- API routes --------------------
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
    const cached = cache.get(key);
    if (cached) return res.json({ cached: true, geojson: cached });

    const safeMiles = Math.min(miles, 450); // protect quotas
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

app.get('/diag/here', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const meters = Number(req.query.meters || 100000);
    let origin = await snapToRoad(lat, lng);
    if (!origin) origin = { lat, lng };
    const data = await fetchIsoline(origin.lat, origin.lng, meters);
    const sample = data?.isolines?.[0];
    res.json({ snapped: origin, keys: Object.keys(data), sample });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/diag/land', (req, res) => {
  // simple placeholder you used before
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  res.json({ onLand: true, snapped: { lat, lng }, erodeKm: 5 });
});

app.get('/health', (_, res) => res.send('ok'));

app.listen(PORT, () => console.log('Server on :' + PORT));
