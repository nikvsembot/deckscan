// Phone <-> PC sync through Firebase (Google sign-in + Firestore, works offline and catches up).
// Data lives under users/{uid}/coll/{printingId} = {n, f} and users/{uid}/decks/{deckId}.
import { FIREBASE_CONFIG } from './config.js';
import { store } from './store.js';

let fb = null, auth = null, fsdb = null, unsubs = [];
export const sync = {
  status: FIREBASE_CONFIG ? 'starting' : 'off', // off | starting | signedout | syncing | synced | error
  user: null, error: null,
  listeners: new Set(),
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  set(patch) { Object.assign(this, patch); for (const fn of this.listeners) fn(this); },
};

export async function initSync() {
  if (!FIREBASE_CONFIG) return;
  try {
    fb = await import('../vendor/firebase.mjs');
    const app = fb.initializeApp(FIREBASE_CONFIG);
    auth = fb.getAuth(app);
    await fb.setPersistence(auth, fb.browserLocalPersistence).catch(() => {});
    try {
      fsdb = fb.initializeFirestore(app, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
    } catch { fsdb = fb.initializeFirestore(app, {}); }
    fb.getRedirectResult(auth).catch(e => sync.set({ error: e.message }));
    fb.onAuthStateChanged(auth, user => (user ? attach(user) : detach()));
  } catch (e) {
    sync.set({ status: 'error', error: e.message });
  }
}

export async function signIn() {
  if (!auth) return;
  const provider = new fb.GoogleAuthProvider();
  try { await fb.signInWithPopup(auth, provider); }
  catch (e) {
    if (/popup/i.test(e.code || e.message)) await fb.signInWithRedirect(auth, provider);
    else sync.set({ error: e.message });
  }
}
export const signOutUser = () => auth && fb.signOut(auth);

async function attach(user) {
  sync.set({ status: 'syncing', user: { name: user.displayName, email: user.email, uid: user.uid }, error: null });
  const base = ['users', user.uid];
  const mergedKey = 'deckscan.merged.' + user.uid;
  // First sign-in on this device: add the cards already saved here to the synced collection, once.
  if (!localStorage.getItem(mergedKey)) {
    const ops = [];
    for (const [pid, e] of Object.entries(store.state.coll)) ops.push(['coll', pid, { n: fb.increment(e.n || 0), f: fb.increment(e.f || 0), t: fb.serverTimestamp() }]);
    for (const d of Object.values(store.state.decks)) ops.push(['decks', d.id, d]);
    for (let i = 0; i < ops.length; i += 400) {
      const b = fb.writeBatch(fsdb);
      for (const [col, id, data] of ops.slice(i, i + 400)) b.set(fb.doc(fsdb, ...base, col, id), data, { merge: true });
      await b.commit();
    }
    localStorage.setItem(mergedKey, '1');
  }
  store.remote = {
    pushItem: (pid, k, delta) => fb.setDoc(fb.doc(fsdb, ...base, 'coll', pid), { [k]: fb.increment(delta), t: fb.serverTimestamp() }, { merge: true })
      .catch(e => sync.set({ status: 'error', error: e.message })),
    pushDeck: d => fb.setDoc(fb.doc(fsdb, ...base, 'decks', d.id), d).catch(e => sync.set({ status: 'error', error: e.message })),
    deleteDeck: id => fb.deleteDoc(fb.doc(fsdb, ...base, 'decks', id)).catch(() => {}),
  };
  unsubs.push(fb.onSnapshot(fb.collection(fsdb, ...base, 'coll'), { includeMetadataChanges: true }, snap => {
    const coll = {};
    snap.forEach(d => {
      const x = d.data();
      const n = x.n || 0, f = x.f || 0;
      if (n + f > 0) coll[d.id] = { n, f, t: x.t?.toMillis?.() || Date.now() };
    });
    store.replaceColl(coll);
    sync.set({ status: snap.metadata.hasPendingWrites || snap.metadata.fromCache ? 'syncing' : 'synced' });
  }, e => sync.set({ status: 'error', error: e.message })));
  unsubs.push(fb.onSnapshot(fb.collection(fsdb, ...base, 'decks'), snap => {
    const decks = {};
    snap.forEach(d => { decks[d.id] = d.data(); });
    store.replaceDecks(decks);
  }, () => {}));
}

function detach() {
  for (const u of unsubs) u();
  unsubs = [];
  store.remote = null;
  sync.set({ status: 'signedout', user: null });
}
