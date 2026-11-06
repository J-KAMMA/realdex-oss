#!/usr/bin/env python3
"""Optional Chromium DOM-only test; never connects to a chain or circumvents
browser network policy. Requires Python + Playwright + an installed Chromium.
Production JS is loaded as in-memory modules; only the bundled registry fetch
is supplied locally. Not evidence of HTTP, CSP, CORS or live RPC compatibility.
"""
from __future__ import annotations
import argparse, base64, json, re, shutil
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
def run(output: Path, chromium: str | None) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    cache: dict[str, str] = {}
    def module(path: Path) -> str:
        key = str(path)
        if key in cache:
            return cache[key]
        source = path.read_text(encoding='utf-8')
        def replace(match: re.Match[str]) -> str:
            target = match.group(2)
            dep = (ROOT / target.lstrip('/')) if target.startswith('/node/') else path.parent / target
            return match.group(1) + "'" + module(dep.resolve()) + "'"
        source = re.sub(r"(from\s*)['\"]([^'\"]+)['\"]", replace, source)
        url = 'data:text/javascript;base64,' + base64.b64encode(source.encode()).decode()
        cache[key] = url
        return url
    html = (ROOT / 'node/public/chains.html').read_text(encoding='utf-8')
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link[^>]+stylesheet[^>]*>', '', html)
    css = (ROOT / 'node/public/chains.css').read_text(encoding='utf-8')
    html = html.replace('</head>', '<style>' + css + '</style></head>')
    html = html.replace('<body>', '<body><aside style="padding:10px 24px;background:#413b1c;color:#fff5be;font:12px system-ui;text-align:center">OFFLINE DOM TEST / 実RPC未接続・HTTP結合未検証</aside>')
    profiles = json.loads((ROOT / 'node/chains/profiles.json').read_text())
    steps: list[str] = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=chromium, headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width': 1440, 'height': 1240}, device_scale_factor=1)
        errors: list[str] = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.set_content(html)
        page.evaluate('''(profiles) => {
            window.__chainTestFetches = [];
            window.fetch = async (url) => {
                window.__chainTestFetches.push(String(url));
                if (String(url) === '/node/chains/profiles.json')
                    return new Response(JSON.stringify(profiles), {headers:{'content-type':'application/json'}});
                throw new Error('DOM_TEST_NETWORK_DISABLED');
            };
        }''', profiles)
        page.add_script_tag(type='module', content="import '" + module(ROOT / 'node/public/chains.mjs') + "';")
        page.wait_for_function("document.getElementById('networkCount').textContent === '138'")
        assert page.locator('#familyCount').inner_text() == '15'
        assert page.locator('.chain').count() == 138
        steps.append('138 candidate rows and 15 families rendered from bundled registry')
        page.locator('#search').fill('Kaia')
        assert page.locator('.chain').count() == 2
        page.locator('.chain').first.click()
        assert page.locator('#selectedId').inner_text() == 'eip155:8217'
        steps.append('Search by network name; selecting Kaia does not invoke wallet')
        page.locator('#search').fill('')
        page.locator('#family').select_option('solana')
        assert page.locator('.chain').count() == 3
        page.locator('.chain').first.click()
        assert page.locator('#genesis').get_attribute('required') is not None
        steps.append('Solana filter and required explicit genesis pin')
        page.locator('#endpoints').fill('https://one.example/rpc')
        page.locator('#family').select_option('evm')
        page.locator('.chain').first.click()
        assert page.locator('#endpoints').input_value() == ''
        assert page.locator('#genesis').get_attribute('required') is None
        steps.append('Changing chain clears endpoint input and previous result')
        page.locator('#endpoints').fill('https://one.example/rpc')
        page.locator('#run').click()
        page.wait_for_function("document.getElementById('status').textContent.includes('TWO_TO_FOUR_ENDPOINTS_REQUIRED')")
        assert page.evaluate('window.__chainTestFetches') == ['/node/chains/profiles.json']
        steps.append('One endpoint is rejected before any RPC call')
        page.locator('#endpoints').fill('')
        page.locator('#family').select_option('')
        page.locator('.chain').first.click()
        page.screenshot(path=str(output / 'multichain-desktop.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
        page.screenshot(path=str(output / 'multichain-mobile.png'), full_page=True)
        steps.append('390px mobile layout has no horizontal overflow')
        assert errors == [], errors
        result = {'mode':'offline-dom-only', 'browser':browser.version, 'steps':steps,
                  'stepsPassed':len(steps), 'pageErrors':errors, 'liveRpcTested':False,
                  'httpCspCorsIntegrationTested':False, 'networkFetches':page.evaluate('window.__chainTestFetches')}
        (output / 'browser-offline-results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
        browser.close()
    return result
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--chromium', default=shutil.which('chromium'))
    args = parser.parse_args()
    print(json.dumps(run(args.output, args.chromium), ensure_ascii=False, indent=2))
