#!/usr/bin/env python3
"""Real Chromium -> real wallet HTTP -> two IBC chains. No fetch interception or CSP bypass."""
import argparse,json,os,queue,shutil,subprocess,threading,time
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def run(output):
 output.mkdir(parents=True,exist_ok=False);result={'schema':'realdex.ibc-browser.v1','status':'failed','realHttp':False,'cspEnforced':False,'transactionsSubmitted':False,'steps':[],'productionReady':False};service=None
 try:
  from playwright.sync_api import sync_playwright
  env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','LANG','REALDEX_IBC_SIMD_BINARY','REALDEX_IBC_MUSL_LOADER']};env['REALDEX_IBC_LOG_DIRECTORY']=str(output/'nodes')
  err=(output/'fixture-stderr.log').open('w');service=subprocess.Popen(['node','integration/ibc/browser-fixture.mjs'],cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,text=True,bufsize=1)
  q=queue.Queue()
  def read():
   for line in service.stdout:q.put(line)
  threading.Thread(target=read,daemon=True).start()
  def response(timeout=90):
   v=json.loads(q.get(timeout=timeout));return v
  ready=response();assert ready['ready']
  with sync_playwright() as p:
   with p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']) as browser:
    page=browser.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    try:r=page.goto(ready['url'],wait_until='networkidle',timeout=15000)
    except Exception as e:
     result.update(status='blocked' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e) else 'failed',reason='BROWSER_POLICY_BLOCK' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e) else 'BROWSER_NAVIGATION_FAILED');return result
    assert r.status==200;assert "default-src 'none'" in r.headers.get('content-security-policy','');page.wait_for_function("!location.hash && document.getElementById('workspace').hidden===false")
    assert page.locator('#ibcRoute option').count()==2;assert page.locator('#ibcAccount option').count()==16;result['steps'].append('native ES modules load over HTTP with owner key removed from URL')
    page.evaluate("()=>{const s=document.createElement('script');s.textContent='window.__injectedIBC=true';document.head.append(s);}");assert page.evaluate('window.__injectedIBC===undefined');result['cspEnforced']=True;result['steps'].append('CSP rejects inline script injection')
    page.locator('#ibcAccount').select_option(ready['accountId']);page.locator('#ibcRoute').select_option(ready['routeId']);page.locator('#ibcRecipient').fill(ready['receiver']);page.locator('#ibcAmount').fill('1.0');page.locator('#ibcTimeout').fill('120');page.locator('#ibcRequestKey').fill('real-browser-transfer')
    page.locator('#ibcForm button[type=submit]').click();page.locator('#ibcConfirm').wait_for();assert not page.locator('#ibcBroadcast').is_checked();assert '1000000' in page.locator('#ibcApproval').inner_text();result['steps'].append('prepared bridge requires separate full owner confirmation and defaults broadcast off')
    page.locator('#ibcConfirm').fill('wrong');page.locator('#ibcApproval button').first.click();page.wait_for_function("document.getElementById('message').textContent.includes('IBC_APPROVAL_CONFIRMATION')")
    service.stdin.write(json.dumps({'action':'status'})+'\n');service.stdin.flush();s=response();assert s['submissions']==0 and s['records']==0;result['steps'].append('wrong confirmation creates no signature or broadcast')
    page.locator('#ibcConfirm').fill('BRIDGE '+ready['receiver']+' TO realdex-local-bridge-b-1');page.locator('#ibcBroadcast').check();page.locator('#ibcApproval button').first.click();page.wait_for_function("document.getElementById('ibcHistory').querySelectorAll('article').length===1",timeout=30000);result['transactionsSubmitted']=True
    service.stdin.write(json.dumps({'action':'relay','requestKey':'real-browser-transfer'})+'\n');service.stdin.flush();relayed=response();inputs=page.locator('#ibcHistory article input');inputs.nth(0).fill(relayed['destinationTxHash']);inputs.nth(1).fill(relayed['settlementTxHash']);page.locator('#ibcHistory button').filter(has_text='元の取引').click();page.wait_for_function("document.getElementById('ibcHistory').textContent.includes('reported-delivered')",timeout=30000);result['steps'].append('UI approval signs, persists and submits; real two-chain receive and ACK are reconciled in UI')
    assert not errors;page.locator('#ibcPanel').screenshot(path=str(output/'ibc-real-browser.png'))
    page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden===true");assert page.locator('#ibcApproval').inner_text()=='';result['steps'].append('lock clears bridge approval and history panel')
    result.update(status='passed',realHttp=True,browser=browser.version)
 except Exception as e:result.update(status='failed',reason='BROWSER_TEST_ASSERTION_OR_SETUP_FAILED',errorType=type(e).__name__)
 finally:
  if service is not None:
   if service.poll() is None:
    try:service.stdin.write('{"action":"close"}\n');service.stdin.flush();service.wait(timeout=15)
    except Exception:service.terminate();service.wait(timeout=15)
   err.close()
  result['stepsPassed']=len(result['steps']);(output/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
 return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();r=run(a.output);print(json.dumps(r,ensure_ascii=False,indent=2));raise SystemExit(0 if r['status']=='passed' else 2 if r['status']=='blocked' else 1)
