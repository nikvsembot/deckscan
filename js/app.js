import { html, render, useState, useEffect, useMemo, useRef, useCallback } from '../vendor/ui.mjs';
import {
  db, loadData, loadMatcher, cardOf, fullName, setName, setShort, price, eur, cmLink, cheapest, pricesDate,
  preferredMember, imageUrl, CM_SEARCH,
} from './data.js';
import { store } from './store.js';
import { sync, initSync, signIn, signOutUser } from './sync.js';
import { Scanner } from './scanner.js';
import { checkDeck, ownedByCard, deckNeeds } from './decks.js';

// ---------------------------------------------------------------- helpers
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const COLORS = { Red: '#ff4655', Blue: '#3d8bff', Green: '#2fd27a', Yellow: '#ffd23f' };
const TYPES = ['Legend', 'Unit', 'Program', 'Gear'];
const cx = (...a) => a.filter(Boolean).join(' ');

function useStore() {
  const [s, setS] = useState(store.state);
  useEffect(() => store.subscribe(setS), []);
  return s;
}
function useSync() {
  const [, force] = useState(0);
  useEffect(() => sync.on(() => force(x => x + 1)), []);
  return sync;
}

let toastFn = () => {};
export const toast = (msg, opts) => toastFn(msg, opts);

let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'square'; o.frequency.value = 1320;
    g.gain.setValueAtTime(0.05, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.09);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.1);
  } catch { /* no audio */ }
}

const Icon = ({ name, size = 22 }) => {
  const p = {
    scan: 'M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M7 12h10',
    library: 'M5 4h4v16H5zM10 4h4v16h-4zM15.5 4.5l3.8 1-3.6 14.5-3.8-1',
    decks: 'M7 3h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM3 7v12a2 2 0 0 0 2 2h10',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    torch: 'M9 2h6l-1 7h3l-8 13 2-9H7z',
    pause: 'M8 5v14M16 5v14',
    play: 'M7 4l13 8-13 8z',
    plus: 'M12 5v14M5 12h14',
    minus: 'M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
    ext: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
    check: 'M5 12l5 5L20 7',
    star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z',
  }[name];
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${p} /></svg>`;
};

// ---------------------------------------------------------------- shared UI
function Thumb({ pid, big = false }) {
  const ref = useRef(null);
  const [src, setSrc] = useState(null);
  const [tries, setTries] = useState(0);
  const on = store.state.settings.images;
  useEffect(() => {
    if (!on || !pid) return;
    let alive = true;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      const u = await imageUrl(pid);
      if (alive) setSrc(u);
    }, { rootMargin: '200px' });
    if (ref.current) io.observe(ref.current);
    return () => { alive = false; io.disconnect(); };
  }, [pid, on, tries]);
  const c = cardOf(pid);
  return html`<div ref=${ref} class=${cx('thumb', big && 'big')} style=${{ '--c': COLORS[c?.c] || '#666' }}>
    ${src ? html`<img src=${src} alt=${fullName(c)} loading="lazy" onError=${() => { setSrc(null); if (tries < 1) setTries(tries + 1); }} />`
      : html`<span>${(c?.n || '?').slice(0, 2)}</span>`}
  </div>`;
}

function Sheet({ onClose, children, title }) {
  useEffect(() => {
    const k = e => e.key === 'Escape' && onClose();
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  return html`<div class="sheet-bg" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="sheet" role="dialog" aria-label=${title || 'Details'}>
      <div class="sheet-head"><b>${title}</b><button class="icon-btn" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button></div>
      <div class="sheet-body">${children}</div>
    </div>
  </div>`;
}

function Confirm({ text, yes = 'Yes', onYes, onClose }) {
  return html`<${Sheet} title="Are you sure?" onClose=${onClose}>
    <p>${text}</p>
    <div class="row gap"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn danger" onClick=${() => { onYes(); onClose(); }}>${yes}</button></div>
  <//>`;
}

function Stepper({ value, onChange, min = 0, max = 99, label }) {
  return html`<span class="stepper" aria-label=${label}>
    <button onClick=${() => onChange(-1)} disabled=${value <= min} aria-label="Fewer"><${Icon} name="minus" size="16" /></button>
    <b>${value}</b>
    <button onClick=${() => onChange(1)} disabled=${value >= max} aria-label="More"><${Icon} name="plus" size="16" /></button>
  </span>`;
}

const Dot = ({ color }) => html`<i class="dot" style=${{ background: COLORS[color] || '#888' }} title=${color}></i>`;

// ---------------------------------------------------------------- card search (manual add, deck builder)
function filterCards({ q = '', colors = [], types = [] }) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return db.cards.filter(c => {
    if (colors.length && !colors.includes(c.c)) return false;
    if (types.length && !types.includes(c.t)) return false;
    if (!words.length) return true;
    const hay = `${c.n} ${c.s} ${c.tags.join(' ')} ${c.t}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

function ChipToggle({ options, value, onChange, render: r = x => x }) {
  return html`<div class="chips">${options.map(o => html`<button class=${cx('chip', value.includes(o) && 'on')}
    onClick=${() => onChange(value.includes(o) ? value.filter(x => x !== o) : [...value, o])}>${r(o)}</button>`)}</div>`;
}

// ---------------------------------------------------------------- card detail sheet
function CardSheet({ cardId, focus, onClose }) {
  const s = useStore();
  const c = db.cardById.get(cardId);
  const prs = db.prByCard.get(cardId) || [];
  const [sel, setSel] = useState(focus || prs[0]?.id);
  if (!c) return null;
  return html`<${Sheet} title=${fullName(c)} onClose=${onClose}>
    <div class="card-detail">
      <${Thumb} pid=${sel} big />
      <div class="meta">
        <div><${Dot} color=${c.c} /> ${c.c} ${c.t}</div>
        <div class="muted">${[c.cost != null && `Cost ${c.cost}`, c.pw != null && `Power ${c.pw}`, c.ram != null && `RAM ${c.ram}`].filter(Boolean).join(' · ')}</div>
        <div class="muted small">${c.tags.join(' · ')}</div>
        <div class="big-num">${eur(price(sel))}</div>
        <a class="btn small" href=${cmLink(sel)} target="_blank" rel="noopener">Cardmarket <${Icon} name="ext" size="14" /></a>
      </div>
    </div>
    <h4>Versions</h4>
    <div class="list">
      ${prs.map(p => {
        const e = s.coll[p.id] || {};
        return html`<div class=${cx('pr-row', sel === p.id && 'sel')} onClick=${() => setSel(p.id)}>
          <div class="grow"><b>${setShort(p.set)}</b> <span class="muted">#${p.no}</span><div class="small muted">${p.r} · ${eur(price(p.id))}${price(p.id, true) !== price(p.id) ? ` · foil ${eur(price(p.id, true))}` : ''}</div></div>
          <div class="col-end" onClick=${ev => ev.stopPropagation()}>
            <${Stepper} label="Normal copies" value=${e.n || 0} onChange=${d => store.add(p.id, d, false)} />
            <span class="foil-step"><${Icon} name="star" size="13" /><${Stepper} label="Foil copies" value=${e.f || 0} onChange=${d => store.add(p.id, d, true)} /></span>
          </div>
        </div>`;
      })}
    </div>
  <//>`;
}

// ---------------------------------------------------------------- manual add sheet
function ManualAdd({ onPick, onClose }) {
  const [q, setQ] = useState('');
  const [card, setCard] = useState(null);
  const res = useMemo(() => filterCards({ q }).slice(0, 60), [q]);
  return html`<${Sheet} title=${card ? fullName(card) : 'Add a card by name'} onClose=${onClose}>
    ${!card ? html`
      <input class="input" autofocus placeholder="Card name…" value=${q} onInput=${e => setQ(e.target.value)} />
      <div class="list">${res.map(c => html`<button class="list-row" onClick=${() => setCard(c)}><${Dot} color=${c.c} /> <span class="grow">${fullName(c)}</span><span class="muted small">${c.t}</span></button>`)}</div>`
    : html`
      <p class="muted small">Pick the version you have:</p>
      <div class="list">${(db.prByCard.get(card.id) || []).map(p => html`<button class="list-row" onClick=${() => onPick(p.id)}>
        <span class="grow"><b>${setShort(p.set)}</b> #${p.no} <span class="muted small">${p.r}</span></span><b>${eur(price(p.id))}</b></button>`)}</div>
      <button class="btn" onClick=${() => setCard(null)}>Back</button>`}
  <//>`;
}

// ---------------------------------------------------------------- SCAN
function ScanView() {
  const s = useStore();
  const rootRef = useRef(null), videoRef = useRef(null), guideRef = useRef(null), scRef = useRef(null);
  const [cam, setCam] = useState('off');
  const [err, setErr] = useState('');
  const [st, setSt] = useState({ state: 'idle', info: null });
  const [paused, setPaused] = useState(false);
  const [torch, setTorch] = useState(false);
  const [flash, setFlash] = useState(0);
  const [manual, setManual] = useState(false);
  const [editing, setEditing] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const session = s.session;
  const total = session.reduce((a, e) => a + (price(e.pid, e.foil) || 0), 0);
  const last = session[0];

  const addPid = useCallback((pid, how) => {
    store.add(pid, 1, false);
    const entry = { id: uid(), pid, foil: false, t: Date.now(), how };
    store.sessionAdd(entry);
    const st = store.state.settings;
    if (st.sound) beep();
    if (st.vibrate) navigator.vibrate?.(40);
    setFlash(f => f + 1);
  }, []);

  const start = async () => {
    setErr(''); setCam('starting');
    try {
      const matcher = await loadMatcher();
      const sc = new Scanner({
        video: videoRef.current, rootEl: () => rootRef.current, guideEl: () => guideRef.current, matcher,
        thresholds: () => {
          const t = db.thresholds || { accept: 0.5, margin: 0.06, release: 0.4 };
          const sens = store.state.settings.sensitivity;
          return { accept: t.accept, margin: Math.max(0.02, t.margin - sens * 0.01), release: t.release, slack: sens * 0.04 };
        },
        onAdd: top => addPid(preferredMember(db.groupMembers.get(top.g), store.state.settings.preferSet), 'scan'),
        onState: (state, info) => setSt({ state, info }),
      });
      scRef.current = sc;
      window.__scanner = sc; // handy for debugging from the browser console
      await sc.start();
      setCam('on');
    } catch (e) {
      setCam('error');
      setErr(e.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow the camera for this site in Chrome’s site settings, then try again.' : (e.message || String(e)));
    }
  };
  const stop = () => { scRef.current?.stop(); scRef.current = null; setCam('off'); setTorch(false); };

  useEffect(() => {
    const vis = () => { if (document.hidden && scRef.current) stop(); };
    document.addEventListener('visibilitychange', vis);
    return () => { document.removeEventListener('visibilitychange', vis); stop(); };
  }, []);
  useEffect(() => { if (scRef.current) scRef.current.paused = paused; }, [paused]);

  const undo = e => { store.add(e.pid, -1, e.foil); store.sessionRemove(e.id); };
  const switchTo = (e, pid) => { if (pid === e.pid) return; store.add(e.pid, -1, e.foil); store.add(pid, 1, e.foil); store.sessionUpdate(e.id, { pid }); };
  const toggleFoil = e => { store.add(e.pid, -1, e.foil); store.add(e.pid, 1, !e.foil); store.sessionUpdate(e.id, { foil: !e.foil }); };

  const lastCard = last && cardOf(last.pid);
  const versions = last ? db.prByCard.get(lastCard?.id) || [] : [];
  const dbg = s.settings.debug && st.info;
  const collTotal = useMemo(() => Object.entries(s.coll).reduce((a, [pid, e]) => a + (e.n || 0) * (price(pid) || 0) + (e.f || 0) * (price(pid, true) || 0), 0), [s.coll]);

  return html`<div class="scan">
    <div class="hud">
      <div><div class="label">This session</div><div class="total">${eur(total)}</div><div class="small muted">${session.length} card${session.length === 1 ? '' : 's'}</div></div>
      <div class="right"><div class="label">Collection</div><div class="sub-total">${eur(collTotal)}</div>
        ${session.length > 0 && html`<button class="link small" onClick=${() => setConfirmClear(true)}>New session</button>`}</div>
    </div>

    <div class="cam" ref=${rootRef}>
      <video ref=${videoRef} playsinline muted></video>
      <div ref=${guideRef} class=${cx('guide', `st-${st.state}`, cam !== 'on' && 'dim')}>
        ${flash > 0 && html`<i class="flash" key=${'f' + flash}></i>`}
        <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
        ${cam === 'on' && html`<div class="guide-hint">${paused ? 'Paused' : st.state === 'locked' ? 'Added ✓ — next card' : st.state === 'tracking' ? 'Hold still…' : 'Fit one card in the frame'}</div>`}
      </div>
      ${cam !== 'on' && html`<div class="cam-cta">
        ${cam === 'starting' ? html`<div class="spinner"></div><p>Starting camera…</p>`
          : html`<button class="btn primary big" onClick=${start}><${Icon} name="scan" /> Start scanning</button>
          ${err && html`<p class="err">${err}</p>`}
          <p class="small muted">Hold cards one at a time inside the frame. Each card is added automatically. Lift it out and put the next one in.</p>`}
      </div>`}
      ${cam === 'on' && html`<div class="cam-tools">
        ${scRef.current?.torchSupported && html`<button class=${cx('round', torch && 'on')} aria-label="Flashlight" onClick=${async () => { try { await scRef.current.setTorch(!torch); setTorch(!torch); } catch {} }}><${Icon} name="torch" /></button>`}
        <button class="round" aria-label=${paused ? 'Resume' : 'Pause'} onClick=${() => setPaused(!paused)}><${Icon} name=${paused ? 'play' : 'pause'} /></button>
        <button class="round" aria-label="Stop camera" onClick=${stop}><${Icon} name="x" /></button>
      </div>`}
      ${dbg && html`<div class="debug">${(st.info.results || []).map(r => html`<div>${fullName(cardOf(db.fpIds[r.i]))} <b>${r.s.toFixed(3)}</b></div>`)}
        <div>contrast ${st.info.contrast.toFixed(0)} · margin ${st.info.margin.toFixed(3)} ${st.info.moving ? '· moving' : ''} · ${st.state}</div></div>`}
    </div>

    <div class="tray">
      ${last ? html`<div class="last" key=${last.id}>
        <div class="row">
          <div onClick=${() => setEditing(lastCard.id)}><${Thumb} pid=${last.pid} /></div>
          <div class="grow" onClick=${() => setEditing(lastCard.id)}>
            <div class="name">${fullName(lastCard)}</div>
            <div class="small muted">${setShort(db.prById.get(last.pid).set)} #${db.prById.get(last.pid).no} · ${db.prById.get(last.pid).r}</div>
          </div>
          <div class="price">${eur(price(last.pid, last.foil))}</div>
        </div>
        <div class="row gap wrap">
          ${versions.length > 1 && versions.slice(0, 8).map(p => html`<button class=${cx('chip', p.id === last.pid && 'on')} onClick=${() => switchTo(last, p.id)}>${setShort(p.set)} ${p.no} · ${eur(price(p.id, last.foil))}</button>`)}
        </div>
        <div class="row gap">
          <button class=${cx('chip', last.foil && 'on')} onClick=${() => toggleFoil(last)}><${Icon} name="star" size="14" /> Foil</button>
          <span class="grow"></span>
          <button class="btn small" onClick=${() => undo(last)}>Undo</button>
        </div>
      </div>` : html`<p class="muted center small">Scanned cards appear here with their Cardmarket price.</p>`}
      <div class="row gap">
        <button class="btn grow" onClick=${() => setManual(true)}><${Icon} name="search" size="18" /> Add by name</button>
      </div>
      ${session.length > 1 && html`<div class="session-list">${session.slice(1, 40).map(e => {
        const c = cardOf(e.pid), p = db.prById.get(e.pid);
        return html`<div class="s-row"><span class="grow" onClick=${() => setEditing(c.id)}>${fullName(c)} <span class="muted small">${setShort(p.set)} #${p.no}${e.foil ? ' ★' : ''}</span></span>
          <b>${eur(price(e.pid, e.foil))}</b><button class="icon-btn" aria-label="Remove" onClick=${() => undo(e)}><${Icon} name="x" size="16" /></button></div>`;
      })}</div>`}
    </div>
    ${manual && html`<${ManualAdd} onClose=${() => setManual(false)} onPick=${pid => { addPid(pid, 'manual'); setManual(false); }} />`}
    ${editing && html`<${CardSheet} cardId=${editing} focus=${last?.pid} onClose=${() => setEditing(null)} />`}
    ${confirmClear && html`<${Confirm} text="Start a new session? The running total resets to €0. Your cards stay in the collection." yes="New session" onYes=${() => store.sessionClear()} onClose=${() => setConfirmClear(false)} />`}
  </div>`;
}

// ---------------------------------------------------------------- LIBRARY
function LibraryView() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [colors, setColors] = useState([]);
  const [types, setTypes] = useState([]);
  const [owned, setOwned] = useState(true);
  const [sort, setSort] = useState('value');
  const [setF, setSetF] = useState('');
  const [open, setOpen] = useState(null);

  const totals = useMemo(() => {
    let v = 0, n = 0, u = 0;
    for (const [pid, e] of Object.entries(s.coll)) {
      const k = (e.n || 0) + (e.f || 0); if (!k || !db.prById.has(pid)) continue;
      n += k; u++; v += (e.n || 0) * (price(pid) || 0) + (e.f || 0) * (price(pid, true) || 0);
    }
    return { v, n, u };
  }, [s.coll]);

  const rows = useMemo(() => {
    const ids = new Set(filterCards({ q, colors, types }).map(c => c.id));
    let list = db.printings.filter(p => ids.has(p.c) && (!setF || p.set === setF));
    if (owned) list = list.filter(p => store.qty(p.id) > 0);
    const val = p => { const e = s.coll[p.id] || {}; return (e.n || 0) * (price(p.id) || 0) + (e.f || 0) * (price(p.id, true) || 0); };
    const by = {
      value: (a, b) => val(b) - val(a) || (price(b.id) || 0) - (price(a.id) || 0),
      price: (a, b) => (price(b.id) || 0) - (price(a.id) || 0),
      name: (a, b) => fullName(cardOf(a.id)).localeCompare(fullName(cardOf(b.id))),
      number: (a, b) => db.setOrder.indexOf(a.set) - db.setOrder.indexOf(b.set) || parseInt(a.no.replace(/\D/g, '')) - parseInt(b.no.replace(/\D/g, '')),
      recent: (a, b) => (s.coll[b.id]?.t || 0) - (s.coll[a.id]?.t || 0),
    }[sort];
    return list.sort(by);
  }, [s.coll, q, colors, types, owned, sort, setF]);

  return html`<div class="page">
    <div class="stat-row">
      <div><div class="label">Collection value</div><div class="total">${eur(totals.v)}</div></div>
      <div class="right small muted">${totals.n} cards<br />${totals.u} different<br />prices ${pricesDate()}</div>
    </div>
    <input class="input" type="search" placeholder="Search cards, tags…" value=${q} onInput=${e => setQ(e.target.value)} />
    <${ChipToggle} options=${Object.keys(COLORS)} value=${colors} onChange=${setColors} render=${c => html`<${Dot} color=${c} /> ${c}`} />
    <${ChipToggle} options=${TYPES} value=${types} onChange=${setTypes} />
    <div class="row gap wrap">
      <button class=${cx('chip', owned && 'on')} onClick=${() => setOwned(!owned)}>${owned ? 'My cards' : 'All cards'}</button>
      <select class="select" value=${setF} onChange=${e => setSetF(e.target.value)} aria-label="Set">
        <option value="">All sets</option>${db.setOrder.map(k => html`<option value=${k}>${setName(k)}</option>`)}
      </select>
      <select class="select" value=${sort} onChange=${e => setSort(e.target.value)} aria-label="Sort">
        <option value="value">Sort: value</option><option value="price">Sort: price</option><option value="name">Sort: name</option><option value="number">Sort: set & number</option><option value="recent">Sort: recently added</option>
      </select>
    </div>
    ${!rows.length && html`<p class="muted center">${owned && !Object.keys(s.coll).length ? 'No cards yet. Scan some on the Scan tab.' : 'No cards match.'}</p>`}
    <div class="list">
      ${rows.slice(0, 400).map(p => {
        const c = cardOf(p.id), e = s.coll[p.id] || {}, k = (e.n || 0) + (e.f || 0);
        return html`<button class="lib-row" onClick=${() => setOpen({ card: c.id, pid: p.id })}>
          <${Thumb} pid=${p.id} />
          <div class="grow left">
            <div class="name">${fullName(c)}</div>
            <div class="small muted">${setShort(p.set)} #${p.no} · ${p.r}</div>
            <div class="small">${eur(price(p.id))} each</div>
          </div>
          <div class="col-end">
            ${k > 0 ? html`<span class="qty">×${e.n || 0}${e.f ? html` <span class="foil">+${e.f}★</span>` : ''}</span>` : html`<span class="muted small">—</span>`}
            ${k > 0 && html`<b>${eur((e.n || 0) * (price(p.id) || 0) + (e.f || 0) * (price(p.id, true) || 0))}</b>`}
          </div>
        </button>`;
      })}
    </div>
    ${rows.length > 400 && html`<p class="muted center small">Showing 400 of ${rows.length}. Search to narrow down.</p>`}
    ${open && html`<${CardSheet} cardId=${open.card} focus=${open.pid} onClose=${() => setOpen(null)} />`}
  </div>`;
}

// ---------------------------------------------------------------- DECKS
function DecksView() {
  const s = useStore();
  const [edit, setEdit] = useState(null);
  const decks = Object.values(s.decks).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (edit && s.decks[edit]) return html`<${DeckEditor} deck=${s.decks[edit]} onBack=${() => setEdit(null)} />`;
  const create = () => {
    const d = { id: uid(), name: `Deck ${decks.length + 1}`, legends: [], main: {}, created: Date.now() };
    store.saveDeck(d); setEdit(d.id);
  };
  return html`<div class="page">
    <div class="row"><h2 class="grow">Decks</h2><button class="btn primary" onClick=${create}><${Icon} name="plus" size="18" /> New deck</button></div>
    ${!decks.length && html`<p class="muted">Build decks from your library. The app checks the deck rules, shows which cards you own, and adds up what the missing cards cost on Cardmarket.</p>`}
    <div class="list">${decks.map(d => {
      const chk = checkDeck(d), need = deckNeeds(d, s.coll);
      return html`<button class="deck-row" onClick=${() => setEdit(d.id)}>
        <div class="grow left"><div class="name">${d.name}</div>
          <div class="small muted">${d.legends.map(id => db.cardById.get(id)?.n).filter(Boolean).join(' · ') || 'No Legends yet'}</div>
          <div class="small">${chk.mainCount} cards · ${need.ownedCopies}/${need.totalCopies} owned</div></div>
        <div class="col-end">${chk.legal ? html`<span class="ok-badge"><${Icon} name="check" size="14" /> Legal</span>` : html`<span class="bad-badge">${chk.problems} issue${chk.problems === 1 ? '' : 's'}</span>`}
          ${need.missingCost > 0 && html`<span class="small">Missing ${eur(need.missingCost)}</span>`}</div>
      </button>`;
    })}</div>
  </div>`;
}

function DeckEditor({ deck, onBack }) {
  const s = useStore();
  const [q, setQ] = useState('');
  const [types, setTypes] = useState([]);
  const [colors, setColors] = useState([]);
  const [fits, setFits] = useState(true);
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [view, setView] = useState('deck');
  const [del, setDel] = useState(false);
  const [open, setOpen] = useState(null);
  const chk = checkDeck(deck);
  const need = deckNeeds(deck, s.coll);
  const own = id => ownedByCard(id, s.coll);
  const save = patch => store.saveDeck({ ...deck, ...patch });
  const setCount = (id, d) => {
    const main = { ...deck.main };
    main[id] = Math.max(0, Math.min(3, (main[id] || 0) + d));
    if (!main[id]) delete main[id];
    save({ main });
  };
  const addCard = c => {
    if (c.t === 'Legend') {
      if (deck.legends.includes(c.id)) return toast('That Legend is already in the deck');
      if (deck.legends.length >= 3) return toast('A deck has exactly 3 Legends — remove one first');
      save({ legends: [...deck.legends, c.id] });
    } else if ((deck.main[c.id] || 0) >= 3) toast('Max 3 copies of a card');
    else setCount(c.id, 1);
  };
  const results = useMemo(() => {
    let r = filterCards({ q, types, colors });
    if (fits) r = r.filter(c => c.t === 'Legend' || chk.fits(c));
    if (ownedOnly) r = r.filter(c => own(c.id) > 0);
    return r.slice(0, 80);
  }, [q, types, colors, fits, ownedOnly, deck, s.coll]);

  const mainCards = Object.entries(deck.main).map(([id, n]) => ({ c: db.cardById.get(id), n })).filter(x => x.c)
    .sort((a, b) => TYPES.indexOf(a.c.t) - TYPES.indexOf(b.c.t) || (a.c.cost ?? 0) - (b.c.cost ?? 0) || a.c.n.localeCompare(b.c.n));

  return html`<div class="page">
    <div class="row gap"><button class="btn small" onClick=${onBack}>‹ Decks</button>
      <input class="input grow" value=${deck.name} onChange=${e => save({ name: e.target.value || 'Deck' })} aria-label="Deck name" />
      <button class="icon-btn" aria-label="Delete deck" onClick=${() => setDel(true)}><${Icon} name="x" /></button></div>

    <div class="checks">
      ${chk.checks.map(x => html`<div class=${cx('check', x.ok ? 'ok' : 'bad')}><${Icon} name=${x.ok ? 'check' : 'x'} size="14" /> ${x.text}</div>`)}
      <div class="check"><b>${need.ownedCopies}/${need.totalCopies}</b> cards owned${need.missingCost > 0 ? html` · missing ones cost <b>${eur(need.missingCost)}</b>` : ''}</div>
    </div>

    <div class="tabs2">
      <button class=${cx(view === 'deck' && 'on')} onClick=${() => setView('deck')}>Deck (${chk.mainCount})</button>
      <button class=${cx(view === 'add' && 'on')} onClick=${() => setView('add')}>Add cards</button>
      <button class=${cx(view === 'missing' && 'on')} onClick=${() => setView('missing')}>Missing (${need.missing.length})</button>
    </div>

    ${view === 'deck' && html`
      <h4>Legends <span class="muted small">${chk.ramText}</span></h4>
      <div class="list">${deck.legends.map(id => { const c = db.cardById.get(id); return c && html`<div class="deck-card">
        <${Dot} color=${c.c} /><span class="grow" onClick=${() => setOpen(id)}>${fullName(c)} <span class="muted small">RAM ${c.ram}</span></span>
        <span class=${cx('own', own(id) >= 1 ? 'yes' : 'no')}>${own(id) >= 1 ? 'owned' : 'missing'}</span>
        <button class="icon-btn" aria-label="Remove" onClick=${() => save({ legends: deck.legends.filter(x => x !== id) })}><${Icon} name="x" size="16" /></button></div>`; })}
        ${deck.legends.length < 3 && html`<button class="btn small" onClick=${() => { setTypes(['Legend']); setView('add'); }}>+ Add Legend (${3 - deck.legends.length} left)</button>`}
      </div>
      ${TYPES.slice(1).map(t => { const list = mainCards.filter(x => x.c.t === t); return list.length > 0 && html`
        <h4>${t}s <span class="muted small">${list.reduce((a, x) => a + x.n, 0)}</span></h4>
        <div class="list">${list.map(({ c, n }) => html`<div class=${cx('deck-card', !chk.fits(c) && 'illegal')}>
          <${Dot} color=${c.c} /><span class="grow" onClick=${() => setOpen(c.id)}>${fullName(c)} <span class="muted small">${c.cost != null ? `cost ${c.cost} · ` : ''}RAM ${c.ram ?? '–'}</span></span>
          <span class=${cx('own', own(c.id) >= n ? 'yes' : 'no')}>${Math.min(own(c.id), n)}/${n}</span>
          <${Stepper} value=${n} max=${3} label="Copies" onChange=${d => setCount(c.id, d)} /></div>`)}</div>`; })}
      ${!mainCards.length && html`<p class="muted">No cards yet. Tap “Add cards”.</p>`}`}

    ${view === 'add' && html`
      <input class="input" type="search" placeholder="Search…" value=${q} onInput=${e => setQ(e.target.value)} />
      <${ChipToggle} options=${TYPES} value=${types} onChange=${setTypes} />
      <${ChipToggle} options=${Object.keys(COLORS)} value=${colors} onChange=${setColors} render=${c => html`<${Dot} color=${c} /> ${c}`} />
      <div class="row gap wrap">
        <button class=${cx('chip', fits && 'on')} onClick=${() => setFits(!fits)}>Fits my Legends</button>
        <button class=${cx('chip', ownedOnly && 'on')} onClick=${() => setOwnedOnly(!ownedOnly)}>Only cards I own</button>
      </div>
      <div class="list">${results.map(c => {
        const inDeck = c.t === 'Legend' ? (deck.legends.includes(c.id) ? 1 : 0) : deck.main[c.id] || 0;
        return html`<div class="deck-card"><${Dot} color=${c.c} />
          <span class="grow" onClick=${() => setOpen(c.id)}>${fullName(c)}<div class="small muted">${c.t} · ${c.cost != null ? `cost ${c.cost} · ` : ''}RAM ${c.ram ?? '–'} · own ${own(c.id)}</div></span>
          ${inDeck > 0 && html`<span class="qty">×${inDeck}</span>`}
          <button class="icon-btn add" aria-label="Add to deck" onClick=${() => addCard(c)}><${Icon} name="plus" /></button></div>`;
      })}</div>`}

    ${view === 'missing' && html`
      ${!need.missing.length ? html`<p class="muted">You own every card in this deck.</p>` : html`
      <p class="small muted">Cheapest version on Cardmarket (trend price) for each card you still need.</p>
      <div class="list">${need.missing.map(m => html`<div class="deck-card">
        <${Dot} color=${m.card.c} /><span class="grow">${fullName(m.card)}<div class="small muted">need ${m.need} more${m.cheap ? ` · ${eur(m.cheap.v)} each (${setShort(db.prById.get(m.cheap.pid).set)})` : ''}</div></span>
        <b>${eur(m.cost)}</b>
        <a class="icon-btn" aria-label="Open on Cardmarket" href=${m.cheap ? cmLink(m.cheap.pid) : CM_SEARCH(m.card.n)} target="_blank" rel="noopener"><${Icon} name="ext" size="18" /></a></div>`)}</div>
      <div class="stat-row"><span>Total to complete</span><b class="total">${eur(need.missingCost)}</b></div>`}`}

    ${open && html`<${CardSheet} cardId=${open} onClose=${() => setOpen(null)} />`}
    ${del && html`<${Confirm} text=${`Delete “${deck.name}”? This can't be undone.`} yes="Delete" onYes=${() => { store.deleteDeck(deck.id); onBack(); }} onClose=${() => setDel(false)} />`}
  </div>`;
}

// ---------------------------------------------------------------- SETTINGS
function SettingsView({ installEvt }) {
  const s = useStore();
  const sy = useSync();
  const st = s.settings;
  const fileRef = useRef(null);
  const [reset, setReset] = useState(false);
  const fpSets = useMemo(() => db.setOrder.filter(k => db.printings.some(p => p.set === k)), []);
  const exportFile = () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `deckscan-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const importFile = async e => {
    const f = e.target.files[0]; if (!f) return;
    try { const n = store.importJSON(await f.text()); toast(`Imported ${n} cards`); }
    catch (err) { toast('Import failed: ' + err.message); }
    e.target.value = '';
  };
  return html`<div class="page settings">
    <h2>Settings</h2>
    ${installEvt && html`<button class="btn primary" onClick=${() => installEvt.prompt()}>Install app on this device</button>`}

    <section><h4>Sync (phone ↔ PC)</h4>
      ${sy.status === 'off' ? html`<p class="muted small">Sync isn’t set up yet. Cards are saved on this device.</p>`
        : sy.user ? html`<p>Signed in as <b>${sy.user.email}</b></p>
          <p class="small ${sy.status === 'error' ? 'err' : 'muted'}">${{ syncing: 'Syncing…', synced: 'Synced ✓', error: 'Sync problem: ' + sy.error }[sy.status] || sy.status}</p>
          <button class="btn" onClick=${signOutUser}>Sign out</button>`
        : html`<p class="muted small">Sign in with the same Google account on your phone and your PC to share one collection.</p>
          <button class="btn primary" onClick=${signIn}>Sign in with Google</button>${sy.error && html`<p class="err small">${sy.error}</p>`}`}
    </section>

    <section><h4>Scanner</h4>
      <label class="field">When Beta and Retail look the same, pick
        <select class="select" value=${st.preferSet} onChange=${e => store.set({ preferSet: e.target.value })}>${fpSets.map(k => html`<option value=${k}>${setName(k)}</option>`)}</select></label>
      <label class="field">Sensitivity <span class="muted small">(raise it if cards aren’t picked up, lower it if wrong cards are added)</span>
        <input type="range" min="0" max="3" step="0.5" value=${st.sensitivity} onInput=${e => store.set({ sensitivity: +e.target.value })} /></label>
      <label class="switch"><input type="checkbox" checked=${st.sound} onChange=${e => store.set({ sound: e.target.checked })} /> Beep on scan</label>
      <label class="switch"><input type="checkbox" checked=${st.vibrate} onChange=${e => store.set({ vibrate: e.target.checked })} /> Vibrate on scan</label>
      <label class="switch"><input type="checkbox" checked=${st.images} onChange=${e => store.set({ images: e.target.checked })} /> Show card pictures</label>
      <label class="switch"><input type="checkbox" checked=${st.debug} onChange=${e => store.set({ debug: e.target.checked })} /> Show match scores while scanning</label>
    </section>

    <section><h4>Prices</h4>
      <p class="small muted">Cardmarket “price trend” in euros, from Cardmarket’s daily price guide (updated ${pricesDate()}). Foil copies use the foil trend when Cardmarket has one.</p>
    </section>

    <section><h4>Backup</h4>
      <div class="row gap wrap">
        <button class="btn" onClick=${exportFile}>Export backup</button>
        <button class="btn" onClick=${() => fileRef.current.click()}>Import backup</button>
        <input ref=${fileRef} type="file" accept="application/json,.json" hidden onChange=${importFile} />
        <button class="btn danger" onClick=${() => setReset(true)}>Clear collection</button>
      </div>
    </section>

    <section class="small muted"><h4>About</h4>
      <p>Unofficial fan tool for personal use. Card data and pictures come from the official Cyberpunk TCG card database. Prices come from Cardmarket’s public price guide. Not affiliated with WeirdCo, CD PROJEKT RED or Cardmarket.</p>
    </section>
    ${reset && html`<${Confirm} text="Remove every card from your collection? Decks are kept. This can't be undone (export a backup first)." yes="Clear collection" onYes=${() => { store.resetCollection(); toast('Collection cleared'); }} onClose=${() => setReset(false)} />`}
  </div>`;
}

// ---------------------------------------------------------------- shell
const TABS = [['scan', 'Scan'], ['library', 'Library'], ['decks', 'Decks'], ['settings', 'Settings']];

function App() {
  const [ready, setReady] = useState(false);
  const [fail, setFail] = useState('');
  const [tab, setTab] = useState(() => (TABS.some(t => t[0] === location.hash.slice(1)) ? location.hash.slice(1) : 'scan'));
  const [msg, setMsg] = useState(null);
  const [installEvt, setInstallEvt] = useState(null);

  useEffect(() => {
    loadData().then(() => setReady(true)).catch(e => setFail(e.message));
    initSync();
    const h = () => { const t = location.hash.slice(1); if (TABS.some(x => x[0] === t)) setTab(t); };
    addEventListener('hashchange', h);
    const bip = e => { e.preventDefault(); setInstallEvt(e); };
    addEventListener('beforeinstallprompt', bip);
    let timer;
    toastFn = (m, o = {}) => { setMsg(m); clearTimeout(timer); timer = setTimeout(() => setMsg(null), o.ms || 2600); };
    return () => { removeEventListener('hashchange', h); removeEventListener('beforeinstallprompt', bip); };
  }, []);
  const go = t => { setTab(t); history.replaceState(null, '', '#' + t); };

  if (fail) return html`<div class="page"><h2>Couldn’t load card data</h2><p class="err">${fail}</p><button class="btn" onClick=${() => location.reload()}>Retry</button></div>`;
  if (!ready) return html`<div class="boot"><div class="spinner"></div><p>Loading cards & prices…</p></div>`;
  return html`<div class="app">
    <main class=${'tab-' + tab}>
      ${tab === 'scan' && html`<${ScanView} />`}
      ${tab === 'library' && html`<${LibraryView} />`}
      ${tab === 'decks' && html`<${DecksView} />`}
      ${tab === 'settings' && html`<${SettingsView} installEvt=${installEvt} />`}
    </main>
    <nav class="tabbar">${TABS.map(([k, label]) => html`<button class=${cx(tab === k && 'on')} onClick=${() => go(k)} aria-current=${tab === k ? 'page' : null}><${Icon} name=${k} /><span>${label}</span></button>`)}</nav>
    ${msg && html`<div class="toast" role="status">${msg}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('app'));
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
