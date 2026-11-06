#!/usr/bin/env python3
"""Offline DOM and mocked APIs ONLY: no real HTTP/CSP, signatures or ledger execution."""
import argparse,json,re,subprocess
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 pairs=json.loads(subprocess.run(['node','--input-type=module','-e',"import {keyInfo} from './wallet/lib/keys.mjs';console.log(JSON.stringify(Object.fromEntries(['stellar','aptos'].map(f=>[f,{from:keyInfo(f,Buffer.alloc(32,49)).address,to:keyInfo(f,Buffer.alloc(32,50)).address}]))));"],cwd=ROOT,check=True,capture_output=True,text=True).stdout)
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''pairs=>{
   window.__calls=[];window.__records=[];window.__pairs=pairs;
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:['stellar','aptos'].map(f=>({id:f,family:f,kind:'local',address:pairs[f].from,label:'公開試験鍵・合成画面データ'})),networks:[],bitcoinNetworks:[],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[],accountNetworks:['stellar','aptos'].map(f=>({family:f,id:f==='stellar'?'stellar:standalone':'aptos:local-4',name:f.toUpperCase()+' LOCAL / SYNTHETIC',broadcastEnabled:true,checkpoint:{height:1,hash:'1'.repeat(64)}}))};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_FORBIDDEN');if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OWNER_AUTH_MISSING');
    const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let result={};
    if(route==='status')result=structuredClone(window.__state);
    else if(route==='non-evm/account-online/balance'){
     if(window.__delayBalance)await new Promise(r=>window.__releaseBalance=r);
     result={account:{balanceAtomic:'10000000000',sequence:'7'},decimals:b.accountId==='stellar'?7:8,asset:b.accountId==='stellar'?'XLM':'APT'};
    }else if(route==='non-evm/account-online/prepare'){
     const family=b.accountId,summary={family,operation:family==='stellar'?'stellar-native-payment-online':'aptos-native-transfer-online',networkId:b.networkId,from:pairs[family].from,recipient:b.payment.to,amountAtomic:family==='stellar'?'1000000':'10000000',feeAtomic:family==='stellar'?'100':'100000',feeIsMaximum:family==='aptos',asset:family==='stellar'?'XLM':'APT',requestKey:b.payment.requestKey,networkFingerprint:'f'.repeat(64),checkpoint:{height:1,hash:'1'.repeat(64)},transfer:{...b.payment,sequence:'8'},assurance:'SYNTHETIC',submissionEnabled:true};
     const req={id:'request-'+family,kind:'non-evm-account-online',intentId:'intent-'+family,expiresAt:Date.now()+60000,summary,origin:'http://127.0.0.1:8790'};window.__state.pending=[req];
     if(window.__delayPrepare)await new Promise(r=>window.__releasePrepare=r);result=req;
    }else if(route==='non-evm/approve'){
     const r=window.__state.pending[0];if(b.confirmation!==r.summary.recipient)result={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
     else{const record={id:'record-'+r.summary.family,family:r.summary.family,state:b.broadcast?'broadcast':'signed',summary:r.summary,requestKey:r.summary.requestKey,signed:{requestId:(r.summary.family==='aptos'?'0x':'')+'2'.repeat(64)},report:{observedAt:Date.now(),received:false,reason:'SYNTHETIC_ACCEPTANCE'}};window.__records.push(record);window.__state.pending=[];result={record};}
    }else if(route==='non-evm/account-online/reconcile'){
     const r=window.__records.find(r=>r.id===b.id);r.state=window.__missing?'broadcast-unknown':'reported-confirmed';r.report={received:!window.__missing,confirmations:window.__missing?0:2,ledger:11,version:r.family==='aptos'?'101':undefined,reason:window.__missing?'MISSING_OR_REORG':'SYNTHETIC_ONLY',observedAt:Date.now(),finalityProven:false};result=r;
    }else if(route==='non-evm/history')result={records:structuredClone(window.__records)};
    else if(route==='reject')window.__state.pending=[];
    else if(route==='lock'||route==='non-evm/account-online/networks/add'){window.__state.locked=true;window.__state.pending=[];}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED: '+route);
    return new Response(JSON.stringify(result),{status:result.error?400:200});
   };
  }''',pairs)
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('accountCount').textContent==='2'")
  assert page.locator('#accountOnlineNetwork option').count()==2;steps.append('Only two explicitly configured local networks displayed')
  assert page.evaluate("window.__calls.every(c=>!c.route.includes('account-online/'))");steps.append('Page load does not query balances, sign or send')
  for family,net in [('stellar','stellar:standalone'),('aptos','aptos:local-4')]:
   page.select_option('#accountOnlineNetwork',net)
   assert page.locator('#accountOnlineAccount').input_value()==family
   assert page.locator('#stellarOnlineFields').is_visible()==(family=='stellar');assert page.locator('#aptosOnlineFields').is_visible()==(family=='aptos');steps.append(family+' account and fee fields isolated')
   page.locator('#accountOnlineBalance').click();page.wait_for_function("document.getElementById('accountOnlineResult').textContent.includes('sequence 7')");steps.append(family+' balance explicitly queried with nonproof label')
   page.fill('#accountOnlineRecipient',pairs[family]['to']);page.fill('#accountOnlineAmount','0.1');page.fill('#accountOnlineKey','offline-ui-'+family)
   page.locator('#accountOnlineForm button[type=submit]').click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('ローカル送金')")
   card=page.locator('#pending .request-card').first
   assert not card.locator('input[type=checkbox]').is_checked()
   assert 'checkpoint' in card.inner_text() and 'sequence' in card.inner_text() and '独立した決済証明ではありません' in card.inner_text();steps.append(family+' review binds conditions and starts broadcast OFF')
   assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').length")== (0 if family=='stellar' else 1)
   card.locator('input:not([type=checkbox])').fill(pairs[family]['to']);card.locator('input[type=checkbox]').check();card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click()
   page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");page.get_by_role('button',name=family.upper()+'の状態を再照合',exact=True).click()
   page.wait_for_function("f=>document.getElementById('nonEvmJournal').textContent.includes(f+' · reported-confirmed')",arg=family.upper())
   assert '独立証明ではない' in page.locator('#nonEvmJournal').inner_text();steps.append(family+' explicit owner approve and reconcile remain RPC observations')
  page.evaluate('window.__missing=true');page.get_by_role('button',name='APTOSの状態を再照合',exact=True).click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('APTOS · broadcast-unknown')");steps.append('Missing evidence withdraws prior receipt')
  page.evaluate('window.__delayBalance=true');page.locator('#accountOnlineBalance').click();page.wait_for_function('typeof window.__releaseBalance==="function"');page.fill('#accountOnlineAmount','0.2');page.evaluate('window.__releaseBalance()');page.wait_for_function("document.getElementById('message').textContent.includes('ACCOUNT_FORM_CHANGED')");assert page.locator('#accountOnlineResult').inner_text()=='';steps.append('Edited amount invalidates late balance')
  page.evaluate('window.__delayBalance=false;window.__delayPrepare=true');page.fill('#accountOnlineKey','offline-ui-late');page.locator('#accountOnlineForm button[type=submit]').click();page.wait_for_function('typeof window.__releasePrepare==="function"');page.fill('#accountOnlineAmount','0.3');page.evaluate('window.__releasePrepare()');page.wait_for_function("window.__calls.some(c=>c.route==='reject')");page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Edited form rejects late prepared request at server')
  page.evaluate("document.getElementById('accountOnlineSection').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE DOM / 合成API。実Stellar・Aptosの試験ではありません。</p>')")
  page.locator('#accountOnlineSection').screenshot(path=str(out/'account-online-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');steps.append('390px mobile no document overflow');page.locator('#accountOnlineSection').screenshot(path=str(out/'account-online-mobile.png'))
  page.locator('#lock').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent===''");assert page.locator('#accountOnlineResult').inner_text()=='';steps.append('Lock clears visible balances and journal')
  assert errors==[],errors
  report={'status':'passed','mode':'offline DOM with mocked API, NOT HTTP/CSP or real chain','checks':len(steps),'steps':steps,'pageErrors':errors,'realHttpIntegration':False,'realChainExecution':False,'browser':browser.version};(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));browser.close();return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
