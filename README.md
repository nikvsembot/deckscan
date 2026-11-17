# Deckscan — Cyberpunk TCG scanner, collection & deck builder

A phone-first web app (installable on Android from Chrome, also runs on a PC):

- **Live scanning** — point the camera at cards one at a time; each card is recognised and added
  automatically, with a running total of its Cardmarket value.
- **Library** — every card you own, by version (Beta/Retail/alt-art/Iconic), with value totals.
- **Deck builder** — official deck rules (3 Legends with different names, 40–50 cards, max 3 copies,
  RAM limits per colour), owned vs missing cards, and what the missing cards cost on Cardmarket.
- **Sync** — sign in with Google on the phone and the PC to share one collection (Firebase).

## How it works

| Part | Source |
| --- | --- |
| Cards & versions | Official Cyberpunk TCG card database (`api.netdeck.gg`), English printings |
| Prices | Cardmarket's public daily price guide for Cyberpunk (`price_guide_23.json`), "price trend" in € |
| Recognition | Colour/layout fingerprints of each card image, compared on the phone (no server) |

`scripts/build-data.mjs` runs daily on GitHub Actions (`.github/workflows/update-and-deploy.yml`):
it rebuilds `data/` (cards, prices, fingerprints), runs a recognition self-test on simulated camera
shots to calibrate the scanner, and deploys the site to GitHub Pages. The report is printed in the
Action log (`data/meta.json`), including any Cardmarket versions it could not match.

## Development

```bash
npm install
node scripts/vendor.mjs                     # bundles Preact/htm and Firebase into vendor/
node test/make-fixture.mjs                  # synthetic offline fixture
DECKSCAN_FIXTURE=test/fixture node scripts/build-data.mjs
python3 -m http.server 8080                 # open http://localhost:8080
python3 -I test/e2e_scan.py . measure && python3 -I test/e2e_scan.py . run   # fake-camera scan test
python3 -I test/ui_smoke.py .
```

## Sync setup (Firebase)

1. Create a Firebase project, add a Web app, copy its config into `js/config.js`.
2. Authentication → Sign-in method → enable **Google**; add your Pages domain under Authorized domains.
3. Firestore → create database, then set these rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

Unofficial fan tool for personal use; not affiliated with WeirdCo, CD PROJEKT RED or Cardmarket.
