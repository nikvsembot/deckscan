#!/usr/bin/env node
// Daily data job (runs on GitHub Actions, or locally against a test fixture).
//  1. Cards + every printing from the official Cyberpunk TCG card database (English only).
//  2. Cardmarket's public daily price guide + product list for Cyberpunk (game 23),
//     matched to printings (set + name, versions ordered by collector number / rarity).
//  3. Scan fingerprints of every printing's card image (cached by image), grouped by artwork.
//  4. A recognition self-test on simulated camera shots, which also calibrates the
//     app's accept thresholds.
// Writes data/cards.json, data/prices.json, data/fp.json, data/fp.bin, data/meta.json.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { integral, fingerprint, quantize, center, DIM, GW, GH, Matcher } from '../lib/fp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');
const IMG_CACHE = path.join(CACHE_DIR, 'img');
const FIXTURE = process.env.DECKSCAN_FIXTURE ? path.resolve(process.env.DECKSCAN_FIXTURE) : null;
const ARGS = new Set(process.argv.slice(2));
const SELFTEST_ROUNDS = ARGS.has('--no-selftest') ? 0 : Number(process.env.SELFTEST_ROUNDS || 2);

const API = 'https://api.netdeck.gg/api/cards/cyberpunk';
const CM_GAME = 23; // Cyberpunk on Cardmarket's price guide page
const CM_PRICE_URL = `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_${CM_GAME}.json`;
const CM_PRODUCTS_URL = `https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_${CM_GAME}.json`;
const UA = 'deckscan-data-job/1.0 (personal collection app; daily)';

// Cardmarket expansion id -> card database set code(s). Unknown expansions are auto-mapped by name overlap.
const CM_EXPANSIONS = {
  6714: ['welcometonightcitybeta'], 6761: ['welcometonightcityretail'],
  6717: ['boxtoppersbeta'], 6764: ['boxtoppersretail'],
  6716: ['embracingpowerbetastarterdeck'], 6763: ['embracingpowerretailstarterdeck'],
  6715: ['theheistbetastarterdeck'], 6762: ['theheistretailstarterdeck'],
  6718: ['prereleasebeta'], 6765: ['prereleaseretail'],
  6719: ['PRM01'], 6952: ['judgepromos'],
  6953: ['nightcitybrawls1'], 6954: ['nightcityshowdowns1'], 6955: ['edgerunneropens1'],
  6722: ['arasakademodeck', 'mercdemodeck'],
};
// Known-good pairs used as a self-check of the version matching.
const CHECKS = [{ card: 'v-streetkid', set: 'welcometonightcitybeta', no: 'β005b', idProduct: 905093 }];

const RARITY_TIER = {
  Common: 0, Uncommon: 1, Rare: 2, Epic: 3, 'Nova Rare': 4,
  Secret: 5, 'Iconic Other': 5, 'Iconic Legend': 5, 'Iconic Secret': 6,
};

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
const log = (...a) => console.log('[data]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- fetching (network or fixture) ----------
let fixtureMap = null;
async function fixtureFile(url) {
  if (!fixtureMap) fixtureMap = JSON.parse(await fs.readFile(path.join(FIXTURE, 'urls.json'), 'utf8'));
  const key = url.split('?Expires=')[0];
  const f = fixtureMap[url] || fixtureMap[key];
  if (!f) throw new Error('fixture: no file for ' + url);
  return fs.readFile(path.join(FIXTURE, f));
}
async function getBuffer(url, tries = 3) {
  if (FIXTURE) return fixtureFile(url);
  let last;
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url.split('?')[0]}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { last = e; await sleep(1500 * (t + 1)); }
  }
  throw last;
}
const getJSON = async url => JSON.parse((await getBuffer(url)).toString('utf8'));
async function readJSON(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

// ---------- 1. cards ----------
function collectorKey(no) {
  const m = String(no).match(/(\d+)([a-z]*)/i);
  return m ? Number(m[1]) * 100 + (m[2] ? m[2].toLowerCase().charCodeAt(0) - 96 : 0) : 99999;
}
const isEnglish = p => (p.language || 'en') === 'en' && !/-fr$/i.test(p.set?.code || '');

async function loadCards() {
  const items = [];
  let total = Infinity;
  for (let off = 0; off < total && off < 5000; off += 100) {
    const j = await getJSON(`${API}?limit=100&offset=${off}`);
    items.push(...j.items);
    total = j.total;
    if (!j.items.length) break;
  }
  const cards = [], printings = [], sets = {}, imgUrl = new Map();
  for (const c of items) {
    cards.push({
      id: c.slug, n: c.name, s: c.subname || '', t: c.card_type, c: c.color,
      cost: c.cost ?? null, pw: c.power ?? null, ram: c.ram ?? null,
      tags: c.classifications || [], eddie: !!c.is_eddiable,
    });
    for (const p of c.printings || []) {
      if (!isEnglish(p)) continue;
      printings.push({ id: p.id, c: c.slug, set: p.set.code, no: p.collector_number, r: p.rarity, a: p.artist || '' });
      sets[p.set.code] = sets[p.set.code] || { name: p.set.name.replace(/\s+—\s+/g, ' – '), n: 0 };
      sets[p.set.code].n++;
      imgUrl.set(p.id, { url: p.image_url, key: (p.source_image_url || p.image_url).split('?')[0].split('/portal/').pop() });
    }
  }
  printings.sort((a, b) => a.c.localeCompare(b.c) || a.set.localeCompare(b.set) || collectorKey(a.no) - collectorKey(b.no));
  log(`cards ${cards.length}, English printings ${printings.length}, sets ${Object.keys(sets).length}`);
  return { cards, printings, sets, imgUrl };
}

// ---------- 2. Cardmarket ----------
async function loadCardmarket(cards, printings) {
  const [pg, pl] = await Promise.all([getJSON(CM_PRICE_URL), getJSON(CM_PRODUCTS_URL)]);
  const priceById = new Map(pg.priceGuides.map(g => [g.idProduct, g]));
  const cardById = new Map(cards.map(c => [c.id, c]));
  const fullName = c => c.s ? `${c.n} ${c.s}` : c.n;

  // printings grouped by set + card name
  const pGroups = new Map();
  for (const p of printings) {
    const k = p.set + '|' + norm(fullName(cardById.get(p.c)));
    if (!pGroups.has(k)) pGroups.set(k, []);
    pGroups.get(k).push(p);
  }
  // expansion mapping, with auto-mapping for expansions we don't know yet
  const expMap = new Map(Object.entries(CM_EXPANSIONS).map(([k, v]) => [Number(k), v]));
  const namesBySet = new Map();
  for (const k of pGroups.keys()) { const [s, n] = k.split('|'); if (!namesBySet.has(s)) namesBySet.set(s, new Set()); namesBySet.get(s).add(n); }
  const mappedSets = new Set([...expMap.values()].flat());
  const prodByExp = new Map();
  for (const p of pl.products) {
    if (!prodByExp.has(p.idExpansion)) prodByExp.set(p.idExpansion, []);
    prodByExp.get(p.idExpansion).push(p);
  }
  const autoMapped = [], unknownExp = [];
  for (const [exp, prods] of prodByExp) {
    if (expMap.has(exp)) continue;
    const names = new Set(prods.map(p => norm(p.name)));
    let best = null;
    for (const [set, setNames] of namesBySet) {
      if (mappedSets.has(set)) continue;
      const overlap = [...names].filter(n => setNames.has(n)).length / Math.max(1, Math.min(names.size, setNames.size));
      if (!best || overlap > best.o) best = { set, o: overlap };
    }
    if (best && best.o >= 0.6) { expMap.set(exp, [best.set]); mappedSets.add(best.set); autoMapped.push({ exp, set: best.set, overlap: +best.o.toFixed(2) }); }
    else unknownExp.push({ exp, products: prods.length, sample: prods.slice(0, 3).map(p => p.name) });
  }

  const qGroups = new Map();
  for (const [exp, prods] of prodByExp) {
    for (const set of expMap.get(exp) || []) {
      for (const p of prods) {
        const k = set + '|' + norm(p.name);
        if (!pGroups.has(k)) continue; // demo-deck expansions hold several of our sets
        if (!qGroups.has(k)) qGroups.set(k, []);
        qGroups.get(k).push(p);
      }
    }
  }

  const trendOf = g => g ? (g.trend ?? g['trend-foil'] ?? g.low ?? null) : null;
  const assign = new Map(); // printing id -> idProduct
  const mismatches = [];
  for (const [k, P] of pGroups) {
    const Q = qGroups.get(k);
    if (!Q) continue;
    const pr = [...P].sort((a, b) => collectorKey(a.no) - collectorKey(b.no));
    const qs = [...Q].sort((a, b) => a.idProduct - b.idProduct);
    if (qs.length === 1) { for (const p of pr) assign.set(p.id, qs[0].idProduct); continue; }
    if (qs.length !== pr.length) mismatches.push({ key: k, printings: pr.map(p => p.no), products: qs.map(q => q.idProduct) });
    const tiers = [...new Set(pr.map(p => RARITY_TIER[p.r] ?? 2))].sort((a, b) => a - b);
    if (tiers.length === 1 || qs.length !== pr.length) {
      pr.forEach((p, i) => { if (qs[Math.min(i, qs.length - 1)]) assign.set(p.id, qs[Math.min(i, qs.length - 1)].idProduct); });
      continue;
    }
    // Several rarity tiers: cheapest products go to the lowest tier, then by product id / collector number.
    const byPrice = [...qs].sort((a, b) => (trendOf(priceById.get(a.idProduct)) ?? 1e9) - (trendOf(priceById.get(b.idProduct)) ?? 1e9) || a.idProduct - b.idProduct);
    let at = 0;
    for (const t of tiers) {
      const tp = pr.filter(p => (RARITY_TIER[p.r] ?? 2) === t);
      const chunk = byPrice.slice(at, at + tp.length).sort((a, b) => a.idProduct - b.idProduct);
      at += tp.length;
      tp.forEach((p, i) => assign.set(p.id, chunk[i].idProduct));
    }
  }

  const r2 = x => (x == null || Number.isNaN(x) ? null : Math.round(x * 100) / 100);
  const out = {};
  for (const p of printings) {
    const id = assign.get(p.id);
    if (!id) continue;
    const g = priceById.get(id) || {};
    out[p.id] = [id, r2(g.trend), r2(g.low), r2(g.avg30), r2(g['trend-foil']), r2(g['low-foil']), r2(g['avg30-foil'])];
  }
  const checks = CHECKS.map(c => {
    const p = printings.find(x => x.c === c.card && x.set === c.set && x.no === c.no);
    return { ...c, got: p ? (out[p.id] || [null])[0] : 'printing missing', ok: p && out[p.id] && out[p.id][0] === c.idProduct };
  });
  const unmatched = printings.filter(p => !out[p.id]).map(p => `${p.set} ${p.no} ${p.c}`);
  log(`Cardmarket: ${pg.priceGuides.length} prices, ${pl.products.length} products, matched ${Object.keys(out).length}/${printings.length} printings`);
  for (const c of checks) log(`check ${c.card} ${c.no}: expected ${c.idProduct}, got ${c.got} -> ${c.ok ? 'OK' : 'FAIL'}`);
  return {
    prices: { updatedAt: pg.createdAt, fetchedAt: new Date().toISOString(), currency: 'EUR', fields: ['idProduct', 'trend', 'low', 'avg30', 'trendFoil', 'lowFoil', 'avg30Foil'], p: out },
    report: { checks, autoMapped, unknownExp, mismatches: mismatches.slice(0, 40), unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 60) },
  };
}

// ---------- 3. fingerprints ----------
const REF_W = 280, REF_H = 392;
async function refImage(buf) {
  return sharp(buf).flatten({ background: '#161616' }).resize(REF_W, REF_H, { fit: 'fill' }).removeAlpha().png().toBuffer();
}
async function rawRGBA(pngOrJpg) {
  const { data, info } = await sharp(pngOrJpg).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

async function buildFingerprints(printings, imgUrl, needImages) {
  const cachePath = path.join(CACHE_DIR, 'fp-cache.json');
  const cache = await readJSON(cachePath, {});
  await fs.mkdir(IMG_CACHE, { recursive: true });
  let downloaded = 0, failed = [];
  const images = new Map();
  await pool(printings, 6, async p => {
    const src = imgUrl.get(p.id);
    if (!src) return;
    const imgFile = path.join(IMG_CACHE, `${p.id}.png`);
    const cached = cache[p.id] && cache[p.id].k === src.key;
    if (cached && !needImages) return;
    try {
      let png;
      if (existsSync(imgFile) && cached) png = await fs.readFile(imgFile);
      else { png = await refImage(await getBuffer(src.url)); await fs.writeFile(imgFile, png); downloaded++; }
      if (!cached) {
        const { data, w, h } = await rawRGBA(png);
        const { v } = fingerprint(integral(data, w, h), { x: 0, y: 0, w, h });
        const { q, scale } = quantize(v);
        cache[p.id] = { k: src.key, q: Buffer.from(q.buffer).toString('base64'), s: scale };
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

const SET_PRIORITY = ['welcometonightcityretail', 'welcometonightcitybeta', 'theheistretailstarterdeck', 'embracingpowerretailstarterdeck',
  'theheistbetastarterdeck', 'embracingpowerbetastarterdeck', 'boxtoppersretail', 'boxtoppersbeta', 'prereleaseretail', 'prereleasebeta'];

function buildIndex(printings, cache) {
  const list = printings.filter(p => cache[p.id]);
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
  return { list, refs, scales, groups, nGroups: gid.size, mean };
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

const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

async function selfTest(index, images, rounds) {
  const { list, refs, scales, groups, mean } = index;
  const m = new Matcher(refs, scales, groups, mean);
  const R = rng(12345);
  const correctTop = [], margins = [], wrongTop = [], fails = [];
  let n = 0, ok = 0;
  for (let i = 0; i < list.length; i++) {
    const png = images.get(list[i].id);
    if (!png) continue;
    for (let t = 0; t < rounds; t++) {
      const { data, w, h } = await simulateShot(png, R);
      const res = m.match(integral(data, w, h), { x: 0, y: 0, w, h }).results;
      n++;
      const top = res[0], second = res[1] || { s: 0 };
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
  const accept = Math.max(0.3, Math.min(pct(wrongTop, 0.99) ?? 0.5, (pct(correctTop, 0.1) ?? 0.6) - 0.02));
  const margin = Math.max(0.02, Math.min(0.08, (pct(margins, 0.15) ?? 0.06)));
  const stats = {
    shots: n, accuracy: acc && +acc.toFixed(4),
    correctTop: { p5: pct(correctTop, 0.05), p50: pct(correctTop, 0.5) },
    wrongTop: { p50: pct(wrongTop, 0.5), p99: pct(wrongTop, 0.99) },
    margin: { p15: pct(margins, 0.15), p50: pct(margins, 0.5) },
    thresholds: { accept: +accept.toFixed(3), margin: +margin.toFixed(3), release: +(accept * 0.8).toFixed(3) },
    fails: fails.slice(0, 40),
  };
  log(`self-test: ${ok}/${n} correct (${(100 * acc).toFixed(1)}%), thresholds ${JSON.stringify(stats.thresholds)}`);
  return stats;
}

// ---------- main ----------
async function main() {
  await fs.mkdir(DATA, { recursive: true });
  const t0 = Date.now();
  const { cards, printings, sets, imgUrl } = await loadCards();

  let cm = null;
  try { cm = await loadCardmarket(cards, printings); }
  catch (e) { log('Cardmarket download failed, keeping previous prices:', e.message); }

  const fp = await buildFingerprints(printings, imgUrl, SELFTEST_ROUNDS > 0);
  const index = buildIndex(printings, fp.cache);
  const prevMeta = await readJSON(path.join(DATA, 'meta.json'), {});
  const st = SELFTEST_ROUNDS > 0 ? await selfTest(index, fp.images, SELFTEST_ROUNDS) : prevMeta.selftest || null;

  const setOrder = Object.keys(sets).sort((a, b) => {
    const ia = SET_PRIORITY.indexOf(a), ib = SET_PRIORITY.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const cardsOut = { updatedAt: new Date().toISOString(), source: 'cyberpunktcg.com card database', sets, setOrder, cards, printings };
  await fs.writeFile(path.join(DATA, 'cards.json'), JSON.stringify(cardsOut));
  if (cm) await fs.writeFile(path.join(DATA, 'prices.json'), JSON.stringify(cm.prices));
  await fs.writeFile(path.join(DATA, 'fp.bin'), Buffer.from(index.refs.buffer));
  await fs.writeFile(path.join(DATA, 'fp.json'), JSON.stringify({
    dim: DIM, gw: GW, gh: GH, n: index.list.length, groups: index.nGroups,
    ids: index.list.map(p => p.id), scales: [...index.scales].map(x => +x.toFixed(4)), group: [...index.groups],
    mean: [...index.mean].map(x => +x.toFixed(6)),
    thresholds: st ? st.thresholds : { accept: 0.55, margin: 0.05, release: 0.44 },
  }));
  await fs.writeFile(path.join(DATA, 'meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    cards: cards.length, printings: printings.length, fingerprints: index.list.length, artGroups: index.nGroups,
    imageFailures: fp.failed.slice(0, 20), cardmarket: cm ? cm.report : prevMeta.cardmarket || null, selftest: st,
  }, null, 1));
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (cm && cm.report.checks.some(c => !c.ok)) log('WARNING: a Cardmarket version check failed; see data/meta.json');
}

main().catch(e => { console.error(e); process.exit(1); });
