#!/usr/bin/env python3
"""Offline DOM using synthetic API responses only, not live HTTP/CSP/chain verification."""
import argparse,json,re,subprocess
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 pairs=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {keyInfo} from './wallet/lib/keys.mjs';console.log(JSON.stringify({from:keyInfo('cosmos',Buffer.alloc(32,49)).address,to:keyInfo('cosmos',Buffer.alloc(32,50)).address}));"],cwd=ROOT,text=True))
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''pairs=>{
   window.__calls=[];window.__records=[];
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'cosmos',family:'cosmos',kind:'local',address:pairs.from,label:'PUBLIC TEST KEY / 合成画面データ'}],networks:[],bitcoinNetworks:[],solanaNetworks:[],accountNetworks:[],pending:[],sessions:[],allowedAppOrigins:[],cosmosNetworks:[{family:'cosmos',id:'cosmos:realdex-local-test',name:'LOCAL COSMOS / SYNTHETIC',broadcastEnabled:true,checkpoint:{height:1,hash:'1'.repeat(64)},denom:'stake',decimals:6,symbol:'SIM',feeDenom:'ugas',feeDecimals:6,maxFeeAtomic:'10000'}]};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/')||init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OFFLINE_NETWORK_FORBIDDEN');
    const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let result={};
    if(route==='status')result=structuredClone(window.__state);
    else if(route==='non-evm/cosmos-online/balance'){
     if(window.__delayBalance)await new Promise(r=>window.__releaseBalance=r);
     result={account:{balanceAtomic:'1000000000',feeBalanceAtomic:'1000000',accountNumber:'1',sequence:'7'},decimals:6,symbol:'SIM',asset:'stake',feeAsset:'ugas',feeDecimals:6,head:{height:10}};
    }else if(route==='non-evm/cosmos-online/prepare'){
     const summary={family:'cosmos',operation:'cosmos-bank-send-online',networkId:b.networkId,from:pairs.from,networkFrom:pairs.from,recipient:b.payment.to,amountAtomic:'1250000',feeAtomic:'500',asset:'stake',assetSymbol:'SIM',decimals:6,feeAsset:'ugas',feeDecimals:6,requestKey:b.payment.requestKey,checkpoint:{height:1,hash:'1'.repeat(64)},networkFingerprint:'f'.repeat(64),transfer:{...b.payment,chainId:'realdex-local-test',denom:'stake',feeDenom:'ugas',amountAtomic:'1250000',accountNumber:'1',sequence:'7',timeoutHeight:'30'},submissionEnabled:!window.__disabled};
     result={id:'request-cosmos',kind:'non-evm-cosmos-online',intentId:'intent-cosmos',expiresAt:Date.now()+60000,summary,origin:'http://127.0.0.1:8790'};window.__state.pending=[result];
     if(window.__delayPrepare)await new Promise(r=>window.__releasePrepare=r);
    }else if(route==='non-evm/approve'){
     const r=window.__state.pending[0];if(b.confirmation!==r.summary.recipient)result={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
     else{const record={id:'record-cosmos',family:'cosmos',state:b.broadcast?'broadcast':'signed',summary:r.summary,requestKey:r.summary.requestKey,signed:{requestId:'2'.repeat(64)}};window.__records=[record];window.__state.pending=[];result={record};}
    }else if(route==='non-evm/cosmos-online/reconcile'){
     const r=window.__records[0];r.state=window.__missing?'broadcast-unknown':'reported-confirmed';r.report={received:!window.__missing,confirmations:2,height:11,reason:window.__missing?'MISSING':'SYNTHETIC_ONLY',observedAt:Date.now(),finalityProven:false};result=r;
    }else if(route==='non-evm/history')result={records:structuredClone(window.__records)};
    else if(route==='reject')window.__state.pending=[];
    else if(route==='lock'||route==='non-evm/cosmos-online/networks/add'){window.__state.locked=true;window.__state.pending=[];}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED:'+route);
    return new Response(JSON.stringify(result),{status:result.error?400:200});
   };
  }''',pairs)
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('accountCount').textContent==='1'")
  assert page.locator('#cosmosOnlineNetwork option').count()==1;steps.append('Only configured network and Cosmos account appear')
  assert page.evaluate("window.__calls.every(c=>!c.route.includes('cosmos-online'))");steps.append('Page load performs no chain reads or transfers')
  page.locator('#cosmosOnlineBalance').click();page.wait_for_function("document.getElementById('cosmosOnlineResult').textContent.includes('sequence 7')")
  assert '手数料残高: 1.0 ugas' in page.locator('#cosmosOnlineResult').inner_text();steps.append('Transfer denomination and fee balance are separate and exact')
  page.fill('#cosmosOnlineRecipient',pairs['to']);page.fill('#cosmosOnlineAmount','1.25');page.fill('#cosmosOnlineKey','offline-cosmos-1');page.locator('#cosmosOnlineForm button[type=submit]').click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('Cosmos')")
  card=page.locator('#pending .request-card').first;assert not card.locator('input[type=checkbox]').is_checked();steps.append('Broadcast is off by default')
  text=card.inner_text();assert 'accountNumber' in text and 'timeoutHeight' in text and 'sequence' in text and '0.0005 ugas' in text and '1.25 SIM' in text;steps.append('Owner review shows complete signing conditions and proper units')
  assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').length")==0;steps.append('Preview does not sign')
  card.locator('input:not([type=checkbox])').fill('wrong');card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('message').textContent.includes('確認')||document.getElementById('message').textContent.includes('TRANSACTION_CONFIRMATION_MISMATCH')")
  assert page.evaluate('window.__records.length')==0;steps.append('Wrong recipient confirmation is not approved')
  card=page.locator('#pending .request-card').first;card.locator('input:not([type=checkbox])').fill(pairs['to']);card.locator('input[type=checkbox]').check();card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Explicit owner approval creates journal entry')
  page.get_by_role('button',name='COSMOSの状態を再照合',exact=True).click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('reported-confirmed')")
  assert '独立証明ではない' in page.locator('#nonEvmJournal').inner_text();steps.append('Reconciled observation stays explicitly unproven')
  page.evaluate('window.__missing=true');page.get_by_role('button',name='COSMOSの状態を再照合',exact=True).click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('broadcast-unknown')");steps.append('Missing evidence removes successful observation')
  page.evaluate('window.__delayBalance=true');page.locator('#cosmosOnlineBalance').click();page.wait_for_function('typeof window.__releaseBalance==="function"');page.fill('#cosmosOnlineAmount','2');page.evaluate('window.__releaseBalance()');page.wait_for_function("document.getElementById('message').textContent.includes('COSMOS_FORM_CHANGED')");assert page.locator('#cosmosOnlineResult').inner_text()=='';steps.append('Amount edit discards late balance')
  page.evaluate('window.__delayBalance=false;window.__delayPrepare=true');page.fill('#cosmosOnlineKey','offline-late');page.locator('#cosmosOnlineForm button[type=submit]').click();page.wait_for_function('typeof window.__releasePrepare==="function"');page.fill('#cosmosOnlineAmount','3');page.evaluate('window.__releasePrepare()');page.wait_for_function("window.__calls.some(c=>c.route==='reject')");page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Edited form cancels late prepared request')
  page.evaluate('window.__delayPrepare=false;window.__disabled=true');page.locator('#cosmosOnlineForm button[type=submit]').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='1'");assert page.locator('#pending input[type=checkbox]').is_disabled();steps.append('Broadcast-disabled network disables submit control')
  page.evaluate("document.getElementById('cosmosOnlineSection').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE DOM / 合成API。実HTTP・CSP・チェーンの試験ではありません。</p>')")
  page.locator('#cosmosOnlineSection').screenshot(path=str(out/'cosmos-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');steps.append('390px mobile has no horizontal document overflow');page.locator('#cosmosOnlineSection').screenshot(path=str(out/'cosmos-mobile.png'))
  page.locator('#lock').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent===''");assert page.locator('#cosmosOnlineResult').inner_text()=='';steps.append('Lock clears balances, pending requests and journal')
  assert errors==[],errors
  report={'status':'passed','checks':len(steps),'steps':steps,'pageErrors':errors,'realHttpIntegration':False,'realChainExecution':False,'mode':'offline DOM / synthetic API','browser':browser.version};(out/'results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));browser.close();return report
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);a=parser.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
