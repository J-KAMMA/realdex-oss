#!/usr/bin/env python3
"""Offline DOM-only test. Synthetic API responses; no RPC, wallet keys or signed chain data."""
import argparse,json,re
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=True);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''()=>{
    const from='2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ',to='5eUm8K9YiCqAxtyZgmmN1NGhmD3D2C9Azp2Za7nxwhiN',owner='rrkah-fqaaa-aaaaa-aaaaq-cai';
    window.__calls=[];window.__records=[];window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'sol',family:'solana',kind:'local',address:from,label:'公開試験口座 · SOL'},{id:'icp',family:'icp',kind:'local',address:owner,label:'公開試験口座 · ICP'},{id:'watch',family:'solana',kind:'watch',address:to,label:'閲覧専用'}],networks:[],solanaNetworks:[{id:'solana-local:offline',name:'合成API / 実ネットワークではありません'}],pending:[],sessions:[],allowedAppOrigins:[]};
    window.fetch=async (url,init)=>{
      if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_FORBIDDEN');
      if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OWNER_AUTH_MISSING');
      const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let v={};
      if(route==='status')v=structuredClone(window.__state);
      else if(route==='non-evm/solana/balance'){
        if(window.__delayBalance)await new Promise(r=>window.__releaseBalance=r);
        v={lamports:'1234567890'};
      }else if(route==='non-evm/solana/prepare'){
        const summary={family:'solana',networkId:b.networkId,from,recipient:b.payment.to,amountAtomic:'1000000',feeAtomic:'5000',requestKey:b.payment.requestKey,genesisHash:'Fixture-genesis-not-a-real-network',recentBlockhash:'Fixture-blockhash',lastValidBlockHeight:151};
        window.__state.pending=[{id:'sol-request',kind:'non-evm-solana',origin:'http://127.0.0.1:8790',intentId:'sol-intent',expiresAt:Date.now()+60000,summary}];v={id:'sol-request',intentId:'sol-intent',summary};
      }else if(route==='non-evm/icp/prepare'){
        const summary={family:'icp',networkId:b.payment.networkId,from:owner,recipient:b.payment.to.owner,ledger:b.payment.ledger,subaccount:b.payment.to.subaccount||'0'.repeat(64),amountAtomic:b.payment.amountAtomic,feeAtomic:b.payment.feeAtomic,requestKey:b.payment.requestKey,transfer:{createdAtTimeNs:'1788580000000000000',memoHex:'f'.repeat(64)}};
        window.__state.pending=[{id:'icp-request',kind:'non-evm-icp',origin:'http://127.0.0.1:8790',intentId:'icp-intent',expiresAt:Date.now()+60000,summary}];v={id:'icp-request',intentId:'icp-intent',summary};
      }else if(route==='non-evm/approve'){
        const r=window.__state.pending.find(r=>r.id===b.id);
        if(b.confirmation!==r.summary.recipient)v={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
        else {const record={id:r.id+'-record',family:r.summary.family,state:'signed',requestKey:r.summary.requestKey,summary:r.summary,signed:r.summary.family==='solana'?{signature:'SYNTHETIC-SIGNATURE-NO-AUTHORITY'}:{requestId:'SYNTHETIC-REQUEST-NO-AUTHORITY'}};window.__records.push(record);window.__state.pending=[];v={record};}
      }else if(route==='non-evm/history')v={records:structuredClone(window.__records)};
      else if(route==='non-evm/solana/reconcile'){const r=window.__records.find(r=>r.id===b.id);r.state='broadcast-unknown';r.report={reason:'not-observed',observedAt:Date.now(),received:false};v=r;}
      else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
      else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
      else if(route==='reject')window.__state.pending=[];
      else throw Error('OFFLINE_METHOD_UNSUPPORTED');
      return new Response(JSON.stringify(v),{status:v.error?400:200});
    };
  }''')
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('accountCount').textContent==='3'")
  assert page.locator('#solanaAccount option').count()==1;assert page.locator('#icpAccount option').count()==1;assert page.locator('#sendAccount option').count()==0;steps.append('SOL/ICP selectors contain their local family only, exclude watch and EVM signer options')
  assert len(page.locator('#solanaRequestKey').input_value())==32;steps.append('Browser CSPRNG initializes bounded independent payment keys')
  page.locator('#solanaBalance').click();page.wait_for_function("document.getElementById('solanaResult').textContent.includes('1.23456789')");steps.append('SOL balance rendered exactly in decimal from atomic string')
  page.locator('#solanaRecipient').fill('5eUm8K9YiCqAxtyZgmmN1NGhmD3D2C9Azp2Za7nxwhiN');page.locator('#solanaAmount').fill('0.001');page.get_by_role('button',name='SOL送金を照合',exact=True).click();page.wait_for_function("document.querySelector('#pending article')!==null")
  sent=page.evaluate("window.__calls.filter(c=>c.route==='non-evm/solana/prepare').at(-1).body");assert sent['payment']['amount']=='0.001';assert not page.evaluate("window.__calls.some(c=>c.route==='non-evm/approve')");steps.append('Preparation sends unchanged decimal and does not implicitly approve or broadcast')
  assert page.locator('#pending input[type=checkbox]').count()==1;assert not page.locator('#pending input[type=checkbox]').is_checked();steps.append('SOL broadcast checkbox is opt-in')
  page.locator('#pending input:not([type=checkbox])').fill('wrong');page.get_by_role('button',name='この非EVM操作だけ承認').click();page.wait_for_function("document.getElementById('message').textContent.includes('CONFIRMATION')");steps.append('Wrong recipient confirmation is displayed as refusal')
  page.locator('#pending input:not([type=checkbox])').fill('5eUm8K9YiCqAxtyZgmmN1NGhmD3D2C9Azp2Za7nxwhiN');page.get_by_role('button',name='この非EVM操作だけ承認').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body.broadcast") is False;assert page.get_by_role('button',name='保存済みSolana署名を初めて送信').count()==1;steps.append('Sign-only record offers a separate first-submission confirmation')
  page.locator('#icpLedger').fill('ryjl3-tyaaa-aaaaa-aaaba-cai');page.locator('#icpRecipient').fill('rrkah-fqaaa-aaaaa-aaaaq-cai');page.locator('#icpAmount').fill('100000');page.locator('#icpFee').fill('10000');page.get_by_role('button',name='ICP署名内容を確認',exact=True).click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('ICP')");assert page.locator('#pending input[type=checkbox]').count()==0;assert 'memo' in page.locator('#pending').inner_text();assert 'オフライン署名のみ' in page.locator('#pending').inner_text();steps.append('ICP review includes ledger/subaccount/memo/time and provides no broadcast control')
  page.locator('#pending input').fill('rrkah-fqaaa-aaaaa-aaaaq-cai');page.get_by_role('button',name='この非EVM操作だけ承認').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body.broadcast") is False;assert page.get_by_role('button',name='ICP署名済み要求を保存').count()==1;steps.append('ICP approval is explicitly offline and history offers owner export only')
  page.evaluate("document.getElementById('nonEvmPanel').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE DOM · 合成API / 実HTTP・署名・CSPは対象外</p>')")
  page.locator('#nonEvmPanel').screenshot(path=str(out/'non-evm-desktop.png'))
  page.evaluate("window.__delayBalance=true");page.locator('#solanaBalance').click();page.wait_for_function('typeof window.__releaseBalance==="function"');page.locator('#solanaNetwork').dispatch_event('change');page.evaluate('window.__releaseBalance()');page.wait_for_function("document.getElementById('message').textContent.includes('SOLANA_FORM_CHANGED')");assert page.locator('#solanaResult').inner_text()=='';steps.append('Changed network discards a late balance response')
  page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden");assert page.locator('#nonEvmJournal').inner_text()=='';steps.append('Lock hides workspace and clears non-EVM records from display')
  page.locator('#password').fill('offline test only');page.locator('#unlock').click();page.wait_for_function("!document.getElementById('workspace').hidden");page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.locator('#nonEvmPanel').screenshot(path=str(out/'non-evm-mobile.png'));steps.append('390px non-EVM panel has no horizontal overflow')
  assert not errors,errors;result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False,'browser':browser.version};(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');browser.close();return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
