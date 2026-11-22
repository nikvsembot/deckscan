// Card fingerprinting and matching.
// Shared by the browser app (live camera) and the Node data job (reference images),
// so both sides compute exactly the same numbers. No dependencies.

export const GW = 14;            // grid cells across the card
export const GH = 20;            // grid cells down the card (63x88mm ≈ 14x20)
const CELLS = GW * GH;
export const DIM = CELLS * 3 + (GW - 1) * GH + GW * (GH - 1);
export const CARD_ASPECT = 63 / 88; // width / height

const W_I = 1.0, W_O = 0.55, W_D = 0.8; // block weights: intensity, colour, gradients

/** Summed-area table of an RGBA buffer, one plane per channel (R,G,B). */
export function integral(rgba, w, h) {
  const W1 = w + 1;
  const S = new Float64Array(W1 * (h + 1) * 3);
  for (let y = 0; y < h; y++) {
    let r = 0, g = 0, b = 0;
    const row = y * w * 4;
    const o = (y + 1) * W1 * 3, op = y * W1 * 3;
    for (let x = 0; x < w; x++) {
      const p = row + x * 4;
      r += rgba[p]; g += rgba[p + 1]; b += rgba[p + 2];
      const q = o + (x + 1) * 3, qp = op + (x + 1) * 3;
      S[q] = S[qp] + r; S[q + 1] = S[qp + 1] + g; S[q + 2] = S[qp + 2] + b;
    }
  }
  return { S, w, h };
}

function boxMean(ii, x0, y0, x1, y1, out) {
  const { S, w, h } = ii, W1 = w + 1;
  x0 = Math.max(0, Math.min(w, Math.round(x0))); x1 = Math.max(0, Math.min(w, Math.round(x1)));
  y0 = Math.max(0, Math.min(h, Math.round(y0))); y1 = Math.max(0, Math.min(h, Math.round(y1)));
  if (x1 <= x0) x1 = Math.min(w, x0 + 1);
  if (y1 <= y0) y1 = Math.min(h, y0 + 1);
  const n = (x1 - x0) * (y1 - y0) || 1;
  const a = (y0 * W1 + x0) * 3, b = (y0 * W1 + x1) * 3, c = (y1 * W1 + x0) * 3, d = (y1 * W1 + x1) * 3;
  for (let k = 0; k < 3; k++) out[k] = (S[d + k] - S[b + k] - S[c + k] + S[a + k]) / n;
}

function normBlock(v, start, len, weight, center) {
  let m = 0;
  if (center) { for (let i = 0; i < len; i++) m += v[start + i]; m /= len; }
  let ss = 0;
  for (let i = 0; i < len; i++) { const t = v[start + i] - m; v[start + i] = t; ss += t * t; }
  const k = ss > 1e-9 ? weight / Math.sqrt(ss) : 0;
  for (let i = 0; i < len; i++) v[start + i] *= k;
  return Math.sqrt(ss / len); // block standard deviation before scaling
}

/**
 * Fingerprint of the card occupying `rect` ({x,y,w,h}, source pixels) of an integral image.
 * Returns { v: Float32Array(DIM) unit length, contrast } where contrast says whether
 * anything textured is in view (a blank table gives ~0).
 */
export function fingerprint(ii, rect) {
  const v = new Float32Array(DIM);
  const I = new Float32Array(CELLS);
  const px = [0, 0, 0];
  const cw = rect.w / GW, ch = rect.h / GH;
  for (let cy = 0; cy < GH; cy++) {
    for (let cx = 0; cx < GW; cx++) {
      const x0 = rect.x + cx * cw, y0 = rect.y + cy * ch;
      boxMean(ii, x0, y0, x0 + cw, y0 + ch, px);
      const i = cy * GW + cx;
      const r = px[0], g = px[1], b = px[2];
      const it = (r + g + b) / 3;
      I[i] = it;
      v[i] = it;
      v[CELLS + i] = r - g;
      v[2 * CELLS + i] = (r + g) / 2 - b;
    }
  }
  let o = 3 * CELLS;
  for (let cy = 0; cy < GH; cy++) for (let cx = 0; cx < GW - 1; cx++) v[o++] = I[cy * GW + cx + 1] - I[cy * GW + cx];
  for (let cy = 0; cy < GH - 1; cy++) for (let cx = 0; cx < GW; cx++) v[o++] = I[(cy + 1) * GW + cx] - I[cy * GW + cx];

  const contrast = normBlock(v, 0, CELLS, W_I, true);
  normBlock(v, CELLS, CELLS, W_O, true);
  normBlock(v, 2 * CELLS, CELLS, W_O, true);
  normBlock(v, 3 * CELLS, (GW - 1) * GH, W_D, false);
  normBlock(v, 3 * CELLS + (GW - 1) * GH, GW * (GH - 1), W_D, false);
  let ss = 0; for (let i = 0; i < DIM; i++) ss += v[i] * v[i];
  const k = ss > 0 ? 1 / Math.sqrt(ss) : 0;
  for (let i = 0; i < DIM; i++) v[i] *= k;
  return { v, contrast };
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Int8 quantisation for storage: returns { q: Int8Array, scale } with v ≈ q / scale. */
export function quantize(v) {
  let m = 0; for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]));
  const scale = m > 0 ? 127 / m : 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i] * scale);
  return { q, scale };
}

/** Largest card-shaped rectangle centred in a w×h frame, scaled by `fill`. */
export function guideRect(w, h, fill = 1) {
  let gw = w * fill, gh = gw / CARD_ASPECT;
  if (gh > h * fill) { gh = h * fill; gw = gh * CARD_ASPECT; }
  return { x: (w - gw) / 2, y: (h - gh) / 2, w: gw, h: gh };
}

// Small misalignments the matcher tries: card a bit smaller than the guide, or off-centre.
const SCALES = [1.0, 0.93, 0.86];
const SHIFTS = [[0, 0], [0.035, 0], [-0.035, 0], [0, 0.03], [0, -0.03]];

/**
 * Remove the "average card" (shared frame, text box, layout) so only what makes a card
 * different is compared. Returns a new unit vector.
 */
export function center(v, mean) {
  const out = new Float32Array(v.length);
  let ss = 0;
  for (let i = 0; i < v.length; i++) { const t = v[i] - mean[i]; out[i] = t; ss += t * t; }
  const k = ss > 0 ? 1 / Math.sqrt(ss) : 0;
  for (let i = 0; i < v.length; i++) out[i] *= k;
  return out;
}

export class Matcher {
  /**
   * @param refs   Int8Array of N*DIM quantised, centred reference fingerprints
   * @param scales Float32Array(N) quantisation scales
   * @param groups Int32Array(N) art-group id per reference (same artwork = same group)
   * @param mean   Float32Array(DIM) catalogue mean fingerprint (subtracted from queries)
   * @param opts.hub    Float32Array(N): mean similarity of each reference to its nearest other cards
   * @param opts.lambda hub penalty weight
   */
  constructor(refs, scales, groups, mean = null, { hub = null, lambda = 0 } = {}) {
    this.refs = refs; this.scales = scales; this.groups = groups; this.mean = mean;
    this.hub = hub; this.lambda = hub ? lambda : 0;   // "hubness" penalty: score − λ·(how much this card resembles all others)
    this.n = scales.length;
  }

  prep(v) { return this.mean ? center(v, this.mean) : v; }

  score(i, v) {
    const off = i * DIM, r = this.refs;
    let s = 0;
    for (let k = 0; k < DIM; k++) s += r[off + k] * v[k];
    s /= this.scales[i];
    return this.lambda ? s - this.lambda * this.hub[i] : s;
  }

  /** Best reference per art group for one fingerprint, sorted by score. */
  rank(v, candidates = null) {
    const best = new Map();
    const list = candidates || Array.from({ length: this.n }, (_, i) => i);
    for (const i of list) {
      const s = this.score(i, v), g = this.groups[i];
      const cur = best.get(g);
      if (!cur || s > cur.s) best.set(g, { i, g, s });
    }
    return [...best.values()].sort((a, b) => b.s - a.s);
  }

  /**
   * Match the card inside `rect` of integral image `ii`, trying small scale/shift variants.
   * Returns { results: [{i,g,s}] sorted, contrast, v (centre fingerprint) }.
   */
  match(ii, rect, { topK = 24, scales = SCALES, baseScale = 1 } = {}) {
    const sub = (sc, dx = 0, dy = 0) => {
      const w = rect.w * sc, h = rect.h * sc;
      return { x: rect.x + (rect.w - w) / 2 + dx * rect.w, y: rect.y + (rect.h - h) / 2 + dy * rect.h, w, h };
    };
    const base = fingerprint(ii, sub(baseScale));
    const bv = this.prep(base.v);
    const first = this.rank(bv);
    const cand = [];
    for (const r of first.slice(0, topK)) {
      // include every member of the candidate groups, not just the best one
      for (let i = 0; i < this.n; i++) if (this.groups[i] === r.g) cand.push(i);
    }
    const best = new Map(first.slice(0, topK).map(r => [r.g, r]));
    for (const sc of scales) {
      for (const [dx, dy] of SHIFTS) {
        if (sc === baseScale && dx === 0 && dy === 0) continue;
        const f = this.prep(fingerprint(ii, sub(sc, dx, dy)).v);
        for (const r of this.rank(f, cand)) {
          const cur = best.get(r.g);
          if (!cur || r.s > cur.s) best.set(r.g, r);
        }
      }
    }
    return { results: [...best.values()].sort((a, b) => b.s - a.s), contrast: base.contrast, v: bv };
  }
}
