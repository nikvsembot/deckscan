// Price history: adds today's prices (from the freshly built data/…/prices.json) to the history kept on the
// `price-history` branch (checked out at argv[2]), and copies the last 400 days into the site as
// data/history.json and data/mtg/history.json.
//
// Format per game: { dates: ['2026-11-22', …], n: { printingId: [cents|null per date] }, f: { printingId: [...] } }
// n = the value the app shows for a normal copy, f = for a foil copy (only kept where it differs from n).
// One point per Cardmarket price-guide date, so several builds on the same day overwrite rather than add.
import fs from 'node:fs/promises';
import path from 'node:path';

const HIST = process.argv[2] || 'hist';
const KEEP_ON_SITE = 400;
const GAMES = [['cyberpunk', 'data'], ['mtg', 'data/mtg']];

// Same fallbacks as price() in js/data.js. p = [idProduct, trend, low, avg30, trendFoil, lowFoil, avg30Foil]
const v = x => (x > 0 ? x : null);
const normal = p => v(p[1]) ?? v(p[4]) ?? v(p[3]) ?? v(p[6]) ?? v(p[2]) ?? v(p[5]) ?? null;
const foil = p => v(p[4]) ?? v(p[1]) ?? v(p[5]) ?? v(p[2]) ?? null;
const cents = x => (x == null ? null : Math.round(x * 100));

const pad = (a, L) => { for (let j = 0; j < L; j++) if (a[j] === undefined) a[j] = null; return a; };

for (const [game, dir] of GAMES) {
  let prices;
  try { prices = JSON.parse(await fs.readFile(path.join(dir, 'prices.json'), 'utf8')); }
  catch { console.log(`${game}: no prices.json, skipped`); continue; }
  const date = String(prices.updatedAt || new Date().toISOString()).slice(0, 10);

  const file = path.join(HIST, `${game}.json`);
  let h;
  try { h = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { h = { dates: [], n: {}, f: {} }; }

  let i = h.dates.indexOf(date);
  if (i < 0 && h.dates.length && date < h.dates.at(-1)) {
    console.log(`${game}: price guide ${date} is older than the history (${h.dates.at(-1)}), not added`);
  } else {
    if (i < 0) { h.dates.push(date); i = h.dates.length - 1; }
    for (const [pid, p] of Object.entries(prices.p || {})) {
      const n = cents(normal(p)), f = cents(foil(p));
      (h.n[pid] ||= [])[i] = n;
      if (f !== n || h.f[pid]) (h.f[pid] ||= [])[i] = f;
    }
  }
  const L = h.dates.length;
  for (const o of [h.n, h.f]) for (const k in o) pad(o[k], L);

  await fs.mkdir(HIST, { recursive: true });
  await fs.writeFile(file, JSON.stringify(h));

  const from = Math.max(0, L - KEEP_ON_SITE), cut = o => Object.fromEntries(Object.entries(o).map(([k, a]) => [k, a.slice(from)]));
  await fs.writeFile(path.join(dir, 'history.json'), JSON.stringify({ dates: h.dates.slice(from), n: cut(h.n), f: cut(h.f) }));
  // Reference copy for the Claude deck advisor (read from the branch): card list, rules text, today's prices.
  await fs.mkdir(path.join(HIST, 'ref'), { recursive: true });
  for (const f of ['cards.json', 'cards-text.json', 'prices.json'])
    await fs.copyFile(path.join(dir, f), path.join(HIST, 'ref', `${game}-${f}`)).catch(() => {});
  console.log(`${game}: ${L} day(s) of prices (${h.dates[0]} … ${h.dates.at(-1)}), ${Object.keys(h.n).length} printings`);
}
