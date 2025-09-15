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

// ---------------- CORS ----------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ------------- Cache (24h) ------------
const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false });

// ------------- Logger -----------------
function log(...args) { if (DEBUG) console.log(...args); }

// ------------- Helpers ----------------
function snap(val, gridDeg = 0.1) { return Math.round(val / gridDeg) * gridDeg; }
function cacheKey(lat, lng, miles, mode = 'car') {
  return `${snap(lat)},${snap(lng)}:${Math.round(miles)}:${mode}`;
}

// ======================================================
// Minimal Flexible Polyline decoder (no package needed)
// Returns array of {lat, lng}
// ======================================================
function decodeFlexiblePolyline(str) {
  const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const MAP = {}; for (let i = 0; i < TABLE.length; i++) MAP[TABLE[i]] = i;
  function decodeUnsigned(s) {
    const out = []; let value = 0, shift = 0;
    for (let i = 0; i < s.length; i++) {
      const digit = MAP[s[i]];
      value |= (digit & 0x1f) << shift;
      if ((digit & 0x20) === 0) { out.push(value); value = 0; shift = 0; }
      else { shift += 5; }
    }
    return out;
  }
  function toSigned(v) { return (v & 1) ? ~(v >> 1) : (v >> 1); }
  const vals = decodeUnsigned(str);
  let idx = 0; const precision = vals[idx++]; const factor = Math.pow(10, precision);
  let lat = 0, lng = 0; const coords = [];
  while (idx < vals.length) {
    lat += toSigned(vals[idx++]);
    lng += toSigned(vals[idx++]);
    coords.push({ lat: lat / factor, lng: lng / factor });
  }
  return coords;
}

// ======================================================
// HERE helpers
// ======================================================

// Proper snap-to-road: use the mapped *departure* location from a tiny route.
// That is guaranteed to be on the road network.
async function snapToRoad(lat, lng) {
  const dest = { lat: lat + 0.00045, lng }; // ~50 m north
  const url = new URL('https://router.hereapi.com/v8/routes');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('transportMode', 'car');
  url.searchParams.set('routingMode', 'fast');
  url.searchParams.set('alternatives', '0');
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('destination', `${dest.lat},${dest.lng}`);
  url.searchParams.set('return', 'summary,polyline'); // polyline optional; we only need mapped departure

  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    log('[SNAP ERR]', j);
    return null;
  }
  const sec = j?.routes?.[0]?.sections?.[0];
  const mapped = sec?.departure?.place?.location;
  if (mapped && isFinite(mapped.lat) && isFinite(mapped.lng)) {
    const pt = { lat: Number(mapped.lat), lng: Number(mapped.lng) };
    log('[SNAP OK]', pt);
    return pt;
  }
  // Fallback: first vertex of polyline (not ideal, but better than nothing)
  const poly = sec?.polyline;
  if (poly) {
    try {
      const pts = decodeFlexiblePolyline(poly);
      if (pts.length) {
        const pt = { lat: Number(pts[0].lat), lng: Number(pts[0].lng) };
        log('[SNAP polyline fallback]', pt);
        return pt;
      }
    } catch {}
  }
  log('[SNAP FAIL: no mapped position]');
  return null;
}

// Isoline call
async function fetchIsoline(lat, lng, meters) {
  const url = new URL('https://isoline.router.hereapi.com/v8/isolines');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('transportMode', 'car');
  url.searchParams.set('routingMode', 'fast');
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('range[type]', 'distance');
  url.searchParams.set('range[values]', String(meters));

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = typeof json === 'object' ? JSON.stringify(json) : await res.text();
    throw new Error(`HERE isoline ${res.status}: ${msg}`);
  }
  if (!json?.isolines?.length) {
    const note = json?.notices ? ` notices=${JSON.stringify(json.notices)}` : '';
    throw new Error(`No isolines returned${note}`);
  }
  if (DEBUG) {
    log('[HERE] keys:', Object.keys(json));
    if (json?.isolines?.[0]) log('[HERE] isolines[0] keys:', Object.keys(json.isolines[0]));
  }
  return json;
}

// HERE response -> GeoJSON features (decode polygons[].outer)
function herePolyToFeatures(isoline) {
  const polys = Array.isArray(isoline?.polygons) ? isoline.polygons : [];
  const feats = [];

  for (const p of polys) {
    const outer = p?.outer;
    let ring = [];

    if (typeof outer === 'string') {
      try {
        const pts = decodeFlexiblePolyline(outer);
        ring = pts.map(({ lat, lng }) => [Number(lng), Number(lat)]);
      } catch (e) {
        log('[DECODE FAIL]', e?.message);
      }
    }
    if (!ring.length && outer && typeof outer === 'object' && outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
      ring = outer.coordinates.map(([x, y]) => [Number(x), Number(y)]);
    }
    if (!ring.length && Array.isArray(outer) && outer.length) {
      const first = outer[0];
      if (Array.isArray(first)) ring = outer.map(([x, y]) => [Number(x), Number(y)]);
      else if (first && typeof first === 'object') ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
    }
    if (!ring.length) continue;

    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    feats.push(turf.polygon([ring]));
  }

  log('[EXTRACTOR] features found:', feats.length);
  return feats;
}

// ======================================================
// Robust ring-0: probe + snap each probe to road
// ======================================================
async function getRoutableSeedForRing0(lat, lng, meters) {
  // ~ ±60m and ±120m probes
  const deltas = [0, 0.0006, -0.0006, 0.0012, -0.0012];
  for (const dLat of deltas) {
    for (const dLng of deltas) {
      const probe = { lat: lat + dLat, lng: lng + dLng };
      const snapped = await snapToRoad(probe.lat, probe.lng);
      if (!snapped) continue;
      try {
        const j = await fetchIsoline(snapped.lat, snapped.lng, meters);
        const feats = herePolyToFeatures(j.isolines[0]);
        if (feats.length) {
          if (DEBUG) console.log('[RING0 SEED] using', snapped);
          return { snapped, features: feats };
        }
      } catch (e) {
        if (DEBUG) console.log('[RING0 try fail]', e?.message);
      }
    }
  }
  return null;
}

// ======================================================
// Geometry utils
// ======================================================
function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try {
      const u = turf.union(out, features[i]);
      if (u) out = u;
    } catch {
      out = turf.combine(turf.featureCollection([out, features[i]])).features[0];
    }
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

// ======================================================
// Core stitcher
// ======================================================
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = Math.max(1, targetMiles) * 1.60934;
  const STEP_KM = 100;               // HERE max distance per isoline
  const stepMeters = Math.round(STEP_KM * 1000);
  const iters = Math.max(1, Math.ceil(targetKm / STEP_KM));
  const limit = pLimit(MAX_CONCURRENCY);

  // Ring 0: bootstrap
  const r0 = await getRoutableSeedForRing0(lat, lng, stepMeters);
  if (!r0) throw new Error('No isolines returned at ring 0 after probing nearby points');
  let merged = unionAll(r0.features);
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  // Subsequent rings
  let seeds = [r0.snapped];
  for (let ring = 1; ring < iters; ring++) {
    const boundary = sampleBoundary(merged, 80);

    // snap seeds to road (parallel)
    const snapped = await Promise.allSettled(
      boundary.map(s => limit(() => snapToRoad(s.lat, s.lng)))
    );
    const snapPts = snapped.filter(r => r.status === 'fulfilled' && r.value)
                           .map(r => r.value);

    // fetch isolines (parallel)
    const calls = snapPts.map(s => limit(async () => {
      try {
        const j = await fetchIsoline(s.lat, s.lng, stepMeters);
        return herePolyToFeatures(j.isolines[0]);
      } catch (e) {
        if (DEBUG) console.log(`[SEED FAIL ring ${ring}]`, e?.message);
        return [];
      }
    }));
    const res = await Promise.all(calls);
    const feats = res.flat().filter(Boolean);

    if (!feats.length) throw new Error(`No polygons from HERE at this ring`);

    merged = unionAll([merged, ...feats]);
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

    // prepare next seeds (dedup to ~2 decimals)
    const nb = sampleBoundary(merged, 80);
    const seen = new Set(); const nextSeeds = [];
    for (const p of nb) {
      const k = `${Math.round(p.lat * 100) / 100}_${Math.round(p.lng * 100) / 100}`;
      if (!seen.has(k)) { seen.add(k); nextSeeds.push(p); }
    }
    seeds = nextSeeds;
  }

  // Gentle smoothing
  try {
    merged = turf.buffer(merged, 2, { units: 'kilometers' });
    merged = turf.buffer(merged, -2, { units: 'kilometers' });
  } catch {}
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  return merged;
}

// ======================================================
// Routes
// ======================================================
app.get('/health', (_, res) => res.send('ok'));

app.get('/diag/here', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const meters = Number(req.query.meters || 100000);

    const snapped = await snapToRoad(lat, lng);
    if (!snapped) return res.status(500).json({ error: 'snapToRoad failed' });

    const j = await fetchIsoline(snapped.lat, snapped.lng, meters);
    res.json({
      snapped,
      keys: Object.keys(j || {}),
      sample: j?.isolines?.[0] || null
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/range', async (req, res) => {
  try {
    if (!HERE_KEY) throw new Error('Missing HERE_API_KEY');

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(miles)) {
      return res.status(400).json({ error: 'lat,lng,miles required' });
    }

    const key = cacheKey(lat, lng, miles);
    const hit = cache.get(key);
    if (hit) return res.json({ cached: true, geojson: hit });

    const safeMiles = Math.min(miles, 500);
    const t0 = Date.now();
    const feature = await computeStitchedPolygon(lat, lng, safeMiles);
    const ms = Date.now() - t0;

    cache.set(key, feature);
    res.json({ cached: false, ms, geojson: feature });
  } catch (e) {
    console.error('ERROR /range', e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.listen(PORT, () => console.log('Server listening on :' + PORT));
