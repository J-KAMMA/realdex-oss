#!/usr/bin/env python3
"""OFFLINE synthetic API/DOM checks. NOT real browser HTTP, crypto, CSP, or consensus."""
import argparse,json,re,subprocess
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 vectors=json.loads(subprocess.run(['node','wallet/test/expanded-vectors.mjs'],cwd=ROOT,check=True,capture_output=True,text=True).stdout)['vectors'];v=next(v for v in vectors if v['family']=='bitcoin')
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''v=>{
   window.__v=v;window.__calls=[];window.__records=[];
   window.__network={id:'bitcoin:regtest',family:'bitcoin',name:'Bitcoin Core regtest · 合成画面データ',broadcastEnabled:true,checkpoint:{height:1,hash:'c'.repeat(64)}};
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'btc',family:'bitcoin',kind:'local',address:v.payment.from,label:'使い捨てテスト口座'},{id:'watch',family:'bitcoin',kind:'watch',address:v.payment.from,label:'閲覧専用'}],networks:[],bitcoinNetworks:[window.__network],solanaNetworks:[],pending:[],sessions:[],allowedAppOrigins:[]};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_FORBIDDEN');if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OWNER_AUTH_MISSING');
    const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let result={};
    if(route==='status')result=structuredClone(window.__state);
    else if(route==='non-evm/bitcoin-online/utxos'){
     if(window.__delayScan)await new Promise(r=>window.__releaseScan=r);
     result={utxos:v.payment.utxos.map(u=>({...u,eligible:true,confirmations:102,coinbase:true,reserved:false})),eligibleSats:'200000',assurance:'SYNTHETIC-FOR-UI-ONLY'};
    }else if(route==='non-evm/bitcoin-online/prepare'){
     const summary={...structuredClone(v.summary),operation:'bitcoin-p2wpkh-online',amountAtomic:'100000',feeAtomic:'1000',checkedHeight:102,checkedBlock:'a'.repeat(64),genesisHash:'0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',checkpoint:window.__network.checkpoint,requestKey:b.payment.requestKey,transfer:{...v.payment,requestKey:b.payment.requestKey},assurance:'SYNTHETIC',submissionEnabled:true};
     window.__state.pending=[{id:'btc-request',kind:'non-evm-bitcoin-online',intentId:'btc-intent',expiresAt:Date.now()+60000,summary,origin:'http://127.0.0.1:8790'}];result=window.__state.pending[0];
    }else if(route==='non-evm/approve'){
     const r=window.__state.pending[0];if(b.confirmation!==r.summary.recipient)result={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
     else{const record={id:'btc-record',family:'bitcoin',state:b.broadcast?'broadcast':'signed',summary:r.summary,requestKey:r.summary.requestKey,signed:{requestId:'1'.repeat(64)},report:{observedAt:Date.now(),received:false,reason:'SYNTHETIC-NOT-SENT'}};window.__records.push(record);window.__state.pending=[];result={record};}
    }else if(route==='non-evm/bitcoin-online/submit'){
     if(b.confirmation!=='1'.repeat(64))result={error:'BITCOIN_TXID_CONFIRMATION_REQUIRED'};else{window.__records[0].state='broadcast';result=window.__records[0];}
    }else if(route==='non-evm/bitcoin-online/reconcile'){
     const r=window.__records[0];r.state=window.__reorg?'broadcast-unknown':'reported-confirmed';r.report={received:!window.__reorg,confirmations:window.__reorg?0:2,blockHash:window.__reorg?null:'a'.repeat(64),reason:window.__reorg?'MISSING_OR_REORG':'SYNTHETIC_CONFIRMED',observedAt:Date.now()};result=r;
    }else if(route==='non-evm/history')result={records:structuredClone(window.__records)};
    else if(route==='lock'||route==='non-evm/bitcoin-online/networks/add'){window.__state.locked=true;window.__state.pending=[];}
    else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
    else if(route==='reject')window.__state.pending=[];
    else throw Error('OFFLINE_METHOD_UNSUPPORTED');
    return new Response(JSON.stringify(result),{status:result.error?400:200});
   };
  }''',v)
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('accountCount').textContent==='2'")
  assert page.locator('#bitcoinAccount option').count()==1;steps.append('Bitcoin selector excludes watch-only accounts')
  assert page.locator('#bitcoinNetwork option').count()==1;steps.append('Only explicitly registered network appears')
  assert page.evaluate("window.__calls.every(c=>!c.route.includes('bitcoin-online/'))");steps.append('No automatic scan, signing or submission on page load')
  page.locator('#bitcoinScan').click();page.wait_for_function("document.getElementById('bitcoinScanResult').textContent.includes('200000')");assert len(json.loads(page.locator('#bitcoinUtxos').input_value()))==1;steps.append('Explicit UTXO scan displays exact sats and selects one eligible input')
  page.locator('#bitcoinRecipient').fill(v['payment']['to']);page.locator('#bitcoinAmount').fill('0.001');page.locator('#bitcoinSendForm button[type=submit]').click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('Bitcoin regtest')")
  assert page.evaluate("window.__calls.find(c=>c.route.endsWith('bitcoin-online/prepare')).body.payment.amount")=='0.001';steps.append('BTC decimal stays a string until service conversion')
  assert not page.locator('#pending input[type=checkbox]').is_checked();steps.append('Broadcast remains OFF by default at approval')
  text=page.locator('#pending').inner_text();assert '1000 satoshi' in text and '0.00001 BTC' in text and '1000 BTC' not in text;steps.append('Fee display distinguishes BTC and satoshi, avoiding 100000000x unit confusion')
  assert 'checkpoint' in text and '分散合意' in text and v['payment']['to'] in text;steps.append('Review shows recipient, complete transaction conditions, checkpoint and evidence limitations')
  page.locator('#pending input:not([type=checkbox])').fill('wrong');page.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('message').textContent.includes('CONFIRMATION')");steps.append('Wrong recipient confirmation displays refusal')
  page.locator('#pending input:not([type=checkbox])').fill(v['payment']['to']);page.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body.broadcast") is False;steps.append('Unchecked confirmation produces signed-only record')
  card=page.locator('#nonEvmJournal article').first;assert card.get_by_role('button',name='保存済みBitcoin署名を初めて送信',exact=True).count()==1;steps.append('Saved signature has a separate first-submission confirmation')
  card.locator('input').fill('wrong');card.get_by_role('button',name='保存済みBitcoin署名を初めて送信',exact=True).click();page.wait_for_function("document.getElementById('message').textContent.includes('TXID')");steps.append('Initial submission requires full transaction ID')
  card.locator('input').fill('1'*64);card.get_by_role('button',name='保存済みBitcoin署名を初めて送信',exact=True).click();page.wait_for_function("document.querySelector('#nonEvmJournal h3').textContent.includes('broadcast')");assert page.get_by_role('button',name='保存済みBitcoin署名を初めて送信',exact=True).count()==0;steps.append('Submission button disappears after sending; no re-sign or RBF button')
  page.get_by_role('button',name='Bitcoinの収録状態を再照合',exact=True).click();page.wait_for_function("document.querySelector('#nonEvmJournal h3').textContent.includes('reported-confirmed')");assert '独立証明ではない' in page.locator('#nonEvmJournal').inner_text();steps.append('Confirmed observation is labeled as RPC evidence, not finality proof')
  page.evaluate('window.__reorg=true');page.get_by_role('button',name='Bitcoinの収録状態を再照合',exact=True).click();page.wait_for_function("document.querySelector('#nonEvmJournal h3').textContent.includes('broadcast-unknown')");assert 'MISSING_OR_REORG' in page.locator('#nonEvmJournal').inner_text();steps.append('Changed evidence retracts prior received display')
  page.evaluate('window.__delayScan=true');page.locator('#bitcoinScan').click();page.wait_for_function('typeof window.__releaseScan==="function"');page.locator('#bitcoinAccount').dispatch_event('change');page.evaluate('window.__releaseScan()');page.wait_for_function("document.getElementById('message').textContent.includes('BITCOIN_FORM_CHANGED')");assert page.locator('#bitcoinUtxos').input_value()=='';steps.append('Late scan result is discarded after account change')
  page.evaluate("document.getElementById('bitcoinOnlineSection').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE DOM / 合成API。Bitcoin Core実行試験とは別の画面試験です。</p>')");page.locator('#bitcoinOnlineSection').screenshot(path=str(out/'bitcoin-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');steps.append('390px display has no horizontal document overflow');page.locator('#bitcoinOnlineSection').screenshot(path=str(out/'bitcoin-mobile.png'))
  page.locator('#lock').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent===''");assert page.locator('#bitcoinScanResult').inner_text()=='' and page.locator('#bitcoinUtxos').input_value()=='';steps.append('Lock removes UTXO results and visible journal')
  assert errors==[];result={'status':'passed','steps':steps,'checks':len(steps),'pageErrors':errors,'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False,'browser':browser.version};(out/'browser-bitcoin.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));browser.close();return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
