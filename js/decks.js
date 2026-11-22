// Deck rules.
// Cyberpunk TCG (official deckbuilding rules):
//  1. exactly 3 Legends with different names
//  2. 40–50 cards, not counting Legends
//  3. at most 3 copies of any card
//  4. every card within the RAM limit of its colour = sum of RAM of your Legends of that colour
// Magic: The Gathering:
//  Limited (Sealed/Draft, e.g. from the Bundle): at least 40 cards, any number of copies of what you opened.
//  Constructed (Standard etc.): at least 60 cards, at most 4 copies of a card except basic lands.
import { db, cheapest } from './data.js';

export const MTG_FORMATS = {
  limited: { name: 'Limited (40+ cards)', min: 40, copies: null },
  constructed: { name: 'Constructed (60+ cards)', min: 60, copies: 4 },
  commander: { name: 'Commander (100 cards)', min: 100, max: 100, copies: 1, commander: true },
};
export const isCommanderCard = c => /Legendary/.test(c?.tl || '') && /Creature/.test(c?.tl || '');
export const deckGame = deck => deck.game || 'cyberpunk';
export const copyLimit = (deck, card) => {
  if (deckGame(deck) !== 'mtg') return 3;
  if (card?.basic) return 99;
  return MTG_FORMATS[deck.format || 'limited'].copies || 99;
};

export function checkDeck(deck) {
  return deckGame(deck) === 'mtg' ? checkMtg(deck) : checkCyberpunk(deck);
}

function mainCards(deck) {
  return Object.entries(deck.main).map(([id, n]) => ({ c: db.cardById.get(id), n })).filter(x => x.c && x.n > 0);
}

function checkCyberpunk(deck) {
  const legends = (deck.legends || []).map(id => db.cardById.get(id)).filter(Boolean);
  const ram = {};
  for (const l of legends) ram[l.c] = (ram[l.c] || 0) + (l.ram || 0);
  const fits = c => c.t === 'Legend' || ((ram[c.c] || 0) > 0 && (ram[c.c] || 0) >= (c.ram || 0));
  const main = mainCards(deck);
  const mainCount = main.reduce((a, x) => a + x.n, 0);
  const names = legends.map(l => l.n);
  const uniqueNames = new Set(names).size === names.length;
  const over = main.filter(x => x.n > 3);
  const badRam = main.filter(x => !fits(x.c));
  const checks = [
    { ok: legends.length === 3 && uniqueNames, text: legends.length < 3 ? `Legends: ${legends.length}/3` : uniqueNames ? '3 Legends with different names' : 'Your Legends need different names' },
    { ok: mainCount >= 40 && mainCount <= 50, text: `${mainCount} cards (needs 40–50, Legends not counted)` },
    { ok: over.length === 0, text: over.length ? `More than 3 copies: ${over.map(x => x.c.n).join(', ')}` : 'Max 3 copies of each card' },
    { ok: badRam.length === 0 && legends.length > 0, text: badRam.length ? `${badRam.length} card${badRam.length > 1 ? 's' : ''} over your Legends’ RAM` : legends.length ? 'All cards within RAM limits' : 'Pick Legends to set RAM limits' },
  ];
  const ramText = Object.keys(ram).length ? 'RAM limit: ' + Object.entries(ram).map(([c, v]) => `${c} ${v}`).join(' · ') : '';
  const problems = checks.filter(c => !c.ok).length;
  return { checks, legal: problems === 0, problems, mainCount, fits, ram, ramText };
}

function checkMtg(deck) {
  const f = MTG_FORMATS[deck.format || 'limited'];
  const main = mainCards(deck);
  const mainCount = main.reduce((a, x) => a + x.n, 0);
  const lands = main.filter(x => x.c.t === 'Land').reduce((a, x) => a + x.n, 0);
  const over = f.copies ? main.filter(x => !x.c.basic && x.n > f.copies) : [];
  const colors = [...new Set(main.flatMap(x => x.c.ci || []))];
  const NAMES = { W: 'White', U: 'Blue', B: 'Black', R: 'Red', G: 'Green' };
  const checks = [
    f.max
      ? { ok: mainCount === f.max, text: `${mainCount} cards (${f.name.toLowerCase().replace(/ \(.*/, '')} needs exactly ${f.max}, commander included)` }
      : { ok: mainCount >= f.min, text: `${mainCount} cards (${f.name.toLowerCase().replace(/ \(.*/, '')} needs at least ${f.min})` },
    f.copies
      ? { ok: over.length === 0, text: over.length ? `More than ${f.copies} copies: ${over.map(x => x.c.n).join(', ')}` : `Max ${f.copies} copies of each card (basic lands unlimited)` }
      : { ok: true, text: 'Any number of copies of cards you opened' },
    { ok: true, text: `${lands} lands${mainCount ? ` (${Math.round((100 * lands) / mainCount)}% — about ${f.commander ? '37' : '40'}% is typical)` : ''}` },
  ];
  if (f.commander) {
    const cmd = deck.commander && deck.main?.[deck.commander] ? db.cardById.get(deck.commander) : null;
    const ci = new Set(cmd?.ci || []);
    const outside = cmd ? main.filter(x => (x.c.ci || []).some(k => !ci.has(k))) : [];
    checks.push(cmd
      ? { ok: outside.length === 0, text: outside.length ? `Outside ${cmd.n}'s colours: ${outside.map(x => x.c.n).join(', ')}` : `Commander: ${cmd.n} — all cards fit its colours` }
      : { ok: false, text: 'Pick a commander (a legendary creature in the deck)' });
  }
  const problems = checks.filter(c => !c.ok).length;
  const ramText = colors.length ? 'Colours: ' + colors.map(c => NAMES[c] || c).join(' · ') : '';
  return { checks, legal: problems === 0, problems, mainCount, fits: () => true, ram: {}, ramText };
}

export function ownedByCard(cardId, coll) {
  let n = 0;
  for (const p of db.prByCard.get(cardId) || []) { const e = coll[p.id]; if (e) n += (e.n || 0) + (e.f || 0); }
  return n;
}

/** Owned vs needed copies and what the missing ones cost (cheapest printing, Cardmarket trend). */
export function deckNeeds(deck, coll) {
  const want = new Map();
  for (const id of deck.legends || []) want.set(id, (want.get(id) || 0) + 1);
  for (const [id, n] of Object.entries(deck.main)) if (n > 0) want.set(id, (want.get(id) || 0) + n);
  let totalCopies = 0, ownedCopies = 0, missingCost = 0;
  const missing = [];
  for (const [id, n] of want) {
    const card = db.cardById.get(id);
    if (!card) continue;
    const have = Math.min(ownedByCard(id, coll), n);
    totalCopies += n; ownedCopies += have;
    if (have < n) {
      const cheap = cheapest(id);
      const cost = cheap ? cheap.v * (n - have) : 0;
      missingCost += cost;
      missing.push({ card, need: n - have, cheap, cost });
    }
  }
  missing.sort((a, b) => b.cost - a.cost);
  return { totalCopies, ownedCopies, missing, missingCost };
}
