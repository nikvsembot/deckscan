// Shared by the per-game data jobs (build-data.mjs = Cyberpunk, build-mtg.mjs = Magic):
// downloading (or reading a test fixture), card-image fingerprints, the artwork index and
// the recognition self-test that calibrates the scanner.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { integral, fingerprint, quantize, center, DIM, GW, GH, Matcher } from '../lib/fp.js';

export const UA = 'deckscan-data-job/1.0 (personal collection app; daily)';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
let PREFIX = '[data]';
export const setLogPrefix = p => { PREFIX = p; };
export const log = (...a) => console.log(PREFIX, ...a);
let FIXTURE = null;
export const setFixture = dir => { FIXTURE = dir ? path.resolve(dir) : null; fixtureMap = null; };

// ---------- fetching (network or fixture) ----------
let fixtureMap = null;
async function fixtureFile(url) {
  if (!fixtureMap) fixtureMap = JSON.parse(await fs.readFile(path.join(FIXTURE, 'urls.json'), 'utf8'));
  const key = url.split('?Expires=')[0];
  const f = fixtureMap[url] || fixtureMap[key];
  if (!f) throw new Error('fixture: no file for ' + url);
  return fs.readFile(path.join(FIXTURE, f));
}
export async function getBuffer(url, tries = 3, accept = '*/*') {
  if (FIXTURE) return fixtureFile(url);
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await sleep(1500 * (t + 1)); }
  }
  throw last;
}
export const getJSON = async url => JSON.parse((await getBuffer(url, 3, 'application/json')).toString('utf8'));
export async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
export async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---------- 3. fingerprints ----------
export const REF_W = 280, REF_H = 392;
export async function refImage(buf) {
  return sharp(buf).flatten({ background: '#161616' }).resize(REF_W, REF_H, { fit: 'fill' }).removeAlpha().png().toBuffer();
}
export async function rawRGBA(pngOrJpg) {
  const { data, info } = await sharp(pngOrJpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/** printings: [{id, c, set, no}] (id = reference id); imgUrl: id -> {url, key}; opts: {cacheFile, imgDir, concurrency, delayMs} */
export async function buildFingerprints(printings, imgUrl, needImages, { cacheFile, imgDir, concurrency = 6, delayMs = 0 }) {
  const cachePath = cacheFile;
  const IMG_CACHE = imgDir;
  const cache = await readJSON(cachePath, {});
  await fs.mkdir(IMG_CACHE, { recursive: true });
  let downloaded = 0, failed = [];
  const images = new Map();
  await pool(printings, concurrency, async p => {
    const src = imgUrl.get(p.id);
    if (!src) return;
    const imgFile = path.join(IMG_CACHE, `${p.id}.png`);
    const cached = cache[p.id] && cache[p.id].k === src.key;
    if (cached && !needImages) return;
    try {
      let png;
      if (existsSync(imgFile) && cached) png = await fs.readFile(imgFile);
      else { png = await refImage(await getBuffer(src.url)); await fs.writeFile(imgFile, png); downloaded++; if (delayMs) await sleep(delayMs); }
      if (!cached) {
        const { data, w, h } = await rawRGBA(png);
        const { v, contrast } = fingerprint(integral(data, w, h), { x: 0, y: 0, w, h });
        const { q, scale } = quantize(v);
        cache[p.id] = { k: src.key, q: Buffer.from(q.buffer).toString('base64'), s: scale, c: +contrast.toFixed(1) };
      }
      if (needImages) images.set(p.id, png);
    } catch (e) { failed.push(`${p.id}: ${e.message}`); }
  });
  // drop cache entries for printings that no longer exist
  const live = new Set(printings.map(p => p.id));
  for (const k of Object.keys(cache)) if (!live.has(k)) delete cache[k];
  await fs.writeFile(cachePath, JSON.stringify(cache));
  log(`fingerprints: ${Object.keys(cache).length} (downloaded ${downloaded}, failed ${failed.length})`);
  return { cache, images, failed };
}

export function buildIndex(printings, cache) {
  // a near-blank render (placeholder art) would match everything weakly, so leave it out
  const lowContrast = printings.filter(p => cache[p.id] && cache[p.id].c != null && cache[p.id].c < 12).map(p => `${p.set} ${p.no} ${p.c} (${cache[p.id].c})`);
  const list = printings.filter(p => cache[p.id] && !(cache[p.id].c != null && cache[p.id].c < 12));
  const N = list.length;
  // raw fingerprints -> catalogue mean -> centred, re-quantised references
  const raw = list.map(p => {
    const q = Buffer.from(cache[p.id].q, 'base64');
    const qi = new Int8Array(q.buffer, q.byteOffset, DIM), s = cache[p.id].s;
    return Float32Array.from(qi, x => x / s);
  });
  const mean = new Float32Array(DIM);
  for (const v of raw) for (let k = 0; k < DIM; k++) mean[k] += v[k] / Math.max(1, N);
  const refs = new Int8Array(N * DIM), scales = new Float32Array(N);
  raw.forEach((v, i) => {
    const { q, scale } = quantize(center(v, mean));
    refs.set(q, i * DIM);
    scales[i] = scale;
  });
  // Group identical artwork (e.g. Beta and Retail prints of the same card) — only within one card.
  const parent = Array.from({ length: N }, (_, i) => i);
  const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byCard = new Map();
  list.forEach((p, i) => { if (!byCard.has(p.c)) byCard.set(p.c, []); byCard.get(p.c).push(i); });
  const sim = (i, j) => { let s = 0; const a = i * DIM, b = j * DIM; for (let k = 0; k < DIM; k++) s += refs[a + k] * refs[b + k]; return s / (scales[i] * scales[j]); };
  for (const idx of byCard.values()) for (let x = 0; x < idx.length; x++) for (let y = x + 1; y < idx.length; y++) {
    if (sim(idx[x], idx[y]) >= 0.9) parent[find(idx[x])] = find(idx[y]);
  }
  const gid = new Map(); const groups = new Int32Array(N);
  for (let i = 0; i < N; i++) { const r = find(i); if (!gid.has(r)) gid.set(r, gid.size); groups[i] = gid.get(r); }
  return { list, refs, scales, groups, nGroups: gid.size, mean, lowContrast };
}

// ---------- 4. self-test on simulated camera shots ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const OUT_W = 240, OUT_H = 336;

async function simulateShot(png, R) {
  const s = 0.86 + R() * 0.14;                  // card fills 86–100% of the guide
  const cw = Math.round(OUT_W * s), ch = Math.round(OUT_H * s);
  const angle = (R() - 0.5) * 7;                // ±3.5°
  const bgs = [[40, 30, 25], [20, 20, 22], [90, 70, 50], [200, 200, 195], [60, 80, 90]];
  const bg = bgs[Math.floor(R() * bgs.length)];
  const background = { r: bg[0], g: bg[1], b: bg[2], alpha: 1 };
  const card = await sharp(png).resize(cw, ch, { fit: 'fill' }).rotate(angle, { background }).png().toBuffer();
  const meta = await sharp(card).metadata();
  const PAD = 80, CW = OUT_W + PAD * 2, CH = OUT_H + PAD * 2;
  const left = Math.round(PAD + (OUT_W - meta.width) / 2 + (R() - 0.5) * 0.07 * OUT_W);
  const top = Math.round(PAD + (OUT_H - meta.height) / 2 + (R() - 0.5) * 0.06 * OUT_H);
  const gx = Math.round(R() * OUT_W), gy = Math.round(R() * OUT_H), gr = Math.round(40 + R() * 90), go = (0.12 + R() * 0.35).toFixed(2);
  const glare = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}"><defs><radialGradient id="g"><stop offset="0" stop-color="#fff" stop-opacity="${go}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><ellipse cx="${gx + PAD}" cy="${gy + PAD}" rx="${gr}" ry="${Math.round(gr * 0.6)}" fill="url(#g)"/></svg>`);
  const tint = [0.85 + R() * 0.3, 0.9 + R() * 0.2, 0.8 + R() * 0.35];
  const composed = await sharp({ create: { width: CW, height: CH, channels: 3, background } })
    .composite([{ input: card, left, top }, { input: glare, left: 0, top: 0 }])
    .png().toBuffer();
  const jpg = await sharp(composed)
    .extract({ left: PAD, top: PAD, width: OUT_W, height: OUT_H })
    .modulate({ brightness: 0.6 + R() * 0.65, saturation: 0.7 + R() * 0.5 })
    .recomb([[tint[0], 0, 0], [0, tint[1], 0], [0, 0, tint[2]]])
    .blur(0.3 + R() * 1.3)
    .jpeg({ quality: Math.round(35 + R() * 35) })
    .toBuffer();
  return rawRGBA(jpg);
}

export const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

export async function selfTest(index, images, rounds) {
  const { list, refs, scales, groups, mean } = index;
  const m = new Matcher(refs, scales, groups, mean);
  const R = rng(12345);
  const correctTop = [], margins = [], wrongTop = [], otherCard = [], fails = [];
  let n = 0, ok = 0;
  for (let i = 0; i < list.length; i++) {
    const png = images.get(list[i].id);
    if (!png) continue;
    for (let t = 0; t < rounds; t++) {
      const { data, w, h } = await simulateShot(png, R);
      const res = m.match(integral(data, w, h), { x: 0, y: 0, w, h }).results;
      n++;
      const top = res[0], second = res[1] || { s: 0 };
      const firstOther = res.find(r => list[r.i].c !== list[i].c);
      if (firstOther) otherCard.push(firstOther.s);
      if (top.g === groups[i]) { ok++; correctTop.push(top.s); margins.push(top.s - second.s); wrongTop.push(second.s); }
      else {
        wrongTop.push(top.s);
        const truth = res.find(r => r.g === groups[i]);
        fails.push(`${list[i].c} ${list[i].set} ${list[i].no} -> ${list[top.i].c} ${list[top.i].no} (${top.s.toFixed(3)} vs ${truth ? truth.s.toFixed(3) : '?'})`);
      }
    }
  }
  const acc = n ? ok / n : null;
  // Accept a match only above almost every wrong best-score, with a clear margin over the runner-up.
  const accept = Math.max(0.42, Math.min(0.62, (pct(otherCard, 0.995) ?? 0.5) + 0.02));
  const margin = Math.max(0.03, Math.min(0.06, (pct(margins, 0.1) ?? 0.05) / 3));
  const stats = {
    shots: n, accuracy: acc && +acc.toFixed(4),
    correctTop: { p5: pct(correctTop, 0.05), p50: pct(correctTop, 0.5) },
    wrongTop: { p50: pct(wrongTop, 0.5), p99: pct(wrongTop, 0.99) },
    otherCard: { p50: pct(otherCard, 0.5), p99: pct(otherCard, 0.99), p995: pct(otherCard, 0.995), max: pct(otherCard, 1) },
    wouldAdd: { correct: correctTop.filter(s => s >= accept).length, wrongCard: 0 },
    margin: { p15: pct(margins, 0.15), p50: pct(margins, 0.5) },
    thresholds: { accept: +accept.toFixed(3), margin: +margin.toFixed(3), release: +(accept * 0.8).toFixed(3) },
    fails: fails.slice(0, 40),
  };
  log(`self-test: ${ok}/${n} correct (${(100 * acc).toFixed(1)}%), thresholds ${JSON.stringify(stats.thresholds)}`);
  return stats;
}


/** Writes fp.bin + fp.json for one game. `refId` maps an index entry to the printing id it stands for. */
export async function writeIndex(dir, index, st, refId = p => p.id) {
  await fs.writeFile(path.join(dir, 'fp.bin'), Buffer.from(index.refs.buffer));
  await fs.writeFile(path.join(dir, 'fp.json'), JSON.stringify({
    dim: DIM, gw: GW, gh: GH, n: index.list.length, groups: index.nGroups,
    ids: index.list.map(refId), scales: [...index.scales].map(x => +x.toFixed(4)), group: [...index.groups],
    mean: [...index.mean].map(x => +x.toFixed(6)),
    thresholds: st ? st.thresholds : { accept: 0.55, margin: 0.05, release: 0.44 },
  }));
}
