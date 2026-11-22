// Card catalogues (Cyberpunk TCG + Magic), Cardmarket prices, scan fingerprints, and card images.
import { Matcher, DIM } from '../lib/fp.js';

export const GAMES = {
  cyberpunk: { name: 'Cyberpunk', dir: 'data', cm: 'Cyberpunk' },
  mtg: { name: 'Magic', dir: 'data/mtg', cm: 'Magic' },
};
const API = 'https://api.netdeck.gg/api/cards/cyberpunk';
export const CM_PRODUCT = (id, game = 'cyberpunk') => `https://www.cardmarket.com/en/${GAMES[game].cm}/Products?idProduct=${id}`;
export const CM_SEARCH = (q, game = 'cyberpunk') => `https://www.cardmarket.com/en/${GAMES[game].cm}/Products/Search?searchString=${encodeURIComponent(q)}`;

export const db = {
  ready: false,
  cards: [], cardById: new Map(),
  printings: [], prById: new Map(), prByCard: new Map(),
  sets: {}, setOrder: [],
  prices: { p: {} },
  games: {},     // game -> { loaded, setOrder, pricesAt }
  matchers: {},  // game -> { matcher, fpIds, thresholds, groupMembers }
  history: {},   // game -> { dates, n, f } (daily prices in cents) or null
};

const bust = () => Math.floor(Date.now() / 36e5); // hourly cache-buster; the service worker also refreshes data files
async function loadGame(game) {
  const dir = GAMES[game].dir, v = bust();
  const [cards, prices] = await Promise.all([
    fetch(`${dir}/cards.json?v=${v}`).then(r => { if (!r.ok) throw new Error(`${GAMES[game].name} cards: HTTP ${r.status}`); return r.json(); }),
    fetch(`${dir}/prices.json?v=${v}`).then(r => r.json()).catch(() => ({ p: {} })),
  ]);
  for (const c of cards.cards) c.game = game;
  return { cards, prices };
}

export async function loadData() {
  const loaded = {};
  loaded.cyberpunk = await loadGame('cyberpunk');
  try { loaded.mtg = await loadGame('mtg'); } catch { /* Magic data not built yet: the app still works for Cyberpunk */ }
  db.cards = []; db.printings = []; db.sets = {}; db.setOrder = []; db.prices = { p: {} };
  for (const [game, { cards, prices }] of Object.entries(loaded)) {
    db.cards.push(...cards.cards);
    db.printings.push(...cards.printings);
    Object.assign(db.sets, cards.sets);
    db.setOrder.push(...cards.setOrder);
    Object.assign(db.prices.p, prices.p);
    db.games[game] = { loaded: true, setOrder: cards.setOrder, pricesAt: prices.updatedAt || null };
  }
  db.cardById = new Map(db.cards.map(c => [c.id, c]));
  db.prById = new Map(db.printings.map(p => [p.id, p]));
  db.prByCard = new Map();
  for (const p of db.printings) {
    if (!db.prByCard.has(p.c)) db.prByCard.set(p.c, []);
    db.prByCard.get(p.c).push(p);
  }
  db.ready = true;
  return db;
}
export const hasGame = game => !!db.games[game]?.loaded;

export async function loadMatcher(game = 'cyberpunk') {
  if (db.matchers[game]) return db.matchers[game];
  const dir = GAMES[game].dir, v = bust();
  const [meta, bin] = await Promise.all([
    fetch(`${dir}/fp.json?v=${v}`).then(r => r.json()),
    fetch(`${dir}/fp.bin?v=${v}`).then(r => r.arrayBuffer()),
  ]);
  if (meta.dim !== DIM) throw new Error('Fingerprint format changed — reload the app');
  const groups = Int32Array.from(meta.group);
  const groupMembers = new Map();
  meta.ids.forEach((id, i) => {
    const g = groups[i];
    if (!groupMembers.has(g)) groupMembers.set(g, []);
    if (!groupMembers.get(g).includes(id)) groupMembers.get(g).push(id);
  });
  db.matchers[game] = {
    matcher: new Matcher(new Int8Array(bin), Float32Array.from(meta.scales), groups, meta.mean ? Float32Array.from(meta.mean) : null,
      { hub: meta.hub ? Float32Array.from(meta.hub) : null, lambda: meta.thresholds?.lambda || 0,
        weights: meta.weights ? Float32Array.from(meta.weights) : null, topK: meta.thresholds?.topK || 24 }),
    fpIds: meta.ids, thresholds: meta.thresholds, groupMembers,
  };
  return db.matchers[game];
}

// ---------- names, sets, prices ----------
export const cardOf = pid => db.cardById.get(db.prById.get(pid)?.c);
export const gameOf = pid => cardOf(pid)?.game || 'cyberpunk';
export const fullName = c => (c ? (c.s ? `${c.n} — ${c.s}` : c.n) : '?');
export const setName = code => db.sets[code]?.name || code;
const MTG_SHORT = { sos: 'SOS', soa: 'Archive', spg: 'Guest', psos: 'Promo', '40k': '40K' };
export function setShort(code) {
  if (MTG_SHORT[code]) return MTG_SHORT[code];
  const n = setName(code);
  if (/Welcome to Night City/.test(n)) return /Beta/.test(n) ? 'WNC Beta' : 'WNC Retail';
  return n.replace(/ Starter Deck/, ' SD').replace(/Edgerunner Open S 1/, 'Edgerunner Open').replace(/ – /g, ' ');
}
/** "WNC Retail #005a" or "SOS #312 · Borderless" */
export const prLabel = p => (p ? `${setShort(p.set)} #${p.no}${p.v ? ' · ' + p.v : ''}` : '');
export const isFoilOnly = pr => pr && /Iconic|Secret|Nova/.test(pr.r);

/**
 * Cardmarket value in EUR (null if Cardmarket has no price yet).
 * Price trend first; foil-only versions (Epic/Iconic/Secret/Nova) only have a foil trend;
 * brand-new versions may only have a lowest listing.
 * p = [idProduct, trend, low, avg30, trendFoil, lowFoil, avg30Foil]
 */
export function price(pid, foil = false) {
  const p = db.prices.p[pid];
  if (!p) return null;
  const v = x => (x > 0 ? x : null);
  return foil
    ? (v(p[4]) ?? v(p[1]) ?? v(p[5]) ?? v(p[2]) ?? null)
    : (v(p[1]) ?? v(p[4]) ?? v(p[3]) ?? v(p[6]) ?? v(p[2]) ?? v(p[5]) ?? null);
}
export const productId = pid => db.prices.p[pid]?.[0] ?? null;
export function cmLink(pid) {
  const id = productId(pid), game = gameOf(pid);
  return id ? CM_PRODUCT(id, game) : CM_SEARCH(cardOf(pid)?.n || '', game);
}
/** Cheapest printing of a card (for "cost to complete a deck"). */
export function cheapest(cardId) {
  let best = null;
  for (const p of db.prByCard.get(cardId) || []) {
    const v = price(p.id, false);
    if (v != null && (!best || v < best.v)) best = { pid: p.id, v };
  }
  return best;
}

export const eur = v => (v == null ? '–' : '€' + (v >= 1000 ? Math.round(v).toLocaleString('en') : v.toFixed(2)));

export function pricesDate(game = 'cyberpunk') {
  const at = db.games[game]?.pricesAt;
  const d = at ? new Date(at.replace(/(\d\d)(\d\d)$/, '$1:$2')) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'unknown';
}

/** Preferred printing among identical-artwork printings (e.g. Retail over Beta, main set over promo). */
export function preferredMember(members, preferSet) {
  const order = [preferSet, ...db.setOrder.filter(s => s !== preferSet)];
  const rank = id => { const p = db.prById.get(id); return (order.indexOf(p?.set) + 1 || 999) * 1000 + (p?.v ? 1 : 0); };
  return [...members].sort((a, b) => rank(a) - rank(b))[0];
}

// ---------- images ----------
// Magic: Scryfall picture links are permanent. Cyberpunk: signed links expire after ~5 min, so fetch per card, on demand.
const img = new Map();   // printing id -> { url, at }
const inflight = new Map();
const FRESH_MS = 4 * 60 * 1000;

export async function imageUrl(pid) {
  const pr = db.prById.get(pid);
  if (pr?.img) return pr.img;
  const hit = img.get(pid);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.url;
  const card = pr?.c;
  if (!card) return null;
  if (!inflight.has(card)) {
    inflight.set(card, fetch(`${API}/${encodeURIComponent(card)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(j => {
        const at = Date.now();
        for (const p of j?.printings || []) img.set(p.id, { url: p.image_url, at });
      })
      .catch(() => {})
      .finally(() => inflight.delete(card)));
  }
  await inflight.get(card);
  return img.get(pid)?.url || null;
}

// ---------------------------------------------------------------- price history (one point per day, built by scripts/history.mjs)
export async function loadHistory(game) {
  if (db.history[game] !== undefined) return db.history[game];
  try {
    const r = await fetch(`${GAMES[game].dir}/history.json`);
    db.history[game] = r.ok ? await r.json() : null;
  } catch { db.history[game] = null; }
  return db.history[game];
}

/** Daily values (€) of one printing; days without a price take the nearest known day. */
export function historyOf(h, pid, foil = false) {
  const n = h?.n[pid];
  if (!n) return null;
  const f = foil ? h.f[pid] : null;
  const out = h.dates.map((_, i) => { const c = f?.[i] ?? n[i]; return c == null ? null : c / 100; });
  let last = null;
  for (let i = 0; i < out.length; i++) out[i] == null ? (out[i] = last) : (last = out[i]);
  for (let i = out.length - 1; i >= 0; i--) out[i] == null ? (out[i] = last) : (last = out[i]);
  return out.every(x => x == null) ? null : out;
}

/** Value of the current collection on every day of the history. */
export function collectionSeries(h, coll, game) {
  if (!h?.dates.length) return null;
  const tot = h.dates.map(() => 0);
  for (const [pid, e] of Object.entries(coll)) {
    if (gameOf(pid) !== game) continue;
    for (const [qty, foil] of [[e.n, false], [e.f, true]]) {
      if (!qty) continue;
      const s = historyOf(h, pid, foil);
      if (s) s.forEach((x, i) => { tot[i] += qty * (x || 0); });
    }
  }
  return tot.map(x => Math.round(x * 100) / 100);
}

/** Index of the day to compare against: the last day at least `days` before the newest one. */
export function baseIndex(h, days) {
  const L = h?.dates.length || 0;
  if (L < 2) return -1;
  if (!isFinite(days)) return 0;
  const t = new Date(h.dates[L - 1] + 'T12:00:00Z');
  t.setUTCDate(t.getUTCDate() - days);
  const ts = t.toISOString().slice(0, 10);
  let idx = 0;
  for (let i = 0; i < L; i++) if (h.dates[i] <= ts) idx = i;
  return Math.min(idx, L - 2);
}

/** Cardmarket's 30-day average sale price, for "vs 30-day average". */
export function avg30(pid, foil = false) {
  const p = db.prices.p[pid];
  if (!p) return null;
  const v = x => (x > 0 ? x : null);
  return foil ? (v(p[6]) ?? v(p[3])) : (v(p[3]) ?? v(p[6]));
}

/**
 * Price changes per printing. period: number of days, Infinity (since the first day) or 'avg' (vs 30-day average).
 * mine: only owned printings, weighted by copies. Returns rows sorted by the biggest € change first.
 */
export function priceChanges({ h, period, mine, coll, game }) {
  const L = h?.dates.length || 0;
  const bi = period === 'avg' ? null : baseIndex(h, period);
  if (period !== 'avg' && bi < 0) return [];
  const one = (pid, foil) => {
    if (period === 'avg') return [avg30(pid, foil), price(pid, foil)];
    const s = historyOf(h, pid, foil);
    return s ? [s[bi], s[L - 1]] : [null, null];
  };
  const rows = [];
  const pids = mine ? Object.keys(coll).filter(pid => gameOf(pid) === game && db.prById.has(pid))
    : db.printings.filter(p => gameOf(p.id) === game).map(p => p.id);
  for (const pid of pids) {
    const e = mine ? coll[pid] : { n: 1 };
    let total = 0, from = null, to = null, qty = 0;
    for (const [q, foil] of [[e.n || 0, false], [e.f || 0, true]]) {
      if (!q) continue;
      const [a, b] = one(pid, foil);
      if (a == null || b == null) continue;
      total += q * (b - a); qty += q;
      if (from == null) { from = a; to = b; }
    }
    if (from == null || Math.abs(to - from) < (mine ? 0.005 : 0.05)) continue;
    rows.push({ pid, from, to, d: to - from, pct: from > 0 ? (to - from) / from : null, qty, total: mine ? total : to - from });
  }
  return rows.sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
}

export const shortDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
