// Live camera scanner: reads the card inside the on-screen guide ~9 times a second,
// and fires onAdd once per card when the same match holds steady for a few frames.
// A card is "locked" after it is added until it leaves the guide, so one card = one add;
// lift it out (or slide the next card in) to scan the next one, even another copy.
import { integral, dot } from '../lib/fp.js';

const W = 216, H = 302;              // working size of the sampled region
const EXPAND = 1.08;                 // sample a bit beyond the guide: card may be held slightly close
const SCAN_SCALES = [1.0, 0.93, 0.86, 0.8, 0.74];   // card at 108% … 80% of the guide
const BASE_SCALE = 1 / EXPAND;
const NEED = 3;                      // consecutive agreeing frames before adding
const INTERVAL = 110;                // ms between reads

export class Scanner {
  /**
   * @param o.video     <video> element showing the camera
   * @param o.rootEl    element the video covers (object-fit: cover)
   * @param o.guideEl   the on-screen card guide
   * @param o.matcher   Matcher
   * @param o.thresholds () => {accept, margin, release, slack}
   * @param o.onAdd     (top, res) => void
   * @param o.onState   (state, info) => void   state: idle | searching | tracking | locked
   */
  constructor(o) {
    this.o = o;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W; this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.running = false; this.paused = false;
    this.reset();
  }

  reset() { this.locked = null; this.cand = null; this.count = 0; this.away = 0; this.prevV = null; }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser can’t open the camera. Use Chrome on your phone.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    const v = this.o.video;
    v.srcObject = this.stream;
    v.muted = true; v.playsInline = true;
    await v.play();
    this.track = this.stream.getVideoTracks()[0];
    try { await this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch { /* not supported */ }
    this.running = true;
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    for (const t of this.stream?.getTracks() || []) t.stop();
    this.stream = null; this.track = null;
    if (this.o.video) this.o.video.srcObject = null;
  }

  get torchSupported() { try { return !!this.track?.getCapabilities?.().torch; } catch { return false; } }
  async setTorch(on) { await this.track.applyConstraints({ advanced: [{ torch: on }] }); }

  loop = () => {
    if (!this.running) return;
    const t0 = performance.now();
    if (!this.paused && !document.hidden) {
      try { this.step(); } catch (e) { console.error('scan step', e); }
    }
    const spent = performance.now() - t0;
    this.timer = setTimeout(this.loop, Math.max(20, INTERVAL - spent));
  };

  /** Guide rectangle (expanded) in video pixel coordinates. */
  guideInVideo() {
    const v = this.o.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const rootEl = typeof this.o.rootEl === 'function' ? this.o.rootEl() : this.o.rootEl;
    const guideEl = typeof this.o.guideEl === 'function' ? this.o.guideEl() : this.o.guideEl;
    if (!rootEl || !guideEl) return null;
    const root = rootEl.getBoundingClientRect(), g = guideEl.getBoundingClientRect();
    if (g.width < 20 || g.height < 20) return null; // guide not laid out (tab hidden, re-rendering)
    const scale = Math.max(root.width / vw, root.height / vh);
    const offX = (root.width - vw * scale) / 2, offY = (root.height - vh * scale) / 2;
    const cx = g.left - root.left + g.width / 2, cy = g.top - root.top + g.height / 2;
    const gw = g.width * EXPAND, gh = g.height * EXPAND;
    return { x: (cx - gw / 2 - offX) / scale, y: (cy - gh / 2 - offY) / scale, w: gw / scale, h: gh / scale };
  }

  step() {
    const r = this.guideInVideo();
    if (!r || !this.o.matcher) return;
    this.ctx.drawImage(this.o.video, r.x, r.y, r.w, r.h, 0, 0, W, H);
    const { data } = this.ctx.getImageData(0, 0, W, H);
    const res = this.o.matcher.match(integral(data, W, H), { x: 0, y: 0, w: W, h: H }, { scales: SCAN_SCALES, baseScale: BASE_SCALE });
    this.decide(res);
  }

  /** The add/lock state machine (also used directly by tests). */
  decide(res) {
    const T = this.o.thresholds();
    const top = res.results[0], second = res.results[1];
    const margin = top ? top.s - (second ? second.s : 0) : 0;
    const moving = this.prevV ? dot(this.prevV, res.v) < 0.8 : false;
    this.prevV = res.v;
    const present = res.contrast > 10;
    const good = !!top && present && !moving && top.s >= T.accept - T.slack && margin >= T.margin;

    if (this.locked != null) {
      if (good && top.g !== this.locked) {
        if (this.cand === top.g) this.count++; else { this.cand = top.g; this.count = 1; }
        if (this.count >= NEED) this.fire(top, res);
      } else if (!present || !top || top.s < T.release - T.slack) {
        if (++this.away >= 2) { this.locked = null; this.cand = null; this.count = 0; }
      } else {
        this.away = 0;
      }
    } else if (good) {
      if (this.cand === top.g) this.count++; else { this.cand = top.g; this.count = 1; }
      if (this.count >= NEED) this.fire(top, res);
    } else if (!moving) {
      this.count = Math.max(0, this.count - 1);
    }
    const state = this.locked != null ? 'locked' : this.count > 0 ? 'tracking' : present ? 'searching' : 'idle';
    this.o.onState?.(state, { top, second, margin, contrast: res.contrast, moving, good, results: res.results.slice(0, 3) });
  }

  fire(top, res) {
    this.locked = top.g; this.cand = null; this.count = 0; this.away = 0;
    this.o.onAdd?.(top, res);
  }
}
