"""End-to-end scan test: Chrome with a fake camera playing a video of cards being
held into the guide one by one. Checks each card is added exactly once, in order.

Usage: python3 -I test/e2e_scan.py <app_root> [phase]
  phase "measure" prints where the guide sits in the camera image;
  phase "run" (default) builds the card video and checks the scan session.
"""
import json, os, subprocess, sys, time, random, shutil, http.server, threading, functools
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(sys.argv[1])
PHASE = sys.argv[2] if len(sys.argv) > 2 else 'run'
GAME = sys.argv[3] if len(sys.argv) > 3 else 'cyberpunk'   # cyberpunk | mtg
GDIR = os.path.join(ROOT, 'data') if GAME == 'cyberpunk' else os.path.join(ROOT, 'data', 'mtg')
IMG_DIR = os.path.join(ROOT, '.cache', 'img' if GAME == 'cyberpunk' else 'mtg-img')
MAIN_SET = 'welcometonightcityretail' if GAME == 'cyberpunk' else 'sos'
TMP = '/tmp/deckscan-e2e'
VW, VH, FPS = 1280, 720, 10
OW, OH = 960, 540  # size of the fake camera video file
VIEWPORT = {'width': 390, 'height': 844}
os.makedirs(TMP, exist_ok=True)


def serve():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 8765), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def blank_video(path):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', f'color=c=0x3a2a20:s={OW}x{OH}:r={FPS}', '-t', '2',
                    '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', path], check=True)


def card_video(path, rect, cards):
    """Frames: table background; each card slides in, holds, slides out, then empty table."""
    from PIL import Image, ImageEnhance, ImageFilter
    frames = os.path.join(TMP, 'frames'); shutil.rmtree(frames, ignore_errors=True); os.makedirs(frames)
    bg = Image.new('RGB', (VW, VH), (58, 42, 32))
    # a bit of table texture
    for _ in range(400):
        x, y = random.randrange(VW), random.randrange(VH)
        bg.paste((random.randint(45, 75), random.randint(32, 52), random.randint(22, 40)), (x, y, x + random.randint(20, 160), y + 2))
    k = VW / rect.get('vw', VW)
    gx, gy, gw, gh = rect['x'] * k, rect['y'] * k, rect['w'] * k, rect['h'] * k
    n = 0
    timeline = []
    for img_path in cards:
        card = Image.open(img_path).convert('RGB')
        s = random.uniform(0.84, 0.92)  # card a bit smaller than the (expanded) sampled region
        cw, ch = int(gw * s), int(gh * s)
        card = card.resize((cw, ch))
        card = ImageEnhance.Brightness(card).enhance(random.uniform(0.75, 1.1))
        card = card.rotate(random.uniform(-3, 3), expand=True, fillcolor=(58, 42, 32))
        tx = int(gx + (gw - card.width) / 2 + random.uniform(-0.02, 0.02) * gw)
        ty = int(gy + (gh - card.height) / 2 + random.uniform(-0.02, 0.02) * gh)
        steps = [('in', 5), ('hold', 15), ('out', 5), ('empty', 6)]
        for kind, k in steps:
            for i in range(k):
                f = bg.copy()
                if kind == 'in':
                    off = int((1 - (i + 1) / k) * VW * 0.6)
                    f.paste(card, (tx + off, ty))
                elif kind == 'hold':
                    f.paste(card, (tx + random.randint(-2, 2), ty + random.randint(-2, 2)))
                elif kind == 'out':
                    off = int(((i + 1) / k) * VW * 0.6)
                    f.paste(card, (tx - off, ty))
                f = f.filter(ImageFilter.GaussianBlur(0.8))
                f.save(os.path.join(frames, f'{n:05d}.jpg'), quality=80)
                n += 1
        timeline.append(img_path)
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-framerate', str(FPS), '-i', os.path.join(frames, '%05d.jpg'),
                    '-vf', f'scale={OW}:{OH}', '-pix_fmt', 'yuv420p', '-f', 'yuv4mpegpipe', path], check=True)
    return n / FPS


def launch(p, video):
    return p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', f'--use-file-for-fake-video-capture={video}',
        '--autoplay-policy=no-user-gesture-required'])


def open_scan(browser):
    ctx = browser.new_context(viewport=VIEWPORT, device_scale_factor=2, is_mobile=True, has_touch=True)
    ctx.add_init_script("localStorage.setItem('deckscan.v1', JSON.stringify({settings: {game: '%s'}}))" % GAME)
    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.goto('http://127.0.0.1:8765/#scan')
    page.get_by_text('Start scanning').click()
    page.wait_for_function('window.__scanner && window.__scanner.o.video.videoWidth > 0', timeout=15000)
    return page, logs


def main():
    httpd = serve()
    with sync_playwright() as p:
        if PHASE == 'measure':
            v = os.path.join(TMP, 'blank.y4m'); blank_video(v)
            b = launch(p, v); page, logs = open_scan(b)
            rect = page.evaluate('() => { const r = window.__scanner.guideInVideo(); const v = window.__scanner.o.video; return {...r, vw: v.videoWidth, vh: v.videoHeight}; }')
            print(json.dumps(rect)); json.dump(rect, open(os.path.join(TMP, 'rect.json'), 'w'))
            page.screenshot(path=os.path.join(TMP, 'scan-empty.png'))
            print('\n'.join(logs[-10:]))
            b.close(); return

        rect = json.load(open(os.path.join(TMP, 'rect.json')))
        fp = json.load(open(os.path.join(GDIR, 'fp.json')))
        cards_json = json.load(open(os.path.join(GDIR, 'cards.json')))
        pr = {x['id']: x for x in cards_json['printings']}
        random.seed(3)
        # pick printings from distinct art groups; prefer Retail members (what the app should pick)
        by_group, ref_of = {}, {}
        refs_cache = json.load(open(os.path.join(ROOT, '.cache', 'fp-cache.json' if GAME == 'cyberpunk' else 'mtg-fp-cache.json')))
        for i, pid in enumerate(fp['ids']):
            by_group.setdefault(fp['group'][i], []).append(pid)
            ref_of.setdefault(fp['group'][i], pid if pid in refs_cache else pid + '#b')
        groups = random.sample(sorted(by_group), 8)
        picks = []
        for g in groups:
            members = by_group[g]
            retail = [m for m in members if pr[m]['set'] == MAIN_SET]
            picks.append((retail or members)[0])
        pick_refs = [p if os.path.exists(os.path.join(IMG_DIR, f'{p}.png')) else p + '#b' for p in picks]
        picks.insert(3, picks[2])  # the same card twice in a row (two copies)
        pick_refs.insert(3, pick_refs[2])
        dur = card_video(os.path.join(TMP, 'cards.y4m'), rect, [os.path.join(IMG_DIR, f'{r}.png') for r in pick_refs])
        b = launch(p, os.path.join(TMP, 'cards.y4m'))
        page, logs = open_scan(b)  # fresh browser context: empty collection
        t0 = time.time()
        shots = 0
        while time.time() - t0 < dur * 0.97:
            time.sleep(1.0)
            if shots < 3 and time.time() - t0 > 2 + shots * 4:
                page.screenshot(path=os.path.join(TMP, f'scan-{shots}.png')); shots += 1
        session = page.evaluate("() => JSON.parse(localStorage.getItem('deckscan.v1')).session.map(s => s.pid).reverse()")
        page.screenshot(path=os.path.join(TMP, 'scan-final.png'))
        b.close()
    expected = picks
    got = session[:len(expected)]
    ok = got == expected
    print(f'video {dur:.1f}s, expected {len(expected)} adds, got {len(session)}')
    for i, (e, g) in enumerate(zip(expected, got + [None] * len(expected))):
        print(f'  {i}: {"OK " if e == g else "BAD"} expected {pr[e]["c"]} {pr[e]["set"][-6:]} {pr[e]["no"]}  got {pr[g]["c"] + " " + pr[g]["set"][-6:] + " " + pr[g]["no"] if g else "-"}')
    if len(session) > len(expected):
        print('  extra:', [pr[x]['c'] for x in session[len(expected):]])
    print('\n'.join(l for l in logs if 'error' in l.lower())[:2000])
    print('RESULT', 'PASS' if ok and len(session) == len(expected) else 'FAIL')
    httpd.shutdown()


if __name__ == '__main__':
    main()
