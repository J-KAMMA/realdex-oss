#!/usr/bin/env python3
"""Offline UI test using synthetic owner API; never reported as HTTP/CSP or consensus proof."""
import argparse,json,re,subprocess
from frontend_source import frontend_source
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 pairs=json.loads(subprocess.check_output(['node','--input-type=module','-e',"import {keyInfo} from './wallet/lib/keys.mjs';console.log(JSON.stringify({owner:keyInfo('cosmos',Buffer.alloc(32,49)).address,helper:keyInfo('cosmos',Buffer.alloc(32,50)).address,to:keyInfo('cosmos',Buffer.alloc(32,51)).address}));"],cwd=ROOT,text=True))
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''pairs=>{
   window.__calls=[];window.__records=[];
   const n={family:'cosmos',id:'cosmos:realdex-local-ui',name:'LOCAL SIMD / SYNTHETIC UI',broadcastEnabled:true,denom:'stake',decimals:6,symbol:'SIM',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'100000000',maxFeeAtomic:'10000',checkpoint:{height:1,hash:'1'.repeat(64)}};
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'owner',family:'cosmos',kind:'local',address:pairs.owner,label:'所有者 / 合成画面データ'},{id:'helper',family:'cosmos',kind:'local',address:pairs.helper,label:'代理人 / 合成画面データ'}],networks:[],bitcoinNetworks:[],solanaNetworks:[],accountNetworks:[],pending:[],sessions:[],allowedAppOrigins:[],cosmosNetworks:[n]};
   window.fetch=async(url,init)=>{
    if(!String(url).startsWith('/api/')||init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OFFLINE_NETWORK_FORBIDDEN');
    const route=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route,body:b});let result={};
    if(route==='status')result=structuredClone(window.__state);
    else if(route==='non-evm/cosmos-online/balance')result={networkFrom:b.accountId==='owner'?pairs.owner:pairs.helper};
    else if(route==='non-evm/cosmos-authz/status'){
     if(window.__delayStatus)await new Promise(r=>window.__releaseStatus=r);
     result={grant:{remainingAtomic:'2000000',recipient:pairs.to},finalityProven:false};
    }else if(route==='non-evm/cosmos-authz/prepare'){
     const u=b.payment,from=b.accountId==='owner'?pairs.owner:pairs.helper,granter=u.action==='execute'?u.granter:from,grantee=u.action==='execute'?from:u.grantee;
     const confirmationText=u.action==='grant'?`GRANT ${grantee} ${u.limitAtomic} stake TO ${u.recipient} UNTIL ${u.expirationSeconds}`:u.action==='revoke'?`REVOKE ${grantee}`:u.recipient;
     const summary={family:'cosmos',operation:'cosmos-authz-'+u.action+'-online',action:u.action,networkId:n.id,from,networkFrom:from,granter,grantee,feePayer:from,recipient:u.recipient||grantee,amountAtomic:u.amountAtomic||'0',limitAtomic:u.limitAtomic||null,feeAtomic:u.feeAtomic,asset:'stake',decimals:6,feeAsset:'stake',feeDecimals:6,transfer:u,requestKey:u.requestKey,confirmationText,submissionEnabled:!window.__disabled};
     result={id:'request',kind:'non-evm-cosmos-authz',intentId:'intent',expiresAt:Date.now()+60000,summary,origin:'http://127.0.0.1:8790'};window.__state.pending=[result];
     if(window.__delayPrepare)await new Promise(r=>window.__releasePrepare=r);
    }else if(route==='non-evm/approve'){
     const p=window.__state.pending[0];if(b.confirmation!==p.summary.confirmationText)result={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
     else{const r={id:'record',family:'cosmos',state:b.broadcast?'broadcast':'signed',summary:p.summary,requestKey:p.summary.requestKey,signed:{requestId:'2'.repeat(64)}};window.__records=[r];window.__state.pending=[];result={record:r};}
    }else if(route==='non-evm/cosmos-authz/reconcile'){
     const r=window.__records[0];r.state=window.__missing?'broadcast-unknown':'reported-confirmed';r.report={completed:!window.__missing,received:!window.__missing&&r.summary.action==='execute',confirmations:2,height:10,reason:'SYNTHETIC_UI_ONLY',observedAt:Date.now(),finalityProven:false};result=r;
    }else if(route==='non-evm/history')result={records:structuredClone(window.__records)};
    else if(route==='reject')window.__state.pending=[];
    else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
    else throw Error('OFFLINE_METHOD_UNSUPPORTED:'+route);
    return new Response(JSON.stringify(result),{status:result.error?400:200});
   };
  }''',pairs)
  page.add_script_tag(type='module',content="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"+frontend_source(ROOT))
  page.wait_for_function("document.getElementById('accountCount').textContent==='2'")
  assert page.evaluate("window.__calls.every(c=>!c.route.includes('authz'))");steps.append('Page load never fetches or grants authorization')
  assert page.locator('#authzNetwork option').count()==1 and page.locator('#authzAccount option').count()==2;steps.append('Only configured networks and local Cosmos signers appear')
  page.fill('#authzPeer',pairs['helper']);page.fill('#authzRecipient',pairs['to']);page.fill('#authzKey','test-grant');page.locator('#authzForm button[type=submit]').click()
  page.wait_for_function("document.querySelector('#pending h3')?.textContent.includes('代理')");card=page.locator('#pending .request-card').first
  assert not card.locator('input[type=checkbox]').is_checked();steps.append('Initial broadcast defaults to off')
  text=card.inner_text();assert pairs['owner'] in text and pairs['helper'] in text and pairs['to'] in text and '3000000' in text and '0.0008 stake' in text and 'GRANT ' in text;steps.append('Approval includes grantor, grantee, allowlist, budget, expiration, payer and full confirmation')
  assert page.evaluate("window.__calls.every(c=>c.route!=='non-evm/approve')");steps.append('Preparing a grant does not sign')
  card.locator('input:not([type=checkbox])').fill(pairs['helper']);card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('message').textContent.includes('CONFIRMATION_MISMATCH')");assert page.evaluate('window.__records.length')==0;steps.append('Address alone does not approve a permission grant')
  card.locator('input:not([type=checkbox])').fill(page.evaluate('window.__state.pending[0].summary.confirmationText'));card.locator('input[type=checkbox]').check();card.get_by_role('button',name='この非EVM操作だけ承認',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Owner confirmation sends exactly the reviewed request')
  page.get_by_role('button',name='COSMOSの状態を再照合',exact=True).click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('reported-confirmed')")
  assert '権限操作の完了観測' in page.locator('#nonEvmJournal').inner_text();steps.append('Permission completion is distinct from a received payment')
  page.evaluate('window.__missing=true');page.get_by_role('button',name='COSMOSの状態を再照合',exact=True).click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('broadcast-unknown')");steps.append('Missing evidence withdraws old completion')
  page.select_option('#authzAction','revoke');assert not page.locator('#authzRecipient').is_visible() and page.locator('#authzRecipient').is_disabled() and page.locator('#authzExpiry').is_disabled();steps.append('Revoke does not request an amount, recipient or new expiration')
  page.fill('#authzKey','revoke');page.locator('#authzForm button[type=submit]').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='1'");assert page.evaluate('window.__state.pending[0].summary.confirmationText')=='REVOKE '+pairs['helper'];steps.append('Revocation has its own explicit confirmation')
  page.locator('#pending').get_by_role('button',name='非EVM要求を拒否',exact=True).click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'")
  page.select_option('#authzAction','execute');page.select_option('#authzAccount','helper');page.fill('#authzPeer',pairs['owner']);assert page.locator('#authzExpiry').is_disabled();steps.append('Delegate execution cannot attach a new expiration or create authorization')
  page.evaluate('window.__delayStatus=true');page.locator('#authzStatus').click();page.wait_for_function('typeof window.__releaseStatus==="function"');page.fill('#authzAmount','900000');page.evaluate('window.__releaseStatus()');page.wait_for_function("document.getElementById('message').textContent.includes('AUTHZ_FORM_CHANGED')");assert page.locator('#authzResult').inner_text()=='';steps.append('Edited input discards a late grant observation')
  page.evaluate('window.__delayStatus=false;window.__delayPrepare=true');page.fill('#authzKey','late');page.locator('#authzForm button[type=submit]').click();page.wait_for_function('typeof window.__releasePrepare==="function"');page.fill('#authzAmount','800000');page.evaluate('window.__releasePrepare()');page.wait_for_function("document.getElementById('message').textContent.includes('AUTHZ_FORM_CHANGED')");page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Edited form rejects late prepare result before approval')
  page.evaluate("document.getElementById('cosmosAuthzSection').insertAdjacentHTML('afterbegin','<p class=notice>OFFLINE UI / 合成API。実HTTP・CSPの試験ではありません。</p>')");page.locator('#cosmosAuthzSection').screenshot(path=str(out/'cosmos-authz-desktop.png'))
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');steps.append('Mobile viewport has no document overflow');page.locator('#cosmosAuthzSection').screenshot(path=str(out/'cosmos-authz-mobile.png'))
  page.locator('#lock').click();page.wait_for_function("document.getElementById('nonEvmJournal').textContent===''");assert page.locator('#authzResult').inner_text()=='';steps.append('Lock clears grant observations and pending requests')
  assert errors==[],errors
  result={'status':'passed','checks':len(steps),'steps':steps,'realHttpIntegration':False,'cspEnforced':False,'mode':'offline DOM with synthetic API','pageErrors':errors};(out/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));browser.close();return result
if __name__=='__main__':
 ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,required=True);args=ap.parse_args();print(json.dumps(run(args.output),ensure_ascii=False,indent=2))
