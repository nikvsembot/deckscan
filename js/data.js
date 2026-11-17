// Card catalogue, Cardmarket prices, scan fingerprints, and card images.
import { Matcher, DIM } from '../lib/fp.js';

const API = 'https://api.netdeck.gg/api/cards/cyberpunk';
export const CM_PRODUCT = id => `https://www.cardmarket.com/en/Cyberpunk/Products?idProduct=${id}`;
export const CM_SEARCH = q => `https://www.cardmarket.com/en/Cyberpunk/Products/Search?searchString=${encodeURIComponent(q)}`;

export const db = {
  ready: false,
  cards: [], cardById: new Map(),
  printings: [], prById: new Map(), prByCard: new Map(),
  sets: {}, setOrder: [],
  prices: { p: {}, updatedAt: null },
  matcher: null, fpIds: [], groupMembers: new Map(), thresholds: null,
};

export async function loadData() {
  const v = Math.floor(Date.now() / 36e5); // hourly cache-buster; the service worker also refreshes data files
  const [cards, prices] = await Promise.all([
    fetch(`data/cards.json?v=${v}`).then(r => r.json()),
    fetch(`data/prices.json?v=${v}`).then(r => r.json()).catch(() => ({ p: {} })),
  ]);
  db.cards = cards.cards;
  db.cardById = new Map(cards.cards.map(c => [c.id, c]));
  db.sets = cards.sets; db.setOrder = cards.setOrder;
  db.printings = cards.printings;
  db.prById = new Map(cards.printings.map(p => [p.id, p]));
  db.prByCard = new Map();
  for (const p of cards.printings) {
    if (!db.prByCard.has(p.c)) db.prByCard.set(p.c, []);
    db.prByCard.get(p.c).push(p);
  }
  db.prices = prices;
  db.ready = true;
  return db;
}

export async function loadMatcher() {
  if (db.matcher) return db.matcher;
  const v = Math.floor(Date.now() / 36e5); // hourly cache-buster; the service worker also refreshes data files
  const [meta, bin] = await Promise.all([
    fetch(`data/fp.json?v=${v}`).then(r => r.json()),
    fetch(`data/fp.bin?v=${v}`).then(r => r.arrayBuffer()),
  ]);
  if (meta.dim !== DIM) throw new Error('Fingerprint format changed — reload the app');
  const groups = Int32Array.from(meta.group);
  db.matcher = new Matcher(new Int8Array(bin), Float32Array.from(meta.scales), groups, meta.mean ? Float32Array.from(meta.mean) : null);
  db.fpIds = meta.ids;
  db.thresholds = meta.thresholds;
  db.groupMembers = new Map();
  meta.ids.forEach((id, i) => {
    const g = groups[i];
    if (!db.groupMembers.has(g)) db.groupMembers.set(g, []);
    db.groupMembers.get(g).push(id);
  });
  return db.matcher;
}

// ---------- names, sets, prices ----------
export const cardOf = pid => db.cardById.get(db.prById.get(pid)?.c);
export const fullName = c => (c ? (c.s ? `${c.n} — ${c.s}` : c.n) : '?');
export const setName = code => db.sets[code]?.name || code;
export function setShort(code) {
  const n = setName(code);
  if (/Welcome to Night City/.test(n)) return /Beta/.test(n) ? 'WNC Beta' : 'WNC Retail';
  return n.replace(/ Starter Deck/, ' SD').replace(/Edgerunner Open S 1/, 'Edgerunner Open').replace(/ – /g, ' ');
}
export const isFoilOnly = pr => pr && /Iconic|Secret|Nova/.test(pr.r);

/** Cardmarket trend price in EUR (null if unknown). */
export function price(pid, foil = false) {
  const p = db.prices.p[pid];
  if (!p) return null;
  return foil ? (p[4] ?? p[1] ?? null) : (p[1] ?? p[4] ?? p[2] ?? null);
}
export const productId = pid => db.prices.p[pid]?.[0] ?? null;
export function cmLink(pid) {
  const id = productId(pid);
  return id ? CM_PRODUCT(id) : CM_SEARCH(cardOf(pid)?.n || '');
}
/** Cheapest English printing of a card (for "cost to complete a deck"). */
export function cheapest(cardId) {
  let best = null;
  for (const p of db.prByCard.get(cardId) || []) {
    const v = price(p.id, false);
    if (v != null && (!best || v < best.v)) best = { pid: p.id, v };
  }
  return best;
}

export const eur = v => (v == null ? '–' : '€' + (v >= 1000 ? Math.round(v).toLocaleString('en') : v.toFixed(2)));

export function pricesDate() {
  const d = db.prices.updatedAt ? new Date(db.prices.updatedAt.replace(/(\d\d)(\d\d)$/, '$1:$2')) : null;
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : 'unknown';
}

/** Preferred printing among identical-artwork printings (e.g. Retail over Beta). */
export function preferredMember(members, preferSet) {
  const order = [preferSet, ...db.setOrder.filter(s => s !== preferSet)];
  return [...members].sort((a, b) => order.indexOf(db.prById.get(a).set) - order.indexOf(db.prById.get(b).set))[0];
}

// ---------- images (signed links expire after ~5 min, so fetch per card, on demand) ----------
const img = new Map();   // printing id -> { url, at }
const inflight = new Map();
const FRESH_MS = 4 * 60 * 1000;

export async function imageUrl(pid) {
  const hit = img.get(pid);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.url;
  const card = db.prById.get(pid)?.c;
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
