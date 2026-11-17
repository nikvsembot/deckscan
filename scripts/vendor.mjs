// Bundles the app's few libraries into /vendor so the app has no CDN dependencies.
import { build } from 'esbuild';
import fs from 'node:fs/promises';

await fs.mkdir('vendor', { recursive: true });
await fs.writeFile('vendor/_ui.js', `
export { h, render, Fragment } from 'preact';
export { useState, useEffect, useMemo, useRef, useCallback, useReducer } from 'preact/hooks';
import htm from 'htm';
import { h } from 'preact';
export const html = htm.bind(h);
`);
await fs.writeFile('vendor/_firebase.js', `
export { initializeApp } from 'firebase/app';
export { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, onAuthStateChanged, signOut, browserLocalPersistence, setPersistence } from 'firebase/auth';
export { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, onSnapshot, setDoc, deleteDoc, writeBatch, increment, serverTimestamp } from 'firebase/firestore';
`);
for (const [entry, out] of [['vendor/_ui.js', 'vendor/ui.mjs'], ['vendor/_firebase.js', 'vendor/firebase.mjs']]) {
  await build({ entryPoints: [entry], bundle: true, format: 'esm', minify: true, outfile: out, target: 'es2020', legalComments: 'none' });
  await fs.rm(entry);
  console.log(out, ((await fs.stat(out)).size / 1024).toFixed(0) + ' KB');
}
