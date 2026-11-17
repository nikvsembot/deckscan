// Builds an offline fixture that mimics the card database API and Cardmarket files,
// with synthetic card images (shared frame, distinct art), so the data job and the
// scanner can be tested without network access.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture');
const N_CARDS = Number(process.env.N_CARDS || 80);
let seed = 7;
const R = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const pick = a => a[Math.floor(R() * a.length)];
const COLORS = { Red: '#c8323c', Blue: '#2f6fd6', Green: '#2fa85a', Yellow: '#e2c02a' };
const WORDS = ['Night', 'Chrome', 'Street', 'Neon', 'Ghost', 'Blade', 'Runner', 'Static', 'Iron', 'Signal', 'Viper', 'Echo', 'Razor', 'Pulse'];

function artSVG(w, h, colorHex) {
  let s = `<rect x="0" y="0" width="${w}" height="${h}" fill="hsl(${Math.floor(R() * 360)},${30 + Math.floor(R() * 50)}%,${20 + Math.floor(R() * 40)}%)"/>`;
  for (let i = 0; i < 9; i++) {
    const c = `hsl(${Math.floor(R() * 360)},${40 + Math.floor(R() * 50)}%,${25 + Math.floor(R() * 55)}%)`;
    const kind = R();
    if (kind < 0.4) s += `<circle cx="${R() * w}" cy="${R() * h}" r="${10 + R() * w * 0.35}" fill="${c}" opacity="${0.5 + R() * 0.5}"/>`;
    else if (kind < 0.8) s += `<rect x="${R() * w}" y="${R() * h}" width="${20 + R() * w * 0.6}" height="${20 + R() * h * 0.5}" fill="${c}" transform="rotate(${R() * 60 - 30} ${w / 2} ${h / 2})" opacity="${0.5 + R() * 0.5}"/>`;
    else s += `<polygon points="${[0, 1, 2].map(() => `${R() * w},${R() * h}`).join(' ')}" fill="${c}"/>`;
  }
  return s;
}

async function cardImage(file, name, colorHex, cost) {
  const W = 600, H = 838;
  const art = artSVG(W, H * 0.62, colorHex);
  const text = Array.from({ length: 4 }, (_, i) => `<text x="40" y="${H * 0.74 + i * 34}" font-family="sans-serif" font-size="24" fill="#222">${Array.from({ length: 5 }, () => pick(WORDS)).join(' ').toLowerCase()}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <rect width="${W}" height="${H}" rx="28" fill="#111"/>
    <g transform="translate(20 20)"><svg width="${W - 40}" height="${H * 0.62}">${art}</svg></g>
    <rect x="20" y="${H * 0.62 + 20}" width="${W - 40}" height="${H * 0.36 - 40}" rx="10" fill="#e9e6dc"/>
    <rect x="20" y="${H * 0.62 + 20}" width="${W - 40}" height="44" fill="${colorHex}"/>
    <text x="36" y="${H * 0.62 + 52}" font-family="sans-serif" font-weight="bold" font-size="28" fill="#fff">${name}</text>
    <circle cx="70" cy="70" r="40" fill="${colorHex}" stroke="#fff" stroke-width="5"/>
    <text x="58" y="84" font-family="sans-serif" font-weight="bold" font-size="40" fill="#fff">${cost}</text>
    ${text}
  </svg>`;
  await sharp(Buffer.from(svg)).webp({ quality: 85 }).toFile(file);
}

async function main() {
  await fs.rm(DIR, { recursive: true, force: true });
  await fs.mkdir(path.join(DIR, 'img'), { recursive: true });
  const urls = {};
  const items = [];
  const products = [], guides = [];
  let pid = 900000, num = 1;
  for (let i = 0; i < N_CARDS; i++) {
    const name = `${pick(WORDS)} ${pick(WORDS)}`;
    const sub = R() < 0.6 ? `${pick(WORDS)} of the ${pick(WORDS)}` : '';
    const slug = `${name} ${sub}`.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + i;
    const color = pick(Object.keys(COLORS));
    const type = i < 10 ? 'Legend' : pick(['Unit', 'Unit', 'Program', 'Gear']);
    const cost = 1 + Math.floor(R() * 8);
    const nArts = R() < 0.25 ? 2 : 1;
    const printings = [];
    const no = String(num++).padStart(3, '0');
    for (let a = 0; a < nArts; a++) {
      const artFile = `img/${slug}-${a}.webp`;
      await cardImage(path.join(DIR, artFile), `${name}`, COLORS[color], cost);
      const rarity = a === 0 ? pick(['Common', 'Uncommon', 'Rare']) : 'Iconic Legend';
      const cn = nArts > 1 && a === 0 ? no + 'a' : a === 0 ? no : String(140 + i).padStart(3, '0');
      for (const [set, prefix] of [['welcometonightcityretail', ''], ['welcometonightcitybeta', 'β']]) {
        const id = `${slug}-${set}-${a}`;
        const src = `https://img.example/prod/cyberpunk/portal/${id}/render.webp`;
        urls[src] = artFile;
        printings.push({ id, collector_number: prefix + cn, image_url: src + '?Expires=1&Signature=x', source_image_url: src, set: { code: set, name: set === 'welcometonightcityretail' ? 'Welcome to Night City — Retail' : 'Welcome to Night City — Beta' }, rarity, artist: 'Test', language: 'en' });
        const exp = set === 'welcometonightcityretail' ? 6761 : 6714;
        const idp = pid++;
        products.push({ idProduct: idp, name: sub ? `${name} - ${sub}` : name, idCategory: 1, categoryName: 'Cyberpunk Single', idExpansion: exp, idMetacard: i, dateAdded: '2026-11-01 00:00:00' });
        const base = rarity === 'Iconic Legend' ? 40 + R() * 60 : 0.05 + R() * 3;
        guides.push({ idProduct: idp, avg: base, low: base * 0.7, trend: base * 1.02, avg1: base, avg7: base, avg30: base * 0.98, 'avg-foil': null, 'low-foil': null, 'trend-foil': null });
      }
    }
    // a French printing that must be ignored
    printings.push({ ...printings[0], id: printings[0].id + '-fr', set: { code: 'welcometonightcityretail-fr', name: 'FR' }, language: 'fr' });
    items.push({ slug, name, subname: sub || null, canonical_name: sub ? `${name} — ${sub}` : name, card_type: type, color, cost, power: Math.floor(R() * 9), ram: 1 + Math.floor(R() * 3), classifications: [pick(['Merc', 'Corpo', 'Netrunner'])], is_eddiable: R() < 0.5, language: 'en', printings });
  }
  const apiBase = 'https://api.netdeck.gg/api/cards/cyberpunk';
  for (let off = 0; off < items.length; off += 100) {
    const f = `api-${off}.json`;
    await fs.writeFile(path.join(DIR, f), JSON.stringify({ items: items.slice(off, off + 100), total: items.length, limit: 100, offset: off }));
    urls[`${apiBase}?limit=100&offset=${off}`] = f;
  }
  await fs.writeFile(path.join(DIR, 'products.json'), JSON.stringify({ version: 1, createdAt: '2026-11-17T03:00:00+0100', products }));
  await fs.writeFile(path.join(DIR, 'prices.json'), JSON.stringify({ version: 1, createdAt: '2026-11-17T03:00:00+0100', priceGuides: guides }));
  urls['https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_23.json'] = 'products.json';
  urls['https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_23.json'] = 'prices.json';
  await fs.writeFile(path.join(DIR, 'urls.json'), JSON.stringify(urls, null, 1));
  console.log(`fixture: ${items.length} cards, ${products.length} products`);
}
main();
