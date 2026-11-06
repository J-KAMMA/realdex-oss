#!/usr/bin/env python3
"""Optional console QA. Requires Python + Playwright + installed Chromium.
No wallet, external HTTP request, blockchain operation or permanent identity is used.
Usage: python node/test/browser-smoke.py --output node/evidence/browser
"""
from __future__ import annotations
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--output', default=str(ROOT / 'node/evidence/browser'))
parser.add_argument('--offline-dom', action='store_true', help='Render local files in memory and inject a status fixture; NOT a browser HTTP end-to-end test')
parser.add_argument('--chromium', default=shutil.which('chromium') or shutil.which('chromium-browser'))
args = parser.parse_args()
output = Path(args.output).resolve()
output.mkdir(parents=True, exist_ok=True)
node = shutil.which('node')
if not node:
    raise RuntimeError('Node.js is required')
report: dict = {'scope': 'offline DOM with injected status; no browser HTTP/CSP check' if args.offline_dom else 'node-console-only; no DEX/wallet/chain execution', 'browserHttpEndToEnd': not args.offline_dom, 'viewports': [], 'externalRequests': [], 'pageErrors': [], 'consoleErrors': []}
with tempfile.TemporaryDirectory(prefix='realdex-browser-') as temporary:
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    data_dir = Path(temporary) / 'node'
    subprocess.run([node, 'node/cli.mjs', 'init', '--directory', str(data_dir), '--port', str(port)], cwd=ROOT, check=True, capture_output=True)
    config = data_dir / 'config.json'
    process = subprocess.Popen([node, 'node/cli.mjs', 'start', '--config', str(config)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    origin = f'http://127.0.0.1:{port}'
    try:
        ready = False
        for _ in range(100):
            if process.poll() is not None:
                raise RuntimeError('Node exited before browser test: ' + process.stderr.read())
            try:
                with urlopen(origin + '/v1/status', timeout=.1) as response:
                    ready = response.status == 200
                if ready:
                    break
            except OSError:
                time.sleep(.03)
        if not ready:
            raise RuntimeError('Node did not start')
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=args.chromium, headless=True, args=['--no-sandbox'])
            report['browser'] = browser.version
            context = browser.new_context(locale='ja-JP')
            # Accessing an injected wallet would fail the test even before a method call.
            context.add_init_script("Object.defineProperty(window,'ethereum',{get(){window.__walletTouched=true;throw new Error('WALLET_ACCESS_FORBIDDEN')}});window.__walletTouched=false;")
            def guard(route):
                if not route.request.url.startswith(origin + '/'):
                    report['externalRequests'].append(route.request.url)
                    route.abort()
                else:
                    route.continue_()
            context.route('**/*', guard)
            page = context.new_page()
            page.on('pageerror', lambda error: report['pageErrors'].append(str(error)))
            page.on('console', lambda message: report['consoleErrors'].append(message.text) if message.type == 'error' else None)
            for name, width, height in [('desktop', 1280, 1100), ('mobile', 390, 844), ('small-mobile', 320, 780)]:
                page.set_viewport_size({'width': width, 'height': height})
                if args.offline_dom:
                    # Do not change managed browser policy. No navigation is attempted.
                    with urlopen(origin + '/v1/status') as response:
                        status_fixture = json.load(response)
                    html = (ROOT / 'node/public/index.html').read_text()
                    html = re.sub(r'<link[^>]+>', '', html)
                    html = re.sub(r'<script.*?</script>', '', html, flags=re.S)
                    css = (ROOT / 'node/public/styles.css').read_text()
                    page.set_content(html.replace('</head>', '<style>' + css + '</style></head>'))
                    page.evaluate('value => { window.__nodeStatus=value; window.__statusFail=false; window.fetch=async () => { if(window.__statusFail) throw new Error("TEST_UNAVAILABLE"); return {ok:true,json:async()=>window.__nodeStatus}; }; }', status_fixture)
                    files = ['optimizer/quote-objective.mjs', 'optimizer/discrete-split.mjs', 'optimizer/demo-data.mjs', 'public/console.mjs']
                    js = '\n'.join((ROOT / 'node' / name).read_text() for name in files)
                    js = re.sub(r'^import[\s\S]*?;\s*', '', js, flags=re.M)
                    js = re.sub(r'^export ', '', js, flags=re.M)
                    page.evaluate('() => {' + js + '}')
                else:
                    page.goto(origin + '/node/', wait_until='networkidle')
                page.get_by_text('稼働中 · 資金署名なし · 取引送信なし', exact=True).wait_for()
                page.get_by_role('button', name='整数最適化デモを実行').click()
                page.get_by_text('分割案の実質受取額: 94854 最小単位', exact=True).wait_for()
                metrics = page.evaluate("({scrollWidth:document.documentElement.scrollWidth, innerWidth:innerWidth, walletTouched:window.__walletTouched})")
                assert metrics['scrollWidth'] <= width, (name, metrics)
                assert not metrics['walletTouched']
                screenshot = name + '.png'
                page.screenshot(path=str(output / screenshot), full_page=True)
                report['viewports'].append({'name': name, 'width': width, 'height': height, **metrics, 'screenshot': screenshot, 'demoResult': '94854'})
            page.set_viewport_size({'width': 1280, 'height': 1100})
            page.evaluate("document.documentElement.style.zoom='2'")
            page.get_by_role('button', name='表示を更新').click()
            page.get_by_text('稼働中 · 資金署名なし · 取引送信なし', exact=True).wait_for()
            metrics = page.evaluate("({scrollWidth:document.documentElement.scrollWidth, innerWidth:innerWidth})")
            assert metrics['scrollWidth'] <= 1280, metrics
            report['cssZoom200Percent'] = {'layoutOnlyNotOsScaling': True, **metrics}
            # Network failure clears previously shown candidates rather than leaving a live-looking price.
            if args.offline_dom:
                page.evaluate('window.__statusFail=true')
            else:
                context.route('**/v1/status', lambda route: route.abort())
            page.get_by_role('button', name='表示を更新').click()
            page.get_by_text('状態を確認できません。以前の候補を現在の情報として扱わないでください。', exact=True).wait_for()
            assert page.locator('#factories').inner_text() == ''
            report['failedStatusClearsCandidates'] = True
            report['consoleErrors'] = [item for item in report['consoleErrors'] if 'ERR_FAILED' not in item]
            browser.close()
        assert report['externalRequests'] == [], report
        assert report['pageErrors'] == [], report
        assert report['consoleErrors'] == [], report
        report['passed'] = True
    finally:
        process.terminate()
        try:
            process.wait(timeout=7)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        (output / 'browser-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=False, indent=2))
