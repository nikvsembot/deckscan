#!/usr/bin/env node
// Magic: The Gathering data job — Secrets of Strixhaven (what's in the Bundle's Play Boosters).
//  1. Cards, versions and pictures from Scryfall: SOS main set, SOA Mystical Archive (English),
//     SPG Special Guests released with SOS, and SOS promos (bundle promo, prerelease, …).
//  2. Prices from Cardmarket's Magic price guide (game 1), matched exactly through each
//     Scryfall card's Cardmarket product id; Scryfall's own € price as a fallback.
//  3. Scan fingerprints of every card face + the recognition self-test (shared with Cyberpunk).
// Writes data/mtg/cards.json, prices.json, fp.json, fp.bin, meta.json.
// To add more sets later, extend SETS below.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setFixture, setLogPrefix, getJSON, readJSON, log, sleep, buildFingerprints, buildIndex, selfTest, writeIndex, experiment } from './shared.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'mtg');
const CACHE_DIR = path.join(ROOT, '.cache');
const FIXTURE = process.env.DECKSCAN_MTG_FIXTURE || null;
const SELFTEST_ROUNDS = process.argv.includes('--no-selftest') ? 0 : Number(process.env.SELFTEST_ROUNDS || 2);
// recognition tuning (see EXPERIMENT): blur references like a camera would; penalise "magnet" cards
const REF_BLUR = Number(process.env.MTG_REF_BLUR ?? 0);
const HUB_LAMBDA = Number(process.env.MTG_HUB_LAMBDA ?? 0);
const EXPERIMENT = !!process.env.EXPERIMENT;
setFixture(FIXTURE);
setLogPrefix('[mtg]');

const SCRY = 'https://api.scryfall.com';
const CM_PRICE_URL = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json';
// [Scryfall query, set label]; SPG is a running set, so only the Special Guests released with SOS are kept.
const MAIN_SET = 'sos';
const SETS = [
  ['e:sos', 'sos'],
  ['e:soa', 'soa'],
  ['e:spg', 'spg'],
  ['e:psos', 'psos'],
];
const SET_NAMES = { sos: 'Secrets of Strixhaven', soa: 'Mystical Archive', spg: 'Special Guests', psos: 'SOS Promos' };
const SET_ORDER = ['sos', 'soa', 'spg', 'psos'];

const COLOR = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
const TYPES = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);

async function search(q) {
  const out = [];
  let url = `${SCRY}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=set`;
  while (url) {
    let j;
    try { j = await getJSON(url); }
    catch (e) { if (/HTTP 404|fixture: no file/.test(e.message)) break; throw e; } // no cards for this query (yet)
    out.push(...j.data);
    url = j.has_more ? j.next_page : null;
    await sleep(120); // Scryfall asks for ≤10 requests/second
  }
  return out;
}

function face(c) { return c.card_faces?.[0] || c; }
function mainType(typeLine) {
  const front = String(typeLine || '').split('//')[0];
  return TYPES.find(t => front.includes(t)) || 'Other';
}
function colorName(c) {
  const cols = c.colors ?? face(c).colors ?? [];
  if (!cols.length) return mainType(c.type_line) === 'Land' ? 'Land' : 'Colorless';
  return cols.length > 1 ? 'Multi' : COLOR[cols[0]];
}
function variantLabel(c) {
  const fx = c.frame_effects || [], pt = c.promo_types || [];
  if (pt.includes('bundle')) return 'Bundle promo';
  if (pt.includes('prerelease')) return 'Prerelease';
  if (pt.includes('serialized')) return 'Serialized';
  if (c.border_color === 'borderless') return 'Borderless';
  if (fx.includes('extendedart')) return 'Extended art';
  if (fx.includes('showcase')) return 'Showcase';
  if (c.full_art) return 'Full art';
  if ((c.finishes || []).length === 1 && c.finishes[0] === 'etched') return 'Etched';
  if (pt.length) return cap(pt[0].replace(/([a-z])([A-Z])/g, '$1 $2'));
  return '';
}

async function loadCards() {
  const sos = await getJSON(`${SCRY}/sets/${MAIN_SET}`);
  const raw = [];
  for (const [q, label] of SETS) {
    let list = await search(q);
    if (label === 'spg') list = list.filter(c => c.released_at === sos.released_at);
    list = list.filter(c => (c.lang || 'en') === 'en' && !c.digital);
    log(`${q}: ${list.length} printings`);
    raw.push(...list.map(c => ({ c, label })));
  }
  const cards = new Map(), printings = [], refs = [], imgUrl = new Map();
  for (const { c, label } of raw) {
    const cid = 'mtg:' + (c.oracle_id || face(c).oracle_id || c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    if (!cards.has(cid)) {
      const typeLine = c.type_line || c.card_faces?.map(f => f.type_line).join(' // ') || '';
      cards.set(cid, {
        id: cid, game: 'mtg', n: c.name, s: '', t: mainType(typeLine), c: colorName(c),
        cost: c.cmc ?? null, pw: face(c).power ?? null, tough: face(c).toughness ?? null, ram: null,
        mc: face(c).mana_cost || '', tl: typeLine, ci: c.color_identity || [],
        tags: (typeLine.split('—')[1] || '').split('//')[0].trim().split(/\s+/).filter(Boolean),
        basic: /Basic Land/.test(typeLine),
      });
    }
    const front = c.image_uris || c.card_faces?.[0]?.image_uris;
    const back = !c.image_uris && c.card_faces?.[1]?.image_uris;
    printings.push({
      id: c.id, c: cid, set: label, no: c.collector_number, r: cap(c.rarity), a: c.artist || '',
      v: variantLabel(c), fin: c.finishes || [], img: front?.normal || null, img2: back?.normal || null,
      cm: c.cardmarket_id || null, eur: c.prices?.eur ? +c.prices.eur : null, eurf: c.prices?.eur_foil ? +c.prices.eur_foil : null,
    });
    // one scan reference per printed face (double-faced cards can be scanned either side up)
    if (front?.normal) { refs.push({ id: c.id, pid: c.id, c: cid, set: label, no: c.collector_number }); imgUrl.set(c.id, { url: front.normal, key: front.normal.split('?')[0] }); }
    if (back?.normal) { const rid = c.id + '#b'; refs.push({ id: rid, pid: c.id, c: cid, set: label, no: c.collector_number }); imgUrl.set(rid, { url: back.normal, key: back.normal.split('?')[0] }); }
  }
  const sets = {};
  for (const p of printings) { sets[p.set] = sets[p.set] || { name: SET_NAMES[p.set] || p.set.toUpperCase(), n: 0 }; sets[p.set].n++; }
  log(`cards ${cards.size}, printings ${printings.length}, scan references ${refs.length}`);
  return { cards: [...cards.values()], printings, refs, imgUrl, sets };
}

async function loadPrices(printings) {
  const r2 = x => (x == null || Number.isNaN(x) || x <= 0 ? null : Math.round(x * 100) / 100);
  let pg = null;
  try { pg = await getJSON(CM_PRICE_URL); } catch (e) { log('Cardmarket price guide failed, using Scryfall € prices:', e.message); }
  const wanted = new Set(printings.map(p => p.cm).filter(Boolean));
  const byId = new Map();
  for (const g of pg?.priceGuides || []) if (wanted.has(g.idProduct)) byId.set(g.idProduct, g);
  const out = {};
  let cm = 0, scry = 0, none = 0;
  for (const p of printings) {
    const g = p.cm ? byId.get(p.cm) : null;
    const row = g
      ? [p.cm, r2(g.trend), r2(g.low), r2(g.avg30), r2(g['trend-foil']), r2(g['low-foil']), r2(g['avg30-foil'])]
      : [p.cm, null, null, null, null, null, null];
    // Scryfall's € prices also come from Cardmarket; use them only where the price guide has nothing
    if (row.slice(1).every(x => x == null) && (p.eur || p.eurf)) { row[1] = r2(p.eur); row[4] = r2(p.eurf); scry++; }
    else if (g) cm++;
    if (row.slice(1).some(x => x != null)) out[p.id] = row; else none++;
  }
  log(`prices: ${cm} from Cardmarket price guide, ${scry} from Scryfall, ${none} without a price`);
  return {
    prices: { updatedAt: pg?.createdAt || new Date().toISOString(), fetchedAt: new Date().toISOString(), currency: 'EUR',
      fields: ['idProduct', 'trend', 'low', 'avg30', 'trendFoil', 'lowFoil', 'avg30Foil'], p: out },
    report: { fromCardmarket: cm, fromScryfall: scry, noPrice: none, noCardmarketId: printings.filter(p => !p.cm).map(p => `${p.set} ${p.no}`).slice(0, 40) },
  };
}

async function main() {
  const t0 = Date.now();
  await fs.mkdir(OUT, { recursive: true });
  const { cards, printings, refs, imgUrl, sets } = await loadCards();
  if (!printings.length) throw new Error('Scryfall returned no cards');
  const pr = await loadPrices(printings);
  const fp = await buildFingerprints(refs, imgUrl, SELFTEST_ROUNDS > 0 || EXPERIMENT, {
    cacheFile: path.join(CACHE_DIR, 'mtg-fp-cache.json'), imgDir: path.join(CACHE_DIR, 'mtg-img'), concurrency: 4, delayMs: 60, refBlur: REF_BLUR,
  });
  const index = buildIndex(refs, fp.cache);
  const prevMeta = await readJSON(path.join(OUT, 'meta.json'), {});
  const st = SELFTEST_ROUNDS > 0 ? await selfTest(index, fp.images, SELFTEST_ROUNDS, { lambda: HUB_LAMBDA }) : prevMeta.selftest || null;
  const exp = EXPERIMENT ? await experiment(refs, fp.images, 2) : null;

  // the app doesn't need these per-printing helper fields
  const slim = printings.map(({ eur, eurf, cm, ...p }) => p);
  const setOrder = Object.keys(sets).sort((a, b) => (SET_ORDER.indexOf(a) + 99) % 99 - (SET_ORDER.indexOf(b) + 99) % 99);
  await fs.writeFile(path.join(OUT, 'cards.json'), JSON.stringify({ updatedAt: new Date().toISOString(), source: 'Scryfall', game: 'mtg', sets, setOrder, cards, printings: slim }));
  await fs.writeFile(path.join(OUT, 'prices.json'), JSON.stringify(pr.prices));
  await writeIndex(OUT, index, st, p => p.pid);
  await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify({
    builtAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    cards: cards.length, printings: printings.length, scanReferences: index.list.length, artGroups: index.nGroups,
    imageFailures: fp.failed.slice(0, 20), lowContrastSkipped: index.lowContrast, prices: pr.report, selftest: st,
    tuning: { refBlur: REF_BLUR, hubLambda: HUB_LAMBDA }, experiment: exp,
  }, null, 1));
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main().catch(e => { console.error(e); process.exit(1); });
