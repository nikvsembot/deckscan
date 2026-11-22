// Talking to Claude without an API: "Copy for Claude" turns the collection + decks into compact text to paste
// into a Claude chat, and importDeck() reads a deck list Claude (or any site) wrote back.
import { db, cardOf, fullName, setShort, price, eur, gameOf, GAMES, pricesDate } from './data.js';
import { checkDeck, deckGame, MTG_FORMATS, deckNeeds } from './decks.js';

const FORMAT_NOTE = {
  cyberpunk: 'Deck rules: 3 Legends with different names, 40–50 other cards, max 3 copies of a card, RAM per colour = sum of the Legends\' RAM.',
  mtg: 'Formats in the app: Limited (40+), Constructed (60+, max 4), Commander (exactly 100, singleton, commander\'s colours).',
};

function printingLine(pid, e) {
  const pr = db.prById.get(pid), c = cardOf(pid);
  if (!pr || !c) return null;
  const out = [];
  if (e.n) out.push(`${e.n}× ${fullName(c)} | ${setShort(pr.set)} #${pr.no}${pr.v ? ' ' + pr.v : ''} | ${eur(price(pid))}`);
  if (e.f) out.push(`${e.f}× ${fullName(c)} | ${setShort(pr.set)} #${pr.no}${pr.v ? ' ' + pr.v : ''} FOIL | ${eur(price(pid, true))}`);
  return out.join('\n');
}

function cardStats(c) {
  if (c.game === 'mtg') return [c.mc && c.mc.replace(/[{}]/g, ''), c.tl, c.pw != null && `${c.pw}/${c.tough}`].filter(Boolean).join(', ');
  return [c.c, c.t, c.cost != null && `cost ${c.cost}`, c.pw != null && `power ${c.pw}`, c.ram != null && `RAM ${c.ram}`, c.tags?.length && c.tags.join('/')].filter(Boolean).join(', ');
}

export function deckText(d) {
  const game = deckGame(d), lines = [];
  const chk = checkDeck(d);
  lines.push(`## ${d.name}${game === 'mtg' ? ` (${MTG_FORMATS[d.format || 'limited'].name})` : ''} — ${chk.mainCount} cards, ${chk.legal ? 'legal' : chk.checks.filter(x => !x.ok).map(x => x.text).join('; ')}`);
  if (game === 'cyberpunk' && d.legends?.length) lines.push('Legends:', ...d.legends.map(id => `1 ${fullName(db.cardById.get(id))}`), 'Main:');
  if (game === 'mtg' && d.commander) lines.push(`Commander: ${fullName(db.cardById.get(d.commander))}`);
  for (const [id, n] of Object.entries(d.main || {})) if (n > 0 && db.cardById.get(id)) lines.push(`${n} ${fullName(db.cardById.get(id))}`);
  return lines.join('\n');
}

/** Everything Claude needs to give advice: owned cards (with stats + prices) and the saved decks. */
export function exportText(game, coll, decks) {
  const owned = Object.entries(coll).filter(([pid, e]) => gameOf(pid) === game && db.prById.has(pid) && (e.n || e.f));
  const byCard = new Map();
  for (const [pid, e] of owned) {
    const c = cardOf(pid);
    if (!byCard.has(c.id)) byCard.set(c.id, []);
    byCard.get(c.id).push([pid, e]);
  }
  const cards = [...byCard.keys()].map(id => db.cardById.get(id)).sort((a, b) => (a.t || '').localeCompare(b.t || '') || fullName(a).localeCompare(fullName(b)));
  let copies = 0, value = 0;
  for (const [pid, e] of owned) { copies += (e.n || 0) + (e.f || 0); value += (e.n || 0) * (price(pid) || 0) + (e.f || 0) * (price(pid, true) || 0); }
  const myDecks = Object.values(decks).filter(d => deckGame(d) === game);
  const out = [
    `DECKSCAN EXPORT — ${GAMES[game].name} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    `Prices: Cardmarket trend in €, updated ${pricesDate(game)}. ${FORMAT_NOTE[game]}`,
    `To save a deck you suggest: write it as "<count> <card name>" lines (with "Legends:"/"Commander:" headers where needed) — I paste it into Decks → Import deck.`,
    '',
    `COLLECTION — ${copies} cards, ${cards.length} different, worth ${eur(value)}`,
  ];
  for (const c of cards) {
    out.push(`# ${fullName(c)} — ${cardStats(c)}`);
    for (const [pid, e] of byCard.get(c.id)) { const l = printingLine(pid, e); if (l) out.push(l); }
  }
  out.push('', `DECKS — ${myDecks.length}`);
  for (const d of myDecks) {
    const need = deckNeeds(d, coll);
    out.push(deckText(d), `(owned ${need.ownedCopies}/${need.totalCopies}${need.missingCost > 0 ? `, missing cards cost ${eur(need.missingCost)}` : ''})`, '');
  }
  out.push('END OF EXPORT');
  return out.join('\n');
}

// ---------------------------------------------------------------- import
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[’`']/g, '').replace(/\s*[—–-]+\s*/g, ' - ').replace(/[^a-z0-9 /-]+/g, ' ').replace(/\s+/g, ' ').trim();

function nameIndex(game) {
  const idx = new Map(), dup = new Set();
  const put = (k, id) => { k = norm(k); if (!k) return; if (idx.has(k) && idx.get(k) !== id) dup.add(k); else idx.set(k, id); };
  for (const c of db.cards) {
    if ((c.game || 'cyberpunk') !== game) continue;
    put(fullName(c), c.id);
    put(c.n, c.id);
    if (c.n.includes(' // ')) put(c.n.split(' // ')[0], c.id);
  }
  for (const k of dup) if (!db.cards.some(c => norm(fullName(c)) === k)) idx.delete(k); // ambiguous short names
  return idx;
}

/**
 * Reads a deck list: lines like "3 Card Name", "3x Card Name (SOS) 123", "- Card Name".
 * Section headers: "Legends:", "Commander:", "Main:"/"Deck:"; "Sideboard:"/"Maybe:" sections are skipped.
 * A first line "# Name", "## Name" or "Name: …" names the deck.
 */
export function parseDeck(text, game) {
  const idx = nameIndex(game);
  const deck = { name: '', legends: [], main: {}, commander: null, unknown: [] };
  let section = 'main';
  for (let raw of String(text).split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const head = line.match(/^(#{1,3}\s*|name\s*:\s*|deck name\s*:\s*)(.+)$/i);
    if (head && !deck.name && !/^\d/.test(head[2])) { deck.name = head[2].replace(/\s*[—(].*$/, '').trim(); continue; }
    const sec = line.match(/^(legends?|commanders?|main( ?deck)?|deck|sideboard|maybe(board)?|considering|tokens?)\s*(\(\d+\))?\s*:?$/i);
    if (sec) { const k = sec[1].toLowerCase(); section = k.startsWith('legend') ? 'legends' : k.startsWith('commander') ? 'commander' : /side|maybe|consider|token/.test(k) ? 'skip' : 'main'; continue; }
    const inlineCmd = line.match(/^commander\s*:\s*(.+)$/i);
    if (inlineCmd) { line = '1 ' + inlineCmd[1]; section = 'commander'; }
    if (section === 'skip') continue;
    const m = line.replace(/^[-•*]\s*/, '').match(/^(?:(\d+)\s*[x×]?\s+)?(.+?)\s*(?:\([A-Za-z0-9]{2,6}\)\s*[\w★-]*)?\s*(?:\*[A-Z]+\*)?\s*(?:\|.*)?$/);
    if (!m) continue;
    const n = Math.max(1, Math.min(99, Number(m[1] || 1)));
    const id = idx.get(norm(m[2]));
    if (!id) {
      const noCardsYet = !deck.legends.length && !Object.keys(deck.main).length && !deck.commander;
      if (!deck.name && noCardsYet && !m[1] && !deck.unknown.length) deck.name = line; // a plain first line is the deck's name
      else deck.unknown.push(raw.trim());
      continue;
    }
    if (section === 'legends' && game === 'cyberpunk') { if (!deck.legends.includes(id)) deck.legends.push(id); continue; }
    if (section === 'commander' && game === 'mtg') { deck.commander = id; deck.main[id] = 1; section = 'main'; continue; }
    if (game === 'cyberpunk' && db.cardById.get(id)?.t === 'Legend' && deck.legends.length < 3 && !deck.legends.includes(id)) { deck.legends.push(id); continue; }
    deck.main[id] = (deck.main[id] || 0) + n;
  }
  return deck;
}
