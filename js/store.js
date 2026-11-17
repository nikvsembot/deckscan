// Collection, decks and settings. Saved on the device; mirrored to Firebase when signed in.
const KEY = 'deckscan.v1';

const DEFAULT_SETTINGS = {
  preferSet: 'welcometonightcityretail', // which printing to pick when Beta/Retail share artwork
  sensitivity: 1,                        // 0 strict … 3 loose
  sound: true, vibrate: true, debug: false, images: true,
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { coll: s.coll || {}, decks: s.decks || {}, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) }, session: s.session || [] };
  } catch { return { coll: {}, decks: {}, settings: { ...DEFAULT_SETTINGS }, session: [] }; }
}

export const store = {
  state: load(),
  remote: null,              // sync adapter (js/sync.js) when signed in
  listeners: new Set(),
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { this.save(); for (const fn of this.listeners) fn(this.state); },
  save() {
    try { localStorage.setItem(KEY, JSON.stringify(this.state)); } catch { /* storage full or blocked */ }
  },

  // ----- collection -----
  qty(pid) { const e = this.state.coll[pid]; return e ? (e.n || 0) + (e.f || 0) : 0; },
  /** Change the count of a printing (normal or foil) by delta. */
  add(pid, delta = 1, foil = false) {
    const e = { n: 0, f: 0, ...(this.state.coll[pid] || {}) };
    const k = foil ? 'f' : 'n';
    const applied = Math.max(-e[k], delta);
    if (!applied) return 0;
    e[k] += applied; e.t = Date.now();
    this.state = { ...this.state, coll: { ...this.state.coll } };
    if (e.n + e.f > 0) this.state.coll[pid] = e; else delete this.state.coll[pid];
    if (this.remote) this.remote.pushItem(pid, k, applied);
    this.emit();
    return applied;
  },
  /** Replace the whole collection from the synced copy. */
  replaceColl(coll) { this.state = { ...this.state, coll }; this.emit(); },

  // ----- scan session (running total of this sitting) -----
  sessionAdd(entry) { this.state = { ...this.state, session: [entry, ...this.state.session].slice(0, 500) }; this.emit(); },
  sessionUpdate(id, patch) {
    this.state = { ...this.state, session: this.state.session.map(s => (s.id === id ? { ...s, ...patch } : s)) };
    this.emit();
  },
  sessionRemove(id) { this.state = { ...this.state, session: this.state.session.filter(s => s.id !== id) }; this.emit(); },
  sessionClear() { this.state = { ...this.state, session: [] }; this.emit(); },

  // ----- decks -----
  saveDeck(deck) {
    const d = { ...deck, updated: Date.now() };
    this.state = { ...this.state, decks: { ...this.state.decks, [d.id]: d } };
    if (this.remote) this.remote.pushDeck(d);
    this.emit();
  },
  deleteDeck(id) {
    const decks = { ...this.state.decks }; delete decks[id];
    this.state = { ...this.state, decks };
    if (this.remote) this.remote.deleteDeck(id);
    this.emit();
  },
  replaceDecks(decks) { this.state = { ...this.state, decks }; this.emit(); },

  // ----- settings -----
  set(patch) { this.state = { ...this.state, settings: { ...this.state.settings, ...patch } }; this.emit(); },

  // ----- backup -----
  exportJSON() {
    return JSON.stringify({ app: 'deckscan', version: 1, exportedAt: new Date().toISOString(), coll: this.state.coll, decks: this.state.decks }, null, 1);
  },
  /** Merge a backup in (counts are added, decks overwrite by id). Returns number of printings touched. */
  importJSON(text) {
    const j = JSON.parse(text);
    if (j.app !== 'deckscan') throw new Error('Not a Deckscan backup file');
    let n = 0;
    for (const [pid, e] of Object.entries(j.coll || {})) {
      if (e.n) this.add(pid, e.n, false);
      if (e.f) this.add(pid, e.f, true);
      n++;
    }
    for (const d of Object.values(j.decks || {})) this.saveDeck(d);
    return n;
  },
  resetCollection() {
    for (const [pid, e] of Object.entries(this.state.coll)) {
      if (e.n) this.add(pid, -e.n, false);
      if (e.f) this.add(pid, -e.f, true);
    }
  },
};
