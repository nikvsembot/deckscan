// Offline fixture mimicking Scryfall + Cardmarket's Magic price guide, with Magic-style card images
// (black border, title bar, art box, type line, text box) so the Magic data job and scanner can be tested.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mtg-fixture');
const SCRY = 'https://api.scryfall.com';
let seed = 11;
const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(R() * a.length)];
const WORDS = ['Arcane', 'Scholar', 'Quill', 'Ember', 'Rune', 'Lore', 'Prism', 'Witch', 'Bloom', 'Silver', 'Owl', 'Tome', 'Spark', 'Archive'];
const FRAME = { W: '#e9e2c8', U: '#2b6cb0', B: '#3a3340', R: '#c53030', G: '#2f855a', M: '#c9a227', L: '#a08b6c' };
const TYPES = ['Creature — Human Wizard', 'Instant', 'Sorcery', 'Enchantment', 'Artifact', 'Land'];

function art(w, h) {
  let s = `<rect width="${w}" height="${h}" fill="hsl(${Math.floor(R() * 360)},${30 + Math.floor(R() * 50)}%,${20 + Math.floor(R() * 40)}%)"/>`;
  for (let i = 0; i < 8; i++) {
    const c = `hsl(${Math.floor(R() * 360)},${40 + Math.floor(R() * 50)}%,${25 + Math.floor(R() * 55)}%)`;
    s += R() < 0.5 ? `<circle cx="${R() * w}" cy="${R() * h}" r="${10 + R() * w * 0.3}" fill="${c}"/>`
      : `<rect x="${R() * w}" y="${R() * h}" width="${20 + R() * w * 0.5}" height="${20 + R() * h * 0.5}" fill="${c}" transform="rotate(${R() * 60 - 30} ${w / 2} ${h / 2})"/>`;
  }
  return s;
}
async function cardImage(file, name, frame, type, borderless) {
  const W = 488, H = 680;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" rx="22" fill="#111"/>
    ${borderless ? `<svg width="${W}" height="${H}">${art(W, H)}</svg>` : `<rect x="18" y="18" width="${W - 36}" height="${H - 36}" rx="10" fill="${frame}"/>
    <g transform="translate(40 80)"><svg width="${W - 80}" height="${H * 0.45}">${art(W - 80, H * 0.45)}</svg></g>`}
    <rect x="34" y="34" width="${W - 68}" height="38" rx="8" fill="#f1ede2" opacity="0.95"/>
    <text x="46" y="61" font-family="serif" font-weight="bold" font-size="22" fill="#111">${name}</text>
    <rect x="34" y="${80 + H * 0.45 + 6}" width="${W - 68}" height="32" rx="6" fill="#f1ede2" opacity="0.95"/>
    <text x="46" y="${80 + H * 0.45 + 28}" font-family="serif" font-size="18" fill="#111">${type}</text>
    <rect x="40" y="${80 + H * 0.45 + 46}" width="${W - 80}" height="${H * 0.26}" fill="#f4f0e6" opacity="${borderless ? 0.8 : 1}"/>
    ${[0, 1, 2].map(i => `<text x="52" y="${80 + H * 0.45 + 76 + i * 26}" font-family="serif" font-size="17" fill="#222">${Array.from({ length: 6 }, () => pick(WORDS)).join(' ').toLowerCase()}</text>`).join('')}
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 88 }).toFile(file);
}

async function main() {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(DIR, 'img'), { recursive: true });
  const urls = {}, guides = [];
  let pid = 800000, cn = 1;
  const make = async (set, opts = {}) => {
    const name = `${pick(WORDS)} ${pick(WORDS)}`;
    const color = pick(['W', 'U', 'B', 'R', 'G']);
    const type = opts.type || pick(TYPES);
    const id = `${set}-${cn}-${Math.floor(R() * 1e6)}`;
    const file = `img/${id}.jpg`;
    await cardImage(path.join(DIR, file), name, FRAME[color], type, opts.borderless);
    const img = `https://cards.scryfall.io/normal/front/${id}.jpg?1700000000`;
    urls[img] = file;
    const idProduct = pid++;
    const base = opts.borderless ? 5 + R() * 20 : 0.05 + R() * 2;
    guides.push({ idProduct, avg: base, low: base * 0.7, trend: base, avg30: base, 'trend-foil': base * 2, 'low-foil': base * 1.5, 'avg30-foil': base * 2 });
    const card = {
      object: 'card', id, oracle_id: opts.oracle || `or-${id}`, name, lang: 'en', released_at: '2026-04-24', set, collector_number: String(cn++),
      rarity: pick(['common', 'uncommon', 'rare', 'mythic']), type_line: type, mana_cost: '{2}{' + color + '}', cmc: 3, colors: type === 'Land' ? [] : [color],
      color_identity: [color], power: type.startsWith('Creature') ? '2' : undefined, toughness: type.startsWith('Creature') ? '3' : undefined,
      image_uris: { normal: img }, cardmarket_id: idProduct, finishes: ['nonfoil', 'foil'], border_color: opts.borderless ? 'borderless' : 'black',
      frame_effects: [], promo_types: opts.promo ? [opts.promo] : undefined, prices: { eur: base.toFixed(2), eur_foil: null }, artist: 'Test',
    };
    if (opts.dfc) {
      const backFile = `img/${id}-b.jpg`;
      await cardImage(path.join(DIR, backFile), name + ' Back', FRAME[color], 'Creature — Spirit', false);
      const backImg = `https://cards.scryfall.io/normal/back/${id}.jpg?1700000000`;
      urls[backImg] = backFile;
      delete card.image_uris;
      card.card_faces = [{ name, type_line: type, mana_cost: card.mana_cost, image_uris: { normal: img } }, { name: name + ' Back', type_line: 'Creature — Spirit', mana_cost: '', image_uris: { normal: backImg } }];
      card.type_line = `${type} // Creature — Spirit`;
    }
    return card;
  };
  const sos = [];
  for (let i = 0; i < 70; i++) sos.push(await make('sos', { dfc: i === 3 }));
  // a borderless alt-art reprint of the first card (same oracle, different art) and a basic land
  sos.push(await make('sos', { borderless: true, oracle: sos[0].oracle_id }));
  sos.push(await make('sos', { type: 'Basic Land — Island' }));
  const soa = []; for (let i = 0; i < 20; i++) soa.push(await make('soa', { type: pick(['Instant', 'Sorcery']) }));
  const spg = []; for (let i = 0; i < 6; i++) spg.push(await make('spg'));
  spg.push({ ...(await make('spg')), released_at: '2025-11-14' }); // a Special Guest from another set: must be skipped
  const page = (data, more, next) => ({ object: 'list', total_cards: data.length, has_more: more, next_page: next, data });
  const q = s => `${SCRY}/cards/search?q=${encodeURIComponent(s)}&unique=prints&order=set`;
  const write = async (name, obj) => { await fs.writeFile(path.join(DIR, name), JSON.stringify(obj)); return name; };
  urls[`${SCRY}/sets/sos`] = await write('set-sos.json', { object: 'set', code: 'sos', name: 'Secrets of Strixhaven', released_at: '2026-04-24' });
  const p2 = `${SCRY}/cards/search?page=2&q=e%3Asos`;
  urls[q('e:sos')] = await write('sos-1.json', page(sos.slice(0, 40), true, p2));
  urls[p2] = await write('sos-2.json', page(sos.slice(40), false));
  urls[q('e:soa')] = await write('soa.json', page(soa, false));
  urls[q('e:spg')] = await write('spg.json', page(spg, false));
  // e:psos intentionally missing (404)
  urls['https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_1.json'] = await write('pg1.json', { version: 1, createdAt: '2026-11-22T03:00:00+0100', priceGuides: guides.concat([{ idProduct: 1, trend: 99 }]) });
  await fs.writeFile(path.join(DIR, 'urls.json'), JSON.stringify(urls, null, 1));
  console.log(`mtg fixture: ${sos.length} SOS, ${soa.length} SOA, ${spg.length} SPG`);
}
main();
