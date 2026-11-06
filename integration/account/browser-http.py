#!/usr/bin/env python3
"""Actual loopback HTTP owner UI; synthetic ledgers, real signatures. Never public chains."""
import argparse,json,re,subprocess,time
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(output):
 output.mkdir(parents=True,exist_ok=False)
 child=subprocess.Popen(['node','integration/account/browser-fixture.mjs'],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 steps=[];errors=[]
 try:
  data=json.loads(child.stdout.readline())
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
   page=browser.new_page(viewport={'width':1400,'height':1100});page.on('pageerror',lambda e:errors.append(str(e)))
   page.goto(data['url'],wait_until='networkidle',timeout=20000)
   page.locator('#accountOnlineSection').wait_for(state='visible')
   page.wait_for_function("document.querySelector('#accountOnlineNetwork').options.length===2")
   steps.append('live owner HTTP and two local network options')
   for family,network in [('stellar','stellar:standalone'),('aptos','aptos:local-4')]:
    page.select_option('#accountOnlineNetwork',network)
    page.fill('#accountOnlineRecipient',data[family+'To']);page.fill('#accountOnlineAmount','0.1')
    page.fill('#accountOnlineKey','browser-'+family)
    page.click('#accountOnlineBalance')
    page.wait_for_function("document.querySelector('#accountOnlineResult').textContent.includes('sequence')")
    steps.append(family+' balance from live service')
    page.locator('#accountOnlineForm button[type=submit]').click()
    card=page.locator('#pending .request-card').filter(has_text=family.upper()+' · ローカル送金の確認')
    card.wait_for(state='visible')
    assert not card.locator('input[type=checkbox]').is_checked()
    steps.append(family+' signing and broadcasting are not automatic')
    card.locator('input:not([type=checkbox])').fill(data[family+'To'])
    card.locator('input[type=checkbox]').check()
    card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click()
    page.wait_for_function("document.querySelector('#nonEvmJournal').textContent.includes('broadcast')")
    page.get_by_role('button',name=family.upper()+'の状態を再照合',exact=True).click()
    page.wait_for_function("(f)=>document.querySelector('#nonEvmJournal').textContent.includes(f+' · reported-confirmed')",arg=family.upper())
    steps.append(family+' confirmation signature persistence submit and reconciliation')
   page.locator('#accountOnlineSection').screenshot(path=str(output/'account-online-panel.png'))
   assert not errors,errors
   browser.close()
  report={'status':'passed','httpLive':True,'ledgerEnvironment':'synthetic','realChainExecution':False,'checks':steps,'pageErrors':errors}
 except Exception as e:
  report={'status':'failed-or-blocked','httpLive':False,'ledgerEnvironment':'synthetic','realChainExecution':False,'checks':steps,'error':re.sub(r'#key=[0-9a-fA-F]+','#key=[REDACTED]',str(e))[:1200],'pageErrors':errors}
 finally:
  child.terminate()
  try:child.wait(timeout=10)
  except subprocess.TimeoutExpired:child.kill();child.wait()
  output.joinpath('results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
 print(json.dumps(report,ensure_ascii=False))
 return 0 if report['status']=='passed' else 1
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args();raise SystemExit(run(args.output))
