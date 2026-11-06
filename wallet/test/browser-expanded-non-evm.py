#!/usr/bin/env python3
"""OFFLINE DOM test with synthetic API. Never counts as real HTTP/CSP/chain verification."""
import argparse,json,re,subprocess
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 vectors=json.loads(subprocess.run(['node','wallet/test/expanded-vectors.mjs'],cwd=ROOT,check=True,capture_output=True,text=True).stdout)['vectors'][:4]
 fixtures={v['family']:v for v in vectors}
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''fixtures=>{
   window.__fixtures=fixtures;window.__calls=[];window.__records=[];const from='2iXtA8oeZqUU5pofxK971TCEvFGfems2AcDRaZHKD2pQ';
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'sol',family:'solana',kind:'local',address:from,label:'合成表示用 SOL'},{id:'watch',family:'solana',kind:'watch',address:'watch-only',label:'閲覧専用'},...Object.entries(fixtures).map(([family,v])=>({id:family,family,kind:'local',address:v.payment.from,label:'合成表示用 '+family}))],networks:[],solanaNetworks:[{id:'solana-local:ui-test',name:'合成API · 実ネットワークではありません',splTokens:[{mint:'FAKE-MINT-UI-ONLY',symbol:'TEST',decimals:6,maxTransferAtomic:'100000000'}]}],pending:[],sessions:[],allowedAppOrigins:[]};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_FORBIDDEN');if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OWNER_AUTH_MISSING');
    const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let v={};
    if(route==='status')v=structuredClone(window.__state);
    else if(/^non-evm\\/(bitcoin|cosmos|stellar|aptos)\\/prepare$/.test(route)){
     const family=route.split('/')[1],summary=structuredClone(fixtures[family].summary);summary.expiresAt=Date.now()+60000;
     window.__state.pending=[{id:family+'-request',kind:'non-evm-'+family,origin:'http://127.0.0.1:8790',intentId:family+'-intent',expiresAt:summary.expiresAt,summary}];v={id:family+'-request',summary,submissionEnabled:false};
    }else if(route==='non-evm/spl/prepare'){
     const summary={family:'solana',operation:'spl-transfer-checked',networkId:b.networkId,from,recipient:b.payment.to,asset:'TEST',decimals:6,amountAtomic:'1250000',feeAtomic:'5000',feeAsset:'SOL',mint:b.payment.mint,source:b.payment.source,destination:b.payment.destination,requestKey:b.payment.requestKey,genesisHash:'SYNTHETIC',recentBlockhash:'SYNTHETIC',lastValidBlockHeight:150};window.__state.pending=[{id:'spl-request',kind:'non-evm-spl',origin:'http://127.0.0.1:8790',intentId:'spl-intent',expiresAt:Date.now()+60000,summary}];v={id:'spl-request',summary};
    }else if(route==='non-evm/spl/accounts'){
     if(window.__delayAccounts)await new Promise(r=>window.__releaseAccounts=r);v={owner:b.owner,mint:b.mint,accounts:[{address:'UI-SOURCE-ACCOUNT',amountAtomic:'5000000'}],assurance:'synthetic-test'};
    }else if(route==='non-evm/approve'){
     const r=window.__state.pending.find(r=>r.id===b.id);if(b.confirmation!==r.summary.recipient)v={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
     else {const record={id:r.id+'-record',family:r.summary.family,state:'signed',requestKey:r.summary.requestKey,summary:r.summary,signed:r.kind==='non-evm-spl'?{signature:'SYNTHETIC-NOT-A-REAL-SIGNATURE'}:{requestId:'SYNTHETIC-NOT-A-SIGNED-TRANSACTION'}};window.__records.push(record);window.__state.pending=[];v={record};}
    }else if(route==='non-evm/history')v={records:structuredClone(window.__records)};
    else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
    else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
    else if(route==='reject')window.__state.pending=[];
    else throw Error('OFFLINE_METHOD_UNSUPPORTED');
    return new Response(JSON.stringify(v),{status:v.error?400:200});
   };
  }''',fixtures)
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('accountCount').textContent==='6'")
  assert page.locator('#accountFamily option').count()==7;steps.append('Seven independent key-family options; no shared universal seed claim')
  assert page.locator('#splAccount option').count()==1 and page.locator('#splMint option').count()==1;steps.append('SPL selector contains local Solana key and explicitly registered mint only')
  for family in ['bitcoin','cosmos','stellar','aptos']:
   page.locator('#offlineFamily').select_option(family);assert page.locator('#offlineAccount').input_value()==family;assert not page.locator('#offlineStateAck').is_checked();steps.append(family+': family-specific account and reset acknowledgement')
   page.locator('#offlineExample').click();assert 'requestKey' in page.locator('#offlinePaymentJson').input_value();steps.append(family+': explicit template button creates no signing request')
   pmt=fixtures[family]['payment'];names={'bitcoin':['requestKey','networkId','to','amountAtomic','feeAtomic','maxFeeRateSatVb','utxos'],'cosmos':['requestKey','chainId','hrp','to','denom','amountAtomic','feeDenom','feeAtomic','gasLimit','accountNumber','sequence','timeoutHeight','memo'],'stellar':['requestKey','networkPassphrase','to','amountAtomic','feeAtomic','sequence','maxTime','memo'],'aptos':['requestKey','chainId','to','amountAtomic','sequence','maxGasAmount','gasUnitPrice','expirationTimestampSecs']}[family]
   page.locator('#offlinePaymentJson').fill(json.dumps({k:pmt[k] for k in names}));page.locator('#offlineStateAck').check();page.locator('#offlineSignerForm button[type=submit]').click();page.wait_for_function("document.querySelector('#pending article')!==null")
   assert page.locator('#pending input[type=checkbox]').count()==0 and 'オフライン' in page.locator('#pending').inner_text();assert page.evaluate("id=>!window.__calls.some(c=>c.route==='non-evm/approve'&&c.body.id===id)",family+'-request')
   steps.append(family+': complete immutable transfer review without broadcast switch')
   assert pmt['to'] in page.locator('#pending').inner_text();page.locator('#pending input').fill('incorrect');page.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('message').textContent.includes('CONFIRMATION')");steps.append(family+': recipient mismatch displayed as refusal')
   page.locator('#pending input').fill(pmt['to']);page.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/approve').at(-1).body.broadcast") is False
   assert page.get_by_role('button',name=family.upper()+'署名済み要求を保存',exact=True).count()==1;steps.append(family+': signed-only history and explicit owner export, no automatic send')
  page.locator('#splSource').fill('UI-SOURCE-ACCOUNT');page.locator('#splDestination').fill('UI-DESTINATION-ACCOUNT');page.locator('#splRecipient').fill('UI-DESTINATION-OWNER');page.locator('#splAmount').fill('1.25')
  page.locator('#splDiscover').click();page.wait_for_function("document.getElementById('splAccountsResult').textContent.includes('5000000')");steps.append('SPL account discovery preserves exact atomic amount string')
  page.locator('#splSendForm button[type=submit]').click();page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('SPL')");assert page.evaluate("window.__calls.filter(c=>c.route==='non-evm/spl/prepare').at(-1).body.payment.amount")=='1.25';assert page.locator('#pending input[type=checkbox]').count()==1 and not page.locator('#pending input[type=checkbox]').is_checked();steps.append('SPL decimal passes unchanged to service; broadcast stays opt-in')
  assert 'UI-DESTINATION-ACCOUNT' in page.locator('#pending').inner_text() and 'FAKE-MINT-UI-ONLY' in page.locator('#pending').inner_text() and 'SOL' in page.locator('#pending').inner_text();steps.append('SPL review displays mint, destination account, recipient owner and separate SOL fee')
  page.locator('#pending input:not([type=checkbox])').fill('UI-DESTINATION-OWNER');page.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");assert page.get_by_role('button',name='保存済みSolana署名を初めて送信',exact=True).count()==1;steps.append('Saved SPL signature requires separate initial-submission confirmation')
  page.evaluate("window.__delayAccounts=true");page.locator('#splDiscover').click();page.wait_for_function('typeof window.__releaseAccounts==="function"');page.locator('#splMint').dispatch_event('change');page.evaluate('window.__releaseAccounts()');page.wait_for_function("document.getElementById('message').textContent.includes('SPL_FORM_CHANGED')");assert page.locator('#splAccountsResult').inner_text()=='';steps.append('Late account discovery is discarded after form change')
  page.evaluate("document.getElementById('nonEvmPanel').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE DOM · 合成API / 実HTTP・署名・CSPは対象外</p>')");page.locator('#nonEvmPanel').screenshot(path=str(out/'expanded-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');page.locator('#nonEvmPanel').screenshot(path=str(out/'expanded-mobile.png'));steps.append('390px panel has no horizontal overflow')
  page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden");assert page.locator('#nonEvmJournal').inner_text()=='';steps.append('Lock clears visible signed records')
  assert not errors,errors;result={'status':'passed','mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False,'browser':browser.version};(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');browser.close();return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
