#!/usr/bin/env python3
"""Real Chromium DOM + explicitly synthetic owner API; never actual chain/browser acceptance."""
import argparse,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_source import frontend_source
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1280,'height':950});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate(r'''()=>{
   window.__calls=[];window.__commits=0;window.__bad=null;
   const report={observedAt:1,received:false,reason:'SUBMISSION_STARTING',transactionHash:'B'.repeat(64),automaticRetry:false,finalityProven:false};
   const base={id:'old',accountId:'evm',family:'injective',state:'broadcast-unknown',requestKey:'uncertain-deposit',createdAt:1,summary:{operation:'injective-deposit-local',action:'deposit',recipient:'0x'+'1'.repeat(64),marketId:'self',amountAtomic:'9007199254740993',reviewSha256:'f'.repeat(64),subaccountId:'0x'+'1'.repeat(64)},signed:{requestId:'B'.repeat(64)},report};
   window.__records=[base,{...structuredClone(base),id:'included',requestKey:'included-failure',state:'reported-reverted',report:{...report,received:true,height:'10',code:1,reason:'INCLUDED_FAILURE'}}];
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'evm',family:'evm',kind:'local',address:'0x'+'1'.repeat(40),label:'Owner'}],networks:[],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[]};
   window.__review={schema:'realdex.injective-submission-expiry-review.v1',recordId:'old',originalState:'broadcast-unknown',neverSubmittedByWallet:false,submissionMayHaveOccurred:true,transactionHash:'B'.repeat(64),reviewSha256:'a'.repeat(64),boundary:{timeoutHeight:'9007199254740993'},evidence:{height:'9007199254740994'},chainStateAuthenticated:false,settlementVerified:false,automaticRetryAllowed:false};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('EXTERNAL_NETWORK_FORBIDDEN');const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let v={};
    if(route==='status')v=structuredClone(window.__state);
    else if(route==='non-evm/history')v={records:structuredClone(window.__records)};
    else if(route==='non-evm/injective/recovery/prepare'){v=structuredClone(window.__review);if(window.__bad==='schema')v.schema='realdex.injective-unsent-retirement-review.v1';if(window.__bad==='hash')v.transactionHash='C'.repeat(64);}
    else if(route==='non-evm/injective/recovery/retire'){
     await new Promise(r=>setTimeout(r,50));
     if(body.confirmation!=='a'.repeat(64)||body.transactionHash!=='B'.repeat(64))v={error:'INJECTIVE_RECOVERY_CONFIRMATION_REQUIRED'};
     else{window.__commits++;const r=window.__records[0];r.state='retired-submission-expired';r.retirement={review:structuredClone(window.__review),check:{height:window.__review.evidence.height}};v=structuredClone(r);}
    }else throw Error('SYNTHETIC_METHOD_UNSUPPORTED');
    return new Response(JSON.stringify(v),{status:v.error?400:200,headers:{'content-type':'application/json'}});
   };
  }''')
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT));page.wait_for_function("document.getElementById('injectiveActionAccount')?.options.length===1")
  page.locator('#nonEvmHistory').click();page.wait_for_selector('.injective-recovery')
  old=page.locator('#nonEvmJournal article').filter(has_text='uncertain-deposit');included=page.locator('#nonEvmJournal article').filter(has_text='included-failure')
  inspect=old.get_by_role('button',name='送信試行済み取引の期限・復旧条件を確認')
  assert inspect.count()==1 and old.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==0
  steps.append('Submitted record offers a separately named expiry inspection, never an initial send or unsent control')
  assert included.locator('.injective-recovery').count()==0;steps.append('Included failures are not offered submission-expiry retirement')
  for bad in ['schema','hash']:
   page.evaluate('(x)=>window.__bad=x',bad);inspect.click();page.wait_for_function("document.getElementById('message').textContent.includes('INJECTIVE_RECOVERY_REVIEW_BINDING')")
   assert old.get_by_role('button',name='旧送信試行記録を終了する（再送しない）').count()==0
  steps.append('Wrong receipt type or transaction identity cannot display an actionable owner confirmation')
  page.evaluate('window.__bad=null');inspect.click();old.get_by_label('復旧確認SHA-256を全文再入力').wait_for()
  assert page.evaluate('window.__commits')==0 and page.evaluate('window.__records[0].state')=='broadcast-unknown';steps.append('Inspection alone cannot write, sign, send, or mark history unsent')
  text=old.inner_text();assert '送信の可能性を残す' in text and '9007199254740993' in text and '9007199254740994' in text;steps.append('Original uncertainty and exact large timeout heights remain visible')
  confirm=old.get_by_role('button',name='旧送信試行記録を終了する（再送しない）')
  old.get_by_label('復旧確認SHA-256を全文再入力').fill('bad');old.get_by_label('終了する旧tx hashを全文再入力').fill('B'*64);confirm.click();page.wait_for_function("document.getElementById('message').textContent.includes('INJECTIVE_RECOVERY_CONFIRMATION_REQUIRED')");assert page.evaluate('window.__commits')==0
  steps.append('Wrong review digest refuses retirement')
  old.get_by_label('復旧確認SHA-256を全文再入力').fill('a'*64);old.get_by_label('終了する旧tx hashを全文再入力').fill('bad');confirm.click();page.wait_for_timeout(120);assert page.evaluate('window.__commits')==0;steps.append('Wrong original transaction hash also refuses retirement')
  old.get_by_label('終了する旧tx hashを全文再入力').fill('B'*64);confirm.evaluate('(b)=>{b.click();b.click();}');page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('retired-submission-expired')")
  assert page.evaluate('window.__commits')==1;steps.append('Rapid double activation writes exactly one synthetic retirement, not duplicate operations')
  assert old.get_by_role('button').count()==0 and '送信した可能性を残したまま' in old.inner_text() and 'SUBMISSION_STARTING' in old.inner_text() and 'B'*64 in old.inner_text();steps.append('Retired history keeps the prior report/hash and uncertainty; old actions disappear')
  assert not page.evaluate("window.__calls.some(x=>x.route.endsWith('/submit')||x.route==='non-evm/approve')");steps.append('The recovery UI never signs, broadcasts, or creates a replacement transaction')
  for w in [390,768,1280]:
   page.set_viewport_size({'width':w,'height':950});page.wait_for_timeout(60);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  steps.append('No horizontal overflow at 390/768/1280px');page.locator('#nonEvmJournal').screenshot(path=str(out/'submitted-expiry.png'))
  assert not errors,errors;steps.append('No page JavaScript error');browser.close()
 result={'schema':'realdex.inj10-browser-dom.v1','mode':'synthetic-owner-api-real-chromium-dom','passed':True,'stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realChain':False};(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);args=p.parse_args();print(json.dumps(run(args.output),ensure_ascii=False))
