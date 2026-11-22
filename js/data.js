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
    matcher: new Matcher(new Int8Array(bin), Float32Array.from(meta.scales), groups, meta.mean ? Float32Array.from(meta.mean) : null),
    fpIds: meta.ids, thresholds: meta.thresholds, groupMembers,
  };
  return db.matchers[game];
}

// ---------- names, sets, prices ----------
export const cardOf = pid => db.cardById.get(db.prById.get(pid)?.c);
export const gameOf = pid => cardOf(pid)?.game || 'cyberpunk';
export const fullName = c => (c ? (c.s ? `${c.n} — ${c.s}` : c.n) : '?');
export const setName = code => db.sets[code]?.name || code;
const MTG_SHORT = { sos: 'SOS', soa: 'Archive', spg: 'Guest', psos: 'Promo' };
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
