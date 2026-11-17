"""UI smoke test: seeds a collection + deck, visits every screen, checks deck rules, saves screenshots.
Usage: python3 -I test/ui_smoke.py <app_root>"""
import json, os, sys, random, http.server, threading, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(sys.argv[1])
OUT = '/tmp/deckscan-ui'
os.makedirs(OUT, exist_ok=True)
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 8766), handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

cards = json.load(open(os.path.join(ROOT, 'data/cards.json')))
random.seed(1)
prs = cards['printings']
coll = {p['id']: {'n': random.randint(1, 3), 'f': random.choice([0, 0, 0, 1]), 't': 1700000000000 + i} for i, p in enumerate(random.sample(prs, 40))}
legends = [c for c in cards['cards'] if c['t'] == 'Legend']
# three legends with different names
chosen, names = [], set()
for c in legends:
    if c['n'] not in names: chosen.append(c); names.add(c['n'])
    if len(chosen) == 3: break
colors = {c['c'] for c in chosen}
pool = [c for c in cards['cards'] if c['t'] != 'Legend' and c['c'] in colors]
main = {c['id']: 3 for c in pool[:13]}
main[pool[13]['id']] = 2   # 41 cards
deck = {'id': 'd1', 'name': 'Test deck', 'legends': [c['id'] for c in chosen], 'main': main, 'updated': 1}
state = {'coll': coll, 'decks': {'d1': deck}, 'settings': {'images': True}, 'session': []}

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True)
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"localStorage.setItem('deckscan.v1', {json.dumps(json.dumps(state))})")
    page = ctx.new_page()
    page.on('console', lambda m: m.type == 'error' and 'ERR_TUNNEL' not in m.text and 'Failed to load resource' not in m.text and errors.append(m.text))
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://127.0.0.1:8766/#library')
    page.wait_for_selector('.lib-row')
    page.screenshot(path=f'{OUT}/library.png')
    n_rows = page.locator('.lib-row').count()
    total = page.locator('.stat-row .total').inner_text()
    page.locator('.lib-row').first.click()
    page.wait_for_selector('.sheet')
    page.screenshot(path=f'{OUT}/card-sheet.png')
    before = page.locator('.pr-row.sel .stepper b').first.inner_text()
    page.locator('.pr-row.sel .stepper button[aria-label="More"]').first.click()
    after = page.locator('.pr-row.sel .stepper b').first.inner_text()
    page.locator('.sheet .icon-btn[aria-label="Close"]').click()
    page.get_by_role('button', name='Decks').click()
    page.wait_for_selector('.deck-row')
    page.screenshot(path=f'{OUT}/decks.png')
    page.locator('.deck-row').first.click()
    page.wait_for_selector('.checks')
    checks = page.locator('.check').all_inner_texts()
    page.screenshot(path=f'{OUT}/deck-editor.png', full_page=True)
    page.locator('.tabs2 button', has_text='Add cards').click()
    page.screenshot(path=f'{OUT}/deck-add.png')
    page.locator('.tabs2 button', has_text='Missing').click()
    page.screenshot(path=f'{OUT}/deck-missing.png', full_page=True)
    missing_total = page.locator('.stat-row .total').inner_text() if page.locator('.stat-row .total').count() else 'none'
    page.get_by_role('button', name='Settings').click()
    page.wait_for_selector('.settings')
    page.screenshot(path=f'{OUT}/settings.png', full_page=True)
    b.close()
httpd.shutdown()
print(json.dumps({'library_rows': n_rows, 'collection_total': total, 'stepper': [before, after], 'checks': checks, 'missing_total': missing_total, 'errors': errors[:10]}, indent=1))
