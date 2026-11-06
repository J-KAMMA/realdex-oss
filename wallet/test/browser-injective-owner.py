#!/usr/bin/env python3
"""DOM owner-flow test with synthetic API. No chain, keys, signatures, or external network."""
import argparse,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_source import frontend_source
ROOT=Path(__file__).resolve().parents[2]
HASH='a'*64; TX='B'*64

def run(out):
 out.mkdir(parents=True,exist_ok=True);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1280,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate(f'''()=>{{
   window.__calls=[];window.__records=[];window.__state={{exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{{id:'evm',family:'evm',kind:'local',address:'0x1111111111111111111111111111111111111111',label:'Injective owner'}}],networks:[],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[]}};
   window.fetch=async(url,init)=>{{if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_FORBIDDEN');const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({{route,body}});let v={{}};
    if(route==='status')v=structuredClone(window.__state);
    else if(route==='non-evm/injective/prepare'){{const review=body.review,summary={{family:'injective',networkId:'injective:injective-888',networkFrom:'inj1synthetic',from:'0x1111111111111111111111111111111111111111',recipient:'0x'+'12'.repeat(32),asset:'BASE',amountAtomic:'2000000000000000000',feeAtomic:'500000000000000',requestKey:'ui-order',reviewSha256:review.reviewSha256,marketId:'0x'+'12'.repeat(32),clientOrderId:'rdx-'+'34'.repeat(16),side:'sell',limitPrice:'11',timeoutHeight:'120',review,confirmationText:review.reviewSha256}};window.__state.pending=[{{id:'inj-pending',kind:'non-evm-injective-local',intentId:'inj-intent',expiresAt:Date.now()+60000,summary}}];v={{id:'inj-pending',intentId:'inj-intent',summary}};}}
    else if(route==='non-evm/approve'){{if(body.broadcast!==false)v={{error:'INJECTIVE_APPROVAL_STORES_BEFORE_SUBMIT'}};else if(body.confirmation!=='{HASH}')v={{error:'INJECTIVE_CONFIRMATION_REQUIRED'}};else{{const q=window.__state.pending[0],record={{id:'inj-record',family:'injective',state:'signed',requestKey:q.summary.requestKey,summary:q.summary,signed:{{requestId:'{TX}'}}}};window.__records=[record];window.__state.pending=[];v={{record}};}}}}
    else if(route==='non-evm/history')v={{records:structuredClone(window.__records)}};
    else if(route==='non-evm/injective/submit'){{const r=window.__records[0];if(body.confirmation!==r.signed.requestId)v={{error:'INJECTIVE_TXID_CONFIRMATION_REQUIRED'}};else{{r.state='broadcast-unknown';r.report={{reason:'SUBMISSION_STARTING',observedAt:Date.now(),received:false}};v=structuredClone(r);}}}}
    else if(route==='non-evm/injective/reconcile'){{const r=window.__records[0];r.state='reported-confirmed';r.report={{reason:'INCLUDED_SUCCESS',observedAt:Date.now(),received:true}};v=structuredClone(r);}}
    else if(route==='reject'){{window.__state.pending=[];v={{rejected:true}};}}
    else if(route==='lock'){{window.__state.locked=true;window.__state.pending=[];v={{locked:true}};}}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED '+route);return new Response(JSON.stringify(v),{{status:v.error?400:200,headers:{{'content-type':'application/json'}}}});
   }};
  }}''')
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('injectiveOwnerAccount')?.options.length===1")
  assert page.locator('#injectiveOwnerAccount').input_value()=='evm';steps.append('Only local EVM owner key appears in Injective selector')
  review={'schema':'realdex.injective-preflight.v1','reviewSha256':HASH,'plan':{'requestKey':'ui-order'},'note':'synthetic browser fixture'}
  page.locator('#injectiveReviewJson').fill(json.dumps(review));page.get_by_role('button',name='注文条件を承認待ちへ').click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('Injective')")
  assert page.locator('#pending input[type=checkbox]').count()==0;assert HASH in page.locator('#pending').inner_text();assert '暗号化保存' in page.locator('#pending').inner_text();steps.append('Review requires exact SHA and offers no sign-and-broadcast checkbox')
  inputs=page.locator('#pending input');inputs.fill(HASH);page.get_by_role('button',name='この非EVM操作だけ承認').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'")
  call=page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body");assert call['broadcast'] is False;assert page.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==1;steps.append('Owner approval stores signature only; first submission remains separate')
  page.get_by_label('初回送信するtx hashを全文再入力').fill(TX);page.get_by_role('button',name='保存済みInjective署名を初めて送信').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('broadcast-unknown')")
  assert page.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==0;assert '自動再送しません' in page.locator('#nonEvmJournal').inner_text();steps.append('After initial submission UI removes resend authority and keeps read-only reconciliation')
  page.get_by_role('button',name='Injectiveの収録状態を再照合').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('reported-confirmed')");steps.append('Reconciliation is a separate read-only owner action')
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');steps.append('Injective owner panel has no horizontal overflow at 390px')
  assert not errors,errors;(out/'results.json').write_text(json.dumps({'mode':'synthetic-dom','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realChain':False},ensure_ascii=False,indent=2)+'\n');browser.close();return {'stepsPassed':len(steps),'steps':steps}
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('--output',required=True,type=Path);x=a.parse_args();print(json.dumps(run(x.output),ensure_ascii=False,indent=2))
