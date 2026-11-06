#!/usr/bin/env python3
"""Synthetic DOM regression for owner cancel/withdraw UI. No keys, RPC or real transactions."""
import argparse,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_source import frontend_source
ROOT=Path(__file__).resolve().parents[2]
SHA='a'*64;TX='B'*64;ORDER='0x'+'c'*64;SUB='0x'+'1'*63+'2'
def run(out):
 out.mkdir(parents=True,exist_ok=True);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text()
 html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
  page=browser.new_page(viewport={'width':1280,'height':900});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate(r"""()=>{
   window.__calls=[];window.__records=[{id:'source',accountId:'evm',family:'injective',state:'reported-confirmed',requestKey:'original',createdAt:1,summary:{operation:'injective-spot-order-local',recipient:'market',marketId:'market',amountAtomic:'2'},signed:{requestId:'C'.repeat(64)}}];
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'evm',family:'evm',kind:'local',address:'0x'+'1'.repeat(40),label:'Owner'}],networks:[],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[]};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('EXTERNAL_NETWORK_FORBIDDEN');
    const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let v={};
    if(route==='status')v=structuredClone(window.__state);
    else if(route==='non-evm/history')v={records:structuredClone(window.__records)};
    else if(route==='non-evm/injective/cancel/prepare'||route==='non-evm/injective/withdraw/prepare'){
     const action=route.includes('/cancel/')?'cancel':'withdraw';
     const summary={family:'injective',action,operation:action==='cancel'?'injective-spot-cancel-local':'injective-withdraw-local',networkId:'injective:injective-888',networkFrom:'inj1owner',from:'0x'+'1'.repeat(40),recipient:action==='cancel'?'market':'inj1owner',destination:'inj1owner',asset:'ubase',amountAtomic:action==='cancel'?'1500000000000000000':body.payment.amountAtomic,feeAtomic:body.payment.policy.maxGasFeeAtomic,requestKey:body.payment.requestKey,reviewSha256:'a'.repeat(64),marketId:action==='cancel'?'market':'inj1owner',clientOrderId:'rdx-'+ '3'.repeat(32),side:action==='cancel'?'sell':'withdraw',limitPrice:'11',timeoutHeight:'120',subaccountId:'0x'+'1'.repeat(63)+'2',orderHash:body.payment.orderHash,sourceRecordId:body.sourceRecordId,review:{schema:'realdex.injective-owner-action-review.v1',operation:action,note:'<img src=x onerror=alert(1)>'},confirmationText:'a'.repeat(64)};
     window.__state.pending=[{id:'pending-'+action,kind:'non-evm-injective-local',intentId:'intent-'+action,expiresAt:Date.now()+60000,summary}];v={id:'pending-'+action,intentId:'intent-'+action,summary};
    }else if(route==='non-evm/approve'){
     if(body.broadcast!==false||body.confirmation!=='a'.repeat(64))v={error:'CONFIRMATION'};
     else {const q=window.__state.pending[0],record={id:'record-'+q.summary.action,accountId:'evm',family:'injective',state:'signed',requestKey:q.summary.requestKey,summary:q.summary,signed:{requestId:'B'.repeat(64)}};window.__records.push(record);window.__state.pending=[];v={record};}
    }else if(route==='non-evm/injective/submit'){
     const r=window.__records.find(x=>x.id===body.id);
     if(body.confirmation!==r.signed.requestId)v={error:'TXID_CONFIRMATION'};
     else {r.state='broadcast-unknown';r.report={reason:'SUBMISSION_STARTING',observedAt:Date.now(),received:false};v=structuredClone(r);}
    }else if(route==='non-evm/injective/reconcile'){
     const r=window.__records.find(x=>x.id===body.id);r.state='reported-confirmed';r.report={reason:'INCLUDED_SUCCESS',observedAt:Date.now(),received:true,actionEffect:r.summary.action==='cancel'?{kind:'cancel',status:'observed',orderPresent:false,independentProof:false}:{kind:'withdraw',status:'observed',bankBalanceAtomic:'999999999999999999999',availableAtomic:'0',independentProof:false}};v=structuredClone(r);
    }else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];v={locked:true};}
    else if(route==='reject'){window.__state.pending=[];v={rejected:true};}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED '+route);
    return new Response(JSON.stringify(v),{status:v.error?400:200,headers:{'content-type':'application/json'}});
   };
  }""")
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('injectiveActionAccount')?.options.length===1")
  page.get_by_role('button',name='保存済み注文を読み直す').click()
  page.wait_for_function("document.getElementById('injectiveCancelSource').options.length===1")
  assert page.locator('#injectiveCancelSource').input_value()=='source';steps.append('Only confirmed local-owner create-order records are offered for cancellation')
  for kind in ['cancel','withdraw']:
   page.locator('#injectiveActionKind').select_option(kind)
   page.locator('#injectiveActionKey').fill('ui-'+kind)
   if kind=='cancel':page.locator('#injectiveCancelHash').fill(ORDER)
   else:
    assert page.locator('#injectiveCancelFields').is_hidden()
    page.locator('#injectiveActionEndpoint').fill('http://127.0.0.1:12345')
    page.locator('#injectiveActionSubaccount').fill(SUB);page.locator('#injectiveActionDenom').fill('ubase')
    page.locator('#injectiveActionAmount').fill('9007199254740993')
   page.get_by_role('button',name='取消・出金条件を照合して承認待ちへ').click()
   page.wait_for_function("window.__state.pending.length===1")
   page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes("+json.dumps('注文取消' if kind=='cancel' else '出金')+")")
   payload=page.evaluate("window.__calls.filter(c=>c.route.endsWith('/prepare')).at(-1).body")
   assert payload['accountId']=='evm';assert payload['payment']['policy']['gasLimit']=='1000000'
   if kind=='cancel':assert payload['sourceRecordId']=='source' and payload['payment']['orderHash']==ORDER
   else:assert payload['payment']['amountAtomic']=='9007199254740993' and 'destination' not in payload['payment']
   assert page.locator('#pending input[type=checkbox]').count()==0;assert page.locator('#pending img').count()==0
   steps.append(kind+': typed request preserves exact values; operation/target displayed as text, no broadcast checkbox')
   page.locator('#pending input').fill(SHA);page.get_by_role('button',name='この非EVM操作だけ承認').click()
   page.wait_for_function("window.__state.pending.length===0")
   page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('signed')")
   assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body.broadcast") is False
   assert page.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==1
   steps.append(kind+': approval signs/stores only and submission remains a separate hash confirmation')
   page.get_by_label('初回送信するtx hashを全文再入力').fill('wrong');page.get_by_role('button',name='保存済みInjective署名を初めて送信').click()
   page.wait_for_function("document.getElementById('message').textContent.includes('TXID_CONFIRMATION')")
   page.get_by_label('初回送信するtx hashを全文再入力').fill(TX);page.get_by_role('button',name='保存済みInjective署名を初めて送信').click()
   page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('broadcast-unknown')")
   assert page.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==0
   steps.append(kind+': wrong hash rejected; after first send the resend control is removed')
   card=page.locator('#nonEvmJournal article').filter(has_text='ui-'+kind)
   card.get_by_role('button',name='Injectiveの収録状態を再照合').click()
   page.wait_for_function("window.__records.find(r=>r.id==='record-"+kind+"').state==='reported-confirmed'")
   page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('収録後の別照合')")
   steps.append(kind+': post-state observation is labelled separately and never as independent settlement proof')
  for width in [390,768,1280]:
   page.set_viewport_size({'width':width,'height':900});page.wait_for_timeout(100)
   assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  steps.append('No horizontal page overflow at 390/768/1280 pixels')
  assert not errors,errors
  (out/'results.json').write_text(json.dumps({'mode':'synthetic-dom','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realChain':False},ensure_ascii=False,indent=2)+'\n')
  browser.close();return {'stepsPassed':len(steps),'pageErrors':errors}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False))
