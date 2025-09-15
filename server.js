import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import NodeCache from 'node-cache';
import pLimit from 'p-limit';
import * as turf from '@turf/turf';
import { decode as decodeFlexiblePolyline } from '@here/flexible-polyline';

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY;
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 20);
const DEBUG = process.env.DEBUG === '1';

if (!HERE_KEY) {
  console.warn('WARNING: HERE_API_KEY is missing. /range will fail until it is set.');
}

// ------------------------------------------------------------
// small helpers
// ------------------------------------------------------------
function log(...args) {
  if (DEBUG) console.log(...args);
}

function cacheKey(lat, lng, miles) {
  const s = (v, g = 0.1) => Math.round(v / g) * g; // snap so cache reuses nearby points
  return `${s(lat)},${s(lng)}:${Math.round(miles)}`;
}

const cache = new NodeCache({ stdTTL: 60 * 60 * 24, useClones: false }); // 24h cache

// ------------------------------------------------------------
// decode HERE isoline polygons -> GeoJSON Features
// ------------------------------------------------------------
function herePolyToFeatures(isoline) {
  const polys = Array.isArray(isoline?.polygons) ? isoline.polygons : [];
  const feats = [];

  for (const p of polys) {
    const outer = p?.outer;
    let ring = [];

    // A) HERE flexible polyline string (most common)
    if (typeof outer === 'string') {
      try {
        const pts = decodeFlexiblePolyline(outer); // usually returns [{lat, lng}, ...]
        if (Array.isArray(pts) && pts.length) {
          const first = pts[0];
          if (Array.isArray(first) && first.length >= 2) {
            // shape: [[lat, lng], ...]
            ring = pts.map(([lat, lng]) => [Number(lng), Number(lat)]);
          } else if (first && typeof first === 'object') {
            // shape: [{lat, lng}, ...]
            ring = pts.map((pt) => [Number(pt.lng), Number(pt.lat)]);
          }
        }
      } catch (e) {
        log('[DECODE FAIL]', e?.message);
      }
    }

    // B) Fallbacks (if HERE ever returns coordinates directly)
    if (!ring.length && outer && typeof outer === 'object') {
      if (outer.type === 'LineString' && Array.isArray(outer.coordinates)) {
        ring = outer.coordinates.map(([x, y]) => [Number(x), Number(y)]);
      } else if (Array.isArray(outer) && outer.length) {
        const first = outer[0];
        if (Array.isArray(first)) {
          ring = outer.map(([x, y]) => [Number(x), Number(y)]);
        } else if (first && typeof first === 'object') {
          ring = outer.map((pt) => [Number(pt.lng), Number(pt.lat)]);
        }
      }
    }

    if (!ring.length) continue;

    // ensure closed ring
    const [fx, fy] = ring[0];
    const [lx, ly] = ring[ring.length - 1];
    if (fx !== lx || fy !== ly) ring.push([fx, fy]);

    feats.push(turf.polygon([ring]));
  }

  log('[EXTRACTOR] features found:', feats.length);
  return feats;
}

// ------------------------------------------------------------
// HERE calls
// ------------------------------------------------------------
async function fetchIsoline(lat, lng, meters) {
  const url = new URL('https://isoline.router.hereapi.com/v8/isolines');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('range[values]', String(meters));
  url.searchParams.set('range[type]', 'distance');
  url.searchParams.set('transportMode', 'car');

  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));

  // Log shape to verify we see polygons
  if (DEBUG) {
    log('[HERE] keys:', Object.keys(json || {}));
    if (json?.isolines?.[0]) {
      log('[HERE] isolines[0] keys:', Object.keys(json.isolines[0]));
    }
  }

  if (!res.ok) {
    const msg = typeof json === 'object' ? JSON.stringify(json) : await res.text();
    throw new Error(`HERE isoline ${res.status}: ${msg}`);
  }
  if (!json?.isolines?.length) {
    // surface notice if present
    const note = json?.notices ? ` notices=${JSON.stringify(json.notices)}` : '';
    throw new Error(`No isolines returned${note}`);
  }
  return json;
}

/**
 * Snap an arbitrary lat,lng to a drivable road using HERE Routing.
 * Strategy: route to a point ~50m north; use the first point of the returned polyline.
 */
async function snapToRoad(lat, lng) {
  const dest = { lat: lat + 0.00045, lng }; // ~50 meters
  const url = new URL('https://router.hereapi.com/v8/routes');
  url.searchParams.set('apiKey', HERE_KEY);
  url.searchParams.set('transportMode', 'car');
  url.searchParams.set('origin', `${lat},${lng}`);
  url.searchParams.set('destination', `${dest.lat},${dest.lng}`);
  url.searchParams.set('return', 'polyline,summary');

  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    log('[SNAP ERR]', j);
    return { lat, lng };
  }
  const sec = j?.routes?.[0]?.sections?.[0];
  const poly = sec?.polyline;
  if (!poly) return { lat, lng };

  try {
    const pts = decodeFlexiblePolyline(poly);
    if (Array.isArray(pts) && pts.length) {
      const p0 = pts[0];
      if (Array.isArray(p0) && p0.length >= 2) {
        return { lat: Number(p0[0]), lng: Number(p0[1]) };
      }
      if (p0 && typeof p0 === 'object') {
        return { lat: Number(p0.lat), lng: Number(p0.lng) };
      }
    }
  } catch (e) {
    log('[SNAP decode fail]', e?.message);
  }
  return { lat, lng };
}

// ------------------------------------------------------------
// geometry utils
// ------------------------------------------------------------
function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i = 1; i < features.length; i++) {
    try {
      const u = turf.union(out, features[i]);
      if (u) out = u;
    } catch {
      // fallback: keep both if union fails
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

// ------------------------------------------------------------
// core stitcher
// ------------------------------------------------------------
async function computeStitchedPolygon(lat, lng, targetMiles) {
  const targetKm = targetMiles * 1.60934;
  const STEP_KM = 100; // HERE distance ceiling per call
  const stepMeters = Math.round(STEP_KM * 1000);
  const iters = Math.max(1, Math.ceil(targetKm / STEP_KM));

  // snap the start to a road — avoids "couldNotMatchOrigin"
  const start = await snapToRoad(lat, lng);
  let seeds = [start];
  let merged = null;

  const limit = pLimit(MAX_CONCURRENCY);

  for (let ring = 0; ring < iters; ring++) {
    // fetch ring polygons around every seed in parallel
    const jobs = seeds.map((s) => limit(() => fetchIsoline(s.lat, s.lng, stepMeters)
      .then((data) => herePolyToFeatures(data.isolines[0]))
      .catch((e) => {
        // if HERE can’t match that seed, just skip it
        log(`[SEED FAIL r${ring}]`, e?.message);
        return [];
      })
    ));

    const results = await Promise.all(jobs);
    const feats = results.flat().filter(Boolean);

    if (feats.length === 0) {
      // If ring 0 fails, it’s always due to decoding or no-road origin; we’ve fixed both above.
      throw new Error(`No polygons from HERE at ring ${ring}`);
    }

    merged = merged ? unionAll([merged, ...feats]) : unionAll(feats);
    // keep geometry manageable
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

    // next seeds: along boundary (dedup to ~2-decimal to keep fan-out sane)
    const boundary = sampleBoundary(merged, 80);
    const seen = new Set();
    const next = [];
    for (const p of boundary) {
      const key = `${Math.round(p.lat * 100) / 100}_${Math.round(p.lng * 100) / 100}`;
      if (!seen.has(key)) { seen.add(key); next.push(p); }
    }
    seeds = next;
  }

  // light smoothing pass to soften jaggies
  try {
    merged = turf.buffer(merged, 2, { units: 'kilometers' });
    merged = turf.buffer(merged, -2, { units: 'kilometers' });
  } catch { /* ignore */ }
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  return merged;
}

// ------------------------------------------------------------
// routes
// ------------------------------------------------------------
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.send('ok'));

// quick diagnostic: show raw HERE response shape at a location
app.get('/diag/here', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const meters = Number(req.query.meters || 100000);
    const snap = await snapToRoad(lat, lng);
    const j = await fetchIsoline(snap.lat, snap.lng, meters);
    res.json({ snapped: snap, keys: Object.keys(j || {}), sample: j?.isolines?.[0] });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get('/range', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(miles)) {
      return res.status(400).json({ error: 'lat,lng,miles required' });
    }

    const key = cacheKey(lat, lng, miles);
    const hit = cache.get(key);
    if (hit) return res.json({ cached: true, geojson: hit });

    // mild guardrail on huge ranges
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
