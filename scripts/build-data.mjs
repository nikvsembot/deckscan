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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DIM, GW, GH } from '../lib/fp.js';
import { setFixture, getJSON, readJSON, log, buildFingerprints, buildIndex, selfTest, writeIndex, experiment, boxWeights } from './shared.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, '.cache');
const IMG_CACHE = path.join(CACHE_DIR, 'img');
const FIXTURE = process.env.DECKSCAN_FIXTURE ? path.resolve(process.env.DECKSCAN_FIXTURE) : null;
const ARGS = new Set(process.argv.slice(2));
const SELFTEST_ROUNDS = ARGS.has('--no-selftest') ? 0 : Number(process.env.SELFTEST_ROUNDS || 2);
// recognition tuning (see EXPERIMENT): blur references like a camera would; penalise "magnet" cards
const REF_BLUR = Number(process.env.CP_REF_BLUR ?? 0);
const HUB_LAMBDA = Number(process.env.CP_HUB_LAMBDA ?? 0);
const ART_FOCUS = process.env.CP_ART === '1';            // weight the artwork box more than frame/text
const TOPK = Number(process.env.CP_TOPK ?? 24);           // candidate cards compared in detail
const AUG = Number(process.env.CP_AUG ?? 0);             // simulated camera shots averaged into each reference
const ART_BOX = { x0: 0.03, x1: 0.97, y0: 0.0, y1: 0.62 };
const EXPERIMENT = !!process.env.EXPERIMENT;

const API = 'https://api.netdeck.gg/api/cards/cyberpunk';
const CM_GAME = 23; // Cyberpunk on Cardmarket's price guide page
const CM_PRICE_URL = `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_${CM_GAME}.json`;
const CM_PRODUCTS_URL = `https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_${CM_GAME}.json`;

// Cardmarket expansion id -> card database set code(s). Unknown expansions are auto-mapped by name overlap.
const CM_EXPANSIONS = {
  6714: ['welcometonightcitybeta'], 6761: ['welcometonightcityretail'],
  6717: ['boxtoppersbeta'], 6764: ['boxtoppersretail'],
  6716: ['embracingpowerbetastarterdeck'], 6763: ['embracingpowerretailstarterdeck'],
  6715: ['theheistbetastarterdeck'], 6762: ['theheistretailstarterdeck'],
  6718: ['prereleasebeta'], 6765: ['prereleaseretail'],
  6719: ['PRM01'], 6952: ['judgepromos'],
  6953: ['nightcitybrawls1'], 6954: ['nightcityshowdowns1'], 6955: ['edgerunneropens1'],
  6721: ['arasakademodeck'], 6720: ['mercdemodeck'],   // "Embracing Power / The Heist - Demo Deck" (14 / 15 cards)
};
// Known-good pairs used as a self-check of the version matching.
const CHECKS = [{ card: 'v-streetkid', set: 'welcometonightcitybeta', no: 'β005b', idProduct: 905093 }];

const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
setFixture(FIXTURE);

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
  const cards = [], printings = [], sets = {}, imgUrl = new Map(), texts = {};
  // Rules text, for the Claude deck advisor: any text-like string field the API has.
  const fieldSet = new Set(items.slice(0, 200).flatMap(c => Object.keys(c)));
  log('card API fields: ' + [...fieldSet].join(', '));
  const str = x => (typeof x === 'string' ? x : Array.isArray(x) ? x.map(y => (typeof y === 'string' ? y : y?.name || y?.text || '')).filter(Boolean).join(', ') : '');
  for (const c of items) {
    const rules = str(c.official_rules_text_en) || str(c.rules_text) || str(c.official_rules_text) || str(c.printed_rules_text);
    const kw = str(c.keywords);
    const t = [kw && `Keywords: ${kw}`, rules].filter(Boolean).join('\n');
    if (t) texts[c.slug] = t;
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
  return { cards, printings, sets, imgUrl, texts };
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
    // Cardmarket adds a card's versions in collector-number order, so product ids ascend with collector numbers
    // (verified: V — Streetkid β005a/β005b/β144 = 905092/905093/905232). Prices can't be used to order them:
    // brand-new versions often have no trend yet.
    pr.forEach((p, i) => { const q = qs[Math.min(i, qs.length - 1)]; if (q) assign.set(p.id, q.idProduct); });
  }

  // diagnostics for checking how Cardmarket orders versions of one card
  const expStats = [...prodByExp].map(([exp, prods]) => ({ exp, products: prods.length, sets: expMap.get(exp) || null,
    matched: prods.filter(q => [...assign.values()].includes(q.idProduct)).length, sample: prods.slice(0, 2).map(q => q.name) }));
  const versionGroups = [];
  for (const [k, P] of pGroups) {
    const Q = qGroups.get(k);
    if (!Q || (P.length < 2 && Q.length < 2)) continue;
    versionGroups.push({ key: k,
      printings: [...P].sort((a, b) => collectorKey(a.no) - collectorKey(b.no)).map(p => [p.no, p.r, assign.get(p.id) || null]),
      products: [...Q].sort((a, b) => a.idProduct - b.idProduct).map(q => [q.idProduct, q.dateAdded, trendOf(priceById.get(q.idProduct)), q.idMetacard]) });
  }
  const r2 = x => (x == null || Number.isNaN(x) || x <= 0 ? null : Math.round(x * 100) / 100); // 0 = no price yet
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
    report: { checks, autoMapped, unknownExp, expStats, mismatches: mismatches.slice(0, 40), unmatchedCount: unmatched.length, unmatched: unmatched.slice(0, 60) },
    debug: { versionGroups },
  };
}

const SET_PRIORITY = ['welcometonightcityretail', 'welcometonightcitybeta', 'theheistretailstarterdeck', 'embracingpowerretailstarterdeck',
  'theheistbetastarterdeck', 'embracingpowerbetastarterdeck', 'boxtoppersretail', 'boxtoppersbeta', 'prereleaseretail', 'prereleasebeta'];

// ---------- main ----------
async function main() {
  await fs.mkdir(DATA, { recursive: true });
  const t0 = Date.now();
  const { cards, printings, sets, imgUrl, texts } = await loadCards();

  let cm = null;
  try { cm = await loadCardmarket(cards, printings); }
  catch (e) { log('Cardmarket download failed, keeping previous prices:', e.message); }

  const fp = await buildFingerprints(printings, imgUrl, SELFTEST_ROUNDS > 0 || EXPERIMENT, { cacheFile: path.join(CACHE_DIR, 'fp-cache.json'), imgDir: IMG_CACHE, refBlur: REF_BLUR,
    weights: ART_FOCUS ? boxWeights(ART_BOX) : null, weightsId: ART_FOCUS ? 'art' : '', aug: AUG });
  const index = buildIndex(printings, fp.cache);
  index.weights = ART_FOCUS ? boxWeights(ART_BOX) : null;
  const prevMeta = await readJSON(path.join(DATA, 'meta.json'), {});
  const st = SELFTEST_ROUNDS > 0 ? await selfTest(index, fp.images, SELFTEST_ROUNDS, { lambda: HUB_LAMBDA, weights: index.weights, topK: TOPK }) : prevMeta.selftest || null;
  const exp = EXPERIMENT ? await experiment(printings.filter(p => fp.images.has(p.id)), fp.images, 2, [
    { blur: 2, lambda: 0.25 },
    { blur: 2, lambda: 0.25, topK: 64 },
    { blur: 2, lambda: 0.25, art: true },
    { blur: 2, lambda: 0.25, art: true, topK: 64 },
    { blur: 1, lambda: 0.25, aug: 3 },
    { blur: 1, lambda: 0.25, aug: 3, topK: 64 },
    { blur: 1, lambda: 0.25, aug: 3, art: true, topK: 64 },
  ], ART_BOX) : null;

  const setOrder = Object.keys(sets).sort((a, b) => {
    const ia = SET_PRIORITY.indexOf(a), ib = SET_PRIORITY.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const cardsOut = { updatedAt: new Date().toISOString(), source: 'cyberpunktcg.com card database', sets, setOrder, cards, printings };
  await fs.writeFile(path.join(DATA, 'cards.json'), JSON.stringify(cardsOut));
  await fs.writeFile(path.join(DATA, 'cards-text.json'), JSON.stringify(texts));   // rules text, for the Claude deck advisor
  if (cm) await fs.writeFile(path.join(DATA, 'prices.json'), JSON.stringify(cm.prices));
  if (cm) await fs.writeFile(path.join(DATA, 'cm-debug.json'), JSON.stringify(cm.debug, null, 1));
  await writeIndex(DATA, index, st);
  await fs.writeFile(path.join(DATA, 'meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    cards: cards.length, printings: printings.length, fingerprints: index.list.length, artGroups: index.nGroups,
    imageFailures: fp.failed.slice(0, 20), lowContrastSkipped: index.lowContrast, cardmarket: cm ? cm.report : prevMeta.cardmarket || null, selftest: st,
    tuning: { refBlur: REF_BLUR, hubLambda: HUB_LAMBDA, artFocus: ART_FOCUS, topK: TOPK, aug: AUG }, experiment: exp,
  }, null, 1));
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
  if (cm && cm.report.checks.some(c => !c.ok)) log('WARNING: a Cardmarket version check failed; see data/meta.json');
}

main().catch(e => { console.error(e); process.exit(1); });
