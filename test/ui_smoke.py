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
decks = {'d1': deck}
mtg_path = os.path.join(ROOT, 'data/mtg/cards.json')
HAS_MTG = os.path.exists(mtg_path)
if HAS_MTG:
    mcards = json.load(open(mtg_path))
    for i, p in enumerate(random.sample(mcards['printings'], 25)):
        coll[p['id']] = {'n': random.randint(1, 4), 'f': 0, 't': 1700000100000 + i}
    nonland = [c for c in mcards['cards'] if c['t'] != 'Land'][:12]
    basic = [c for c in mcards['cards'] if c.get('basic')]
    mmain = {c['id']: 2 for c in nonland[:11]}
    mmain[nonland[11]['id']] = 5            # 5 copies: fine in Limited, too many in Constructed
    if basic: mmain[basic[0]['id']] = 17
    decks['m1'] = {'id': 'm1', 'game': 'mtg', 'format': 'limited', 'name': 'Strixhaven sealed', 'legends': [], 'main': mmain, 'updated': 2}
state = {'coll': coll, 'decks': decks, 'settings': {'images': True}, 'session': []}

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
    page.get_by_role('button', name='Prices').click()
    page.wait_for_selector('.chart, .chart-empty')
    page.wait_for_timeout(300)
    page.screenshot(path=f'{OUT}/prices.png', full_page=True)
    n_changes = page.locator('.change-row').count()
    box = page.locator('.chart svg').bounding_box() if page.locator('.chart svg').count() else None
    if box:
        page.mouse.move(box['x'] + box['width'] * 0.3, box['y'] + box['height'] / 2)
        page.screenshot(path=f'{OUT}/prices-hover.png')
    page.locator('.chip', has_text='vs 30-day avg').click()
    n_avg = page.locator('.change-row').count()
    page.get_by_role('button', name='All cards').click()
    n_all = page.locator('.change-row').count()
    if page.locator('.change-row').count():
        page.locator('.change-row').first.click()
        page.wait_for_selector('.sheet .chart, .sheet .chart-empty')
        page.screenshot(path=f'{OUT}/card-graph.png', full_page=True)
        page.locator('.sheet [aria-label=Close]').click()
    print('prices: my changes', n_changes, 'vs avg', n_avg, 'all', n_all)
    # Claude advisor: export text, import a deck through the UI and through window.deckscan
    exp = page.evaluate("window.deckscan.exportText('cyberpunk')")
    names = [l.split('— ')[0][2:].strip() for l in exp.splitlines() if l.startswith('# ')]
    legends = [l[2:].split(' — ')[0] for l in exp.splitlines() if l.startswith('# ') and 'Legend' in l][:3]
    others = [l[2:].split(' — ')[0] for l in exp.splitlines() if l.startswith('# ') and 'Legend' not in l][:5]
    deck_list = 'Imported test\nLegends:\n' + '\n'.join('1 ' + n for n in legends) + '\nMain:\n' + '\n'.join(f'3x {n}' for n in others) + '\n2 Not A Real Card'
    page.get_by_role('button', name='Decks').click()
    page.get_by_role('button', name='Import deck').click()
    page.locator('.sheet textarea').fill(deck_list)
    found = page.locator('.sheet .checks').inner_text()
    page.screenshot(path=f'{OUT}/import.png')
    page.get_by_role('button', name='Save deck').click()
    page.wait_for_selector('.checks')
    imported_checks = page.locator('.checks').first.inner_text()
    page.screenshot(path=f'{OUT}/imported-deck.png', full_page=True)
    api = page.evaluate("window.deckscan.importDeck('Commander: Nobody\\n4 Also Nobody', 'cyberpunk', 'api test')")
    print('export chars', len(exp), '| import preview:', found.replace('\n', ' / '), '| api:', api)
    print('imported deck checks:', imported_checks.replace('\n', ' / ')[:300])
    page.get_by_role('button', name='Settings').click()
    page.wait_for_selector('.settings')
    page.screenshot(path=f'{OUT}/settings.png', full_page=True)
    mtg = {}
    if HAS_MTG:
        page.get_by_role('button', name='Library').click()
        page.locator('.seg button', has_text='Magic').click()
        page.wait_for_selector('.lib-row')
        mtg['library_rows'] = page.locator('.lib-row').count()
        mtg['library_total'] = page.locator('.stat-row .total').inner_text()
        page.screenshot(path=f'{OUT}/mtg-library.png')
        page.locator('.lib-row').first.click(); page.wait_for_selector('.sheet')
        mtg['sheet_meta'] = page.locator('.card-detail .meta').inner_text().replace('\n', ' | ')
        page.screenshot(path=f'{OUT}/mtg-sheet.png')
        page.locator('.sheet .icon-btn[aria-label="Close"]').click()
        page.get_by_role('button', name='Decks').click()
        page.wait_for_selector('.deck-row')
        mtg['deck_list'] = page.locator('.deck-row').all_inner_texts()
        page.locator('.deck-row').first.click(); page.wait_for_selector('.checks')
        mtg['limited_checks'] = page.locator('.check').all_inner_texts()
        page.locator('select.select').first.select_option('constructed')
        page.wait_for_timeout(300)
        mtg['constructed_checks'] = page.locator('.check').all_inner_texts()
        page.screenshot(path=f'{OUT}/mtg-deck.png', full_page=True)
        page.get_by_role('button', name='Scan').click()
        page.wait_for_selector('.cam-game .seg')
        mtg['scan_game_switch'] = page.locator('.cam-game .seg button.on').inner_text()
        page.screenshot(path=f'{OUT}/mtg-scan.png')
    b.close()
httpd.shutdown()
print(json.dumps({'mtg': mtg if HAS_MTG else None, 'library_rows': n_rows, 'collection_total': total, 'stepper': [before, after], 'checks': checks, 'missing_total': missing_total, 'errors': errors[:10]}, indent=1))
