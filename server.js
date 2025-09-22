console.log('[STARTUP] ===== SERVER.JS LOADING =====');

import 'dotenv/config';
import express from 'express';
import { fetch } from 'undici';
import * as dns from 'node:dns/promises';
import * as turf from '@turf/turf';
import pLimit from 'p-limit';
import NodeCache from 'node-cache';

console.log('[STARTUP] All imports successful');

const app = express();
const PORT = process.env.PORT || 3000;
const HERE_KEY = process.env.HERE_API_KEY || '';
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 12);
const DEBUG = process.env.DEBUG === '1';

console.log('[STARTUP] Environment loaded, PORT:', PORT);

function log(...args){ if (DEBUG) console.log(...args); }

// CORS
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const cache = new NodeCache({ stdTTL: 24*3600, useClones: false });

// ----------------- helpers -----------------
function maskKey(k){ if (!k) return '(empty)'; if (k.length <= 6) return '***'; return k.slice(0,3) + '…' + k.slice(-3); }
function hereHost(){ return 'isoline.router.hereapi.com'; }

async function safeFetch(url, opts={}) {
  try {
    const res = await fetch(url, { ...opts });
    return res;
  } catch (err) {
    const cause = err?.cause || err;
    const code = cause?.code || cause?.errno || 'unknown';
    const msg = err?.message || String(err);
    log('[safeFetch] ERROR', { url: String(url), code, msg });
    throw Object.assign(new Error('fetch failed'), { code, msg });
  }
}

async function fetchIsoline(lat, lng, meters) {
  if (!HERE_KEY) throw new Error('Missing HERE_API_KEY');

  const u = new URL(`https://${hereHost()}/v8/isolines`);
  u.searchParams.set('apiKey', HERE_KEY);
  u.searchParams.set('origin', `${lat},${lng}`);
  u.searchParams.set('range[values]', String(meters));
  u.searchParams.set('range[type]', 'distance');
  u.searchParams.set('transportMode', 'car');

  const res = await safeFetch(u, { method:'GET' });
  const text = await res.text();

  if (!res.ok) {
    log('[HERE non-200]', res.status, text.slice(0,300));
    throw new Error(`HERE ${res.status}: ${text.slice(0,200)}`);
  }

  let data;
  try { data = JSON.parse(text); }
  catch {
    log('[HERE JSON parse failed]', text.slice(0,300));
    throw new Error('HERE JSON parse failed');
  }

  if (!data || typeof data !== 'object') throw new Error('Bad HERE payload');
  if (!Array.isArray(data.isolines)) {
    const notices = data.notices ? JSON.stringify(data.notices) : '[]';
    throw new Error(`No isolines returned notices=${notices}`);
  }
  return data;
}

function decodeFPL(str) {
  let idx = 0;

  function readVarUInt() {
    let result = 0;
    let shift = 0;
    let b;
    
    do {
      if (idx >= str.length) {
        throw new Error(`FPL truncated at index ${idx}`);
      }
      b = str.charCodeAt(idx++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    
    return result;
  }

  function readVarInt() {
    const u = readVarUInt();
    return (u & 1) ? -(u >> 1) - 1 : (u >> 1);
  }

  // Read header
  if (!str || str.length === 0) throw new Error('Empty FPL string');
  
  const header = str.charCodeAt(idx++) - 63;
  const precision = readVarUInt();
  const thirdDim = readVarUInt();
  const thirdDimPrecision = readVarUInt();

  const factor = Math.pow(10, precision);
  const thirdFactor = Math.pow(10, thirdDimPrecision);

  let lat = 0;
  let lng = 0;
  let z = 0;
  const coords = [];

  while (idx < str.length) {
    lat += readVarInt();
    lng += readVarInt();
    
    if (thirdDim) {
      z += readVarInt();
    }

    coords.push([lat / factor, lng / factor]);
  }

  return coords;
}

function extractPolys(payload) {
  const iso = payload.isolines?.[0];
  if (!iso) return [];
  const polys = Array.isArray(iso.polygons) ? iso.polygons : [];
  const out = [];

  for (const p of polys) {
    const outer = p?.outer;
    if (!outer) continue;

    if (typeof outer === 'string') {
      try {
        const coordsLatLng = decodeFPL(outer);
        const ring = coordsLatLng
          .map(([la, lo]) => [Number(lo), Number(la)])
          .filter(([x,y]) => Number.isFinite(x) && Number.isFinite(y));
        if (ring.length >= 4) {
          const [fx,fy] = ring[0]; const [lx,ly] = ring[ring.length-1];
          if (fx !== lx || fy !== ly) ring.push([fx,fy]);
          out.push(turf.polygon([ring]));
        }
        continue;
      } catch (e) {
        log('[FPL decode failed]', e.message || e);
        // Don't throw, just skip this polygon
        continue;
      }
    }

    if (Array.isArray(outer)) {
      if (!outer.length) continue;
      let ring;
      if (Array.isArray(outer[0])) {
        ring = outer.map(([x,y]) => [Number(x), Number(y)]);
      } else if (typeof outer[0] === 'object' && (('lat' in outer[0]) || ('lng' in outer[0]))) {
        ring = outer.map(pt => [Number(pt.lng), Number(pt.lat)]);
      }
      if (ring && ring.length >= 4) {
        const [fx,fy] = ring[0]; const [lx,ly] = ring[ring.length-1];
        if (fx !== lx || fy !== ly) ring.push([fx,fy]);
        out.push(turf.polygon([ring]));
      }
    }
  }
  return out;
}

function unionAll(features) {
  if (!features.length) return null;
  let out = features[0];
  for (let i=1;i<features.length;i++){
    try { const u = turf.union(out, features[i]); if (u) out = u; }
    catch { out = turf.combine(turf.featureCollection([out, features[i]])).features[0]; }
  }
  return out;
}

function sampleBoundary(feature, n=60) {
  const line = turf.polygonToLine(feature);
  const len = turf.length(line, { units:'kilometers' });
  const step = len / n;
  const pts = [];
  for (let i=0;i<n;i++){
    const p = turf.along(line, i*step, { units:'kilometers' });
    const [x,y] = p.geometry.coordinates;
    pts.push({ lat: y, lng: x });
  }
  return pts;
}

async function computeStitchedPolygon(lat, lng, miles) {
  const metersPerStep = 100_000;
  const targetMeters = Math.min(Math.max(miles, 1), 450) * 1609.34;
  const rings = Math.max(1, Math.ceil(targetMeters / metersPerStep));

  const r0 = await fetchIsoline(lat, lng, metersPerStep);
  const base = extractPolys(r0);
  if (!base.length) throw new Error('No polygons from HERE at ring 0');
  let merged = unionAll(base);
  merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });

  if (rings === 1) return merged;

  const limit = pLimit(MAX_CONCURRENCY);
  let seeds = sampleBoundary(merged, 60);

  for (let ring=1; ring<rings; ring++){
    const jobs = seeds.map(s => limit(() => fetchIsoline(s.lat, s.lng, metersPerStep)
      .then(extractPolys)
      .catch(e => { log(`[ring${ring}] seed failed`, s, e.message || e); return []; })
    ));
    const batches = await Promise.all(jobs);
    const feats = batches.flat().filter(Boolean);
    if (!feats.length) {
      log(`[WARNING] No polygons from HERE at ring ${ring}, continuing anyway`);
      continue; // Continue instead of throwing
    }

    merged = unionAll([merged, ...feats].filter(Boolean));
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });
    seeds = sampleBoundary(merged, 60);
  }

  try {
    merged = turf.buffer(merged, 2, { units:'kilometers' });
    merged = turf.buffer(merged, -2, { units:'kilometers' });
    merged = turf.simplify(merged, { tolerance: 0.01, highQuality: true });
  } catch {}

  return merged;
}

console.log('[STARTUP] All functions defined');

// ----------------- DIAGNOSTICS -----------------
app.get('/diag/env', (req,res)=>{
  res.json({
    node: process.version,
    hereKeyPresent: Boolean(HERE_KEY),
    hereKeyMasked: maskKey(HERE_KEY),
  });
});

app.get('/diag/dns', async (req,res)=>{
  try {
    const a4 = await dns.lookup(hereHost(), { family: 4 });
    let a6 = null;
    try { a6 = await dns.lookup(hereHost(), { family: 6 }); } catch {}
    res.json({ host: hereHost(), ipv4: a4, ipv6: a6 });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/diag/ping', async (req,res)=>{
  try {
    const r = await safeFetch('https://www.google.com', { method:'GET' });
    res.json({ status: r.status });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e), code: e.code || null });
  }
});

app.get('/diag/ip', async (req,res)=>{
  try {
    const r = await safeFetch('https://api.ipify.org?format=json');
    res.json({ status:r.status, ip: await r.json() });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e), code: e.code || null });
  }
});

app.get('/diag/here', async (req,res)=>{
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const meters = Number(req.query.meters || 100000);
    if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: 'lat,lng required' });

    const data = await fetchIsoline(lat, lng, meters);
    res.json({
      keys: Object.keys(data),
      sample: { range: data.isolines?.[0]?.range, polygonsCount: data.isolines?.[0]?.polygons?.length || 0 }
    });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/diag/raw-here', async (req,res)=>{
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const meters = Number(req.query.meters || 100000);
    const u = new URL(`https://${hereHost()}/v8/isolines`);
    u.searchParams.set('apiKey', HERE_KEY);
    u.searchParams.set('origin', `${lat},${lng}`);
    u.searchParams.set('range[values]', String(meters));
    u.searchParams.set('range[type]', 'distance');
    u.searchParams.set('transportMode', 'car');

    const r = await safeFetch(u);
    const txt = await r.text();
    res.status(r.status).send(txt);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e), code: e.code || null });
  }
});

// Test FPL decoder
app.get('/diag/decode', (req,res)=>{
  const sample = "BG-m3ztC5i8kvE2uV001B-rgC2uV4vhIA-rgC1uVo9qBn9qBq9qBAy61Cy61C2uV-rgC1uV-rgCn9qBq9qB1uV8rgC2uV-rgCo9qBAq9qBn9qBq9qBA83gE83gEo9qBAq9qBp9qB-rgCzuV";
  try {
    const coords = decodeFPL(sample);
    res.json({ success: true, coordCount: coords.length, sample: coords.slice(0,5) });
  } catch (e) {
    res.status(500).json({ 
      error: e.message || String(e),
      sampleLength: sample.length,
      sampleChars: sample.split('').map((c,i) => ({ i, c, code: c.charCodeAt(0) })).slice(140, 150)
    });
  }
});

// ----------------- API -----------------
app.get('/range', async (req,res)=>{
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const miles = Number(req.query.miles);
    if (!isFinite(lat) || !isFinite(lng) || !isFinite(miles)) return res.status(400).json({ error:'lat,lng,miles required' });

    const key = `${lat.toFixed(3)},${lng.toFixed(3)}:${Math.round(miles)}`;
    const hit = cache.get(key);
    if (hit) return res.json({ cached:true, geojson: hit });

    const feat = await computeStitchedPolygon(lat, lng, miles);
    cache.set(key, feat);
    res.json({ cached:false, geojson: feat });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get('/health', (_,res)=> res.send('ok'));

console.log('[STARTUP] About to start server on port', PORT);
app.listen(PORT, () => console.log('[STARTUP] Server running on :' + PORT));
