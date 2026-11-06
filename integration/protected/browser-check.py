"""Normal managed browser only. Failure is evidence, not permission to bypass policy."""
import sys,json
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright
config=json.load(sys.stdin);out=Path(sys.argv[1]);result={'schema':'realdex.up01-browser.v1','passed':False,'syntheticResponses':0,'policyChanged':False,'externalRequests':0}
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True)
    context=browser.new_context(viewport={'width':1280,'height':1000},service_workers='block')
    origin=config['origin'];u=urlsplit(origin)
    assert u.scheme=='http' and u.hostname=='127.0.0.1' and not u.path
    def route(r):
        t=urlsplit(r.request.url)
        if t.scheme+'://'+t.netloc==origin:r.continue_()
        else:
            result['externalRequests']+=1;r.abort()
    context.route('**/*',route);page=context.new_page()
    try:
        page.goto(origin+'/wallet/#key='+config['token'],wait_until='networkidle',timeout=15000)
        page.locator('#protectedStorage').wait_for(state='visible',timeout=10000)
        assert 'チェックポイント' in page.locator('#protectedStorage').inner_text()
        assert page.evaluate('location.hash')==''
        assert result['externalRequests']==0
        result.update(passed=True,scope='real-owner-page-protection-status',checks=3)
        page.screenshot(path=str(out/'owner-protection.png'),full_page=True)
    except Exception as e:
        result['error']='BROWSER_POLICY_BLOCK' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e) else 'BROWSER_REAL_PAGE_FAILED'
        try:page.screenshot(path=str(out/'browser-status.png'))
        except Exception:pass
    finally:
        context.close();browser.close()
(out/'browser.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
sys.exit(0 if result['passed'] else 2)
