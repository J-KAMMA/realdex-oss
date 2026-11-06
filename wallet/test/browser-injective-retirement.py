#!/usr/bin/env python3
"""Real Chromium, synthetic owner API. No keys or external chain traffic."""
import argparse,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_source import frontend_source
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=True);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1280,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate(r'''()=>{
   window.__calls=[];window.__records=[{id:'old',accountId:'evm',family:'injective',state:'signed',requestKey:'old-never-submitted',createdAt:1,summary:{operation:'injective-withdraw-local',action:'withdraw',recipient:'inj1owner',marketId:'inj1owner',amountAtomic:'9007199254740993',reviewSha256:'f'.repeat(64),subaccountId:'0x'+'1'.repeat(64)},signed:{requestId:'B'.repeat(64)}},{id:'unknown',family:'injective',state:'broadcast-unknown',requestKey:'uncertain',createdAt:2,summary:{recipient:'inj1owner',amountAtomic:'1'},signed:{requestId:'C'.repeat(64)}}];
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'evm',family:'evm',kind:'local',address:'0x'+'1'.repeat(40),label:'Owner'}],networks:[],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[]};
   window.__review={schema:'realdex.injective-unsent-retirement-review.v1',neverSubmittedByWallet:true,recordId:'old',transactionHash:'B'.repeat(64),reviewSha256:'a'.repeat(64),boundary:{timeoutHeight:'9007199254740993'},evidence:{height:'9007199254740994'},note:'<img src=x onerror=alert(1)>',chainStateAuthenticated:false,settlementVerified:false};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('EXTERNAL_NETWORK_FORBIDDEN');const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let v={};
    if(route==='status')v=structuredClone(window.__state);
    else if(route==='non-evm/history')v={records:structuredClone(window.__records)};
    else if(route==='non-evm/injective/recovery/prepare')v=structuredClone(window.__review);
    else if(route==='non-evm/injective/recovery/retire'){
     if(body.confirmation!=='a'.repeat(64)||body.transactionHash!=='B'.repeat(64))v={error:'INJECTIVE_RECOVERY_CONFIRMATION_REQUIRED'};
     else{const r=window.__records[0];r.state='retired-unsent-expired';r.retirement={check:{height:window.__review.evidence.height}};v=structuredClone(r);}
    }else if(route==='lock'){window.__state.locked=true;v={locked:true};}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED '+route);
    return new Response(JSON.stringify(v),{status:v.error?400:200,headers:{'content-type':'application/json'}});
   };
  }''')
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('injectiveActionAccount')?.options.length===1")
  page.locator('#nonEvmHistory').click();page.wait_for_selector('.injective-recovery');assert page.get_by_role('button',name='未送信取引の期限・復旧条件を確認').count()==1
  unknown=page.locator('#nonEvmJournal article').filter(has_text='uncertain');assert unknown.get_by_role('button',name='未送信取引の期限・復旧条件を確認').count()==0;steps.append('Only signed records offer recovery; unknown records retain read-only reconciliation')
  page.get_by_role('button',name='未送信取引の期限・復旧条件を確認').click();page.get_by_label('復旧確認SHA-256を全文再入力').wait_for();assert page.evaluate("window.__records[0].state")=='signed';assert not page.evaluate("window.__calls.some(x=>x.route.endsWith('/submit'))");steps.append('Inspection alone neither retires nor submits anything')
  text=page.locator('.injective-recovery').inner_text();assert '9007199254740993' in text and '9007199254740994' in text;assert '同じローカルノードの観測' in text;assert '削除しません' in text;assert page.locator('#nonEvmJournal img').count()==0;steps.append('Exact large height strings and local-observation/no-delete warning are displayed as text')
  page.get_by_label('復旧確認SHA-256を全文再入力').fill('wrong');page.get_by_label('終了する旧tx hashを全文再入力').fill('B'*64);page.get_by_role('button',name='旧未送信記録を終了する（送信しない）').click();page.wait_for_function("document.getElementById('message').textContent.includes('INJECTIVE_RECOVERY_CONFIRMATION_REQUIRED')");assert page.evaluate("window.__records[0].state")=='signed';steps.append('Wrong recovery confirmation does not retire the record')
  page.get_by_label('復旧確認SHA-256を全文再入力').fill('a'*64);page.get_by_label('終了する旧tx hashを全文再入力').fill('wrong');page.get_by_role('button',name='旧未送信記録を終了する（送信しない）').click();page.wait_for_timeout(100);assert page.evaluate("window.__records[0].state")=='signed';steps.append('The old transaction hash also requires explicit confirmation')
  page.get_by_label('終了する旧tx hashを全文再入力').fill('B'*64);page.get_by_role('button',name='旧未送信記録を終了する（送信しない）').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('retired-unsent-expired')");
  r=page.locator('#nonEvmJournal article').filter(has_text='old-never-submitted');assert r.get_by_role('button').count()==0;assert '未送信記録の終了' in r.inner_text();assert '資金返還' in r.inner_text();assert 'B'*64 in r.inner_text();steps.append('Retired history remains visible; old submit/reconcile/recovery controls are absent')
  payload=page.evaluate("window.__calls.filter(c=>c.route.endsWith('/retire')).at(-1).body");assert payload['review']['reviewSha256']=='a'*64 and payload['confirmation']=='a'*64 and payload['transactionHash']=='B'*64;assert not page.evaluate("window.__calls.some(c=>c.route.endsWith('/submit')||c.route==='non-evm/approve')");steps.append('Retirement forwards only the approved recovery receipt, never signing or sending')
  for width in [390,768,1280]:
   page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  steps.append('No horizontal overflow at 390/768/1280 pixels');page.locator('#nonEvmJournal').screenshot(path=str(out/'retirement.png'))
  assert not errors,errors;steps.append('No page JavaScript errors');browser.close()
 result={'mode':'synthetic-dom','passed':True,'stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realChain':False};(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);args=p.parse_args();print(json.dumps(run(args.output),ensure_ascii=False))
