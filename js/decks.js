// Deck rules (official deckbuilding rules):
//  1. exactly 3 Legends with different names
//  2. 40–50 cards, not counting Legends
//  3. at most 3 copies of any card
//  4. every card within the RAM limit of its colour = sum of RAM of your Legends of that colour
import { db, cheapest } from './data.js';

export function checkDeck(deck) {
  const legends = deck.legends.map(id => db.cardById.get(id)).filter(Boolean);
  const ram = {};
  for (const l of legends) ram[l.c] = (ram[l.c] || 0) + (l.ram || 0);
  const fits = c => c.t === 'Legend' || ((ram[c.c] || 0) > 0 && (ram[c.c] || 0) >= (c.ram || 0));
  const main = Object.entries(deck.main).map(([id, n]) => ({ c: db.cardById.get(id), n })).filter(x => x.c && x.n > 0);
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

export function ownedByCard(cardId, coll) {
  let n = 0;
  for (const p of db.prByCard.get(cardId) || []) { const e = coll[p.id]; if (e) n += (e.n || 0) + (e.f || 0); }
  return n;
}

/** Owned vs needed copies and what the missing ones cost (cheapest English printing, Cardmarket trend). */
export function deckNeeds(deck, coll) {
  const want = new Map();
  for (const id of deck.legends) want.set(id, (want.get(id) || 0) + 1);
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
