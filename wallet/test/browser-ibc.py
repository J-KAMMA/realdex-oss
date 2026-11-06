#!/usr/bin/env python3
"""Offline DOM scenario: synthetic API, not a wallet/chain/CSP integration test."""
import argparse,json,re
from pathlib import Path
from playwright.sync_api import sync_playwright
from frontend_source import frontend_source
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=False);steps=[]
 html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html);html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1100});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''()=>{
   window.__calls=[];window.__records=[];window.__delivered=false;
   const route={id:'ibc-local-a-b',name:'ローカル A → B / 合成画面データ',source:{network:{chainId:'realdex-local-a-1'},channel:'channel-0'},destination:{network:{chainId:'realdex-local-b-1'}}};
   window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[{id:'owner',family:'cosmos',kind:'local',address:'cosmos1syntheticowner',label:'所有者 / 合成データ'},{id:'watch',family:'cosmos',kind:'watch',address:'cosmos1watchonly',label:'閲覧のみ'}],networks:[],bitcoinNetworks:[],solanaNetworks:[],accountNetworks:[],cosmosNetworks:[],ibcRoutes:[route],pending:[],sessions:[],allowedAppOrigins:[]};
   window.fetch=async(url,init)=>{if(!String(url).startsWith('/api/')||init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('OFFLINE_NETWORK_FORBIDDEN');const routeName=String(url).slice(5),b=JSON.parse(init.body);window.__calls.push({route:routeName,body:b});let result={};
    if(routeName==='status')result=structuredClone(window.__state);
    else if(routeName==='ibc/balance')result={balanceAtomic:'10000000',feeBalanceAtomic:'10000000',finalityProven:false};
    else if(routeName==='ibc/prepare'){if(window.__records.some(r=>r.requestKey===b.payment.requestKey))result={alreadyRecorded:true,record:window.__records[0],submittedAgain:false};else{const summary={route,recipient:b.payment.receiver,asset:'stake',destinationAsset:'ibc/'+'A'.repeat(64),amountAtomic:'1000000',feeAtomic:b.payment.feeAtomic,transfer:{timeoutTimestamp:'1788739200000000000'},requestKey:b.payment.requestKey,confirmationText:'BRIDGE '+b.payment.receiver+' TO realdex-local-b-1',submissionEnabled:true};result={id:'request',kind:'ibc-transfer',intentId:'intent',summary};window.__state.pending=[result];}if(window.__delay)await new Promise(r=>window.__release=r);}
    else if(routeName==='ibc/approve'){const p=window.__state.pending[0];if(b.confirmation!==p.summary.confirmationText)result={error:'IBC_APPROVAL_CONFIRMATION'};else{const r={id:'record',state:b.broadcast?'broadcast':'signed',requestKey:p.summary.requestKey,summary:p.summary,signed:{requestId:'D'.repeat(64)}};window.__records=[r];window.__state.pending=[];result={record:r};}}
    else if(routeName==='ibc/history')result={records:structuredClone(window.__records)};
    else if(routeName==='ibc/reconcile'){const r=window.__records[0];r.state='broadcast';r.report={stage:window.__delivered?'reported-delivered':'awaiting-ack',received:window.__delivered,refunded:false,reason:window.__delivered?'destination-and-source-ack-observed':'destination-received-source-ack-pending',evidenceRefs:{destinationTxHash:b.destinationTxHash??'A'.repeat(64),settlementTxHash:b.settlementTxHash??'B'.repeat(64)},packet:{data:'public-only'}};result=r;}
    else if(routeName==='ibc/relay-plan')result={packet:{data:'public-only'},privateKeysIncluded:false,signingAuthority:false};
    else if(routeName==='reject')window.__state.pending=[];
    else if(routeName==='lock'){window.__state.locked=true;window.__state.pending=[];}
    else if(routeName==='ibc/routes/inspect')result={route:b.route,fingerprint:'C'.repeat(64),confirmation:'ADD IBC '+'C'.repeat(64),executionEnabled:false};
    else throw Error('UNEXPECTED_OFFLINE_API:'+routeName);
    return new Response(JSON.stringify(result),{status:result.error?400:200});};
  }''')
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('workspace').hidden===false && document.getElementById('ibcAccount').options.length===1")
  assert page.locator('#ibcRoute option').count()==1;steps.append('Only configured routes and local signing accounts are selectable')
  assert page.evaluate("window.__calls.every(c=>!c.route.startsWith('ibc/'))");steps.append('Page load does not query routes or sign')
  page.locator('#ibcRecipient').fill('cosmos1syntheticrecipient');page.locator('#ibcAmount').fill('1');page.locator('#ibcRequestKey').fill('ui-original');page.locator('#ibcBalance').click();page.wait_for_function("document.getElementById('ibcBalanceResult').textContent.includes('10000000')");steps.append('Balance reads remain separate from signing')
  page.locator('#ibcForm button[type=submit]').click();page.locator('#ibcConfirm').wait_for();assert not page.locator('#ibcBroadcast').is_checked();steps.append('Preparing does not sign and broadcast defaults off')
  t=page.locator('#ibcApproval').inner_text();assert 'realdex-local-a-1' in t and 'realdex-local-b-1' in t and '1000000' in t and '50000' in t and 'channel-0' in t;steps.append('Approval shows both chains, asset trace, exact amount, fee and deadline')
  page.locator('#ibcConfirm').fill('wrong');page.locator('#ibcApproval button').first.click();page.wait_for_function("document.getElementById('message').textContent.includes('IBC_APPROVAL_CONFIRMATION')");assert page.evaluate('window.__records.length')==0;steps.append('Wrong full confirmation is rejected')
  page.locator('#ibcConfirm').fill('BRIDGE cosmos1syntheticrecipient TO realdex-local-b-1');page.locator('#ibcBroadcast').check();page.locator('#ibcApproval button').first.click();page.wait_for_function("document.querySelectorAll('#ibcHistory article').length===1");steps.append('Owner explicitly chooses initial broadcast after reviewing the transfer')
  inputs=page.locator('#ibcHistory input');inputs.nth(0).fill('A'*64);inputs.nth(1).fill('B'*64);page.locator('#ibcHistory button').filter(has_text='元の取引').click();page.wait_for_function("document.getElementById('ibcHistory').textContent.includes('awaiting-ack')");assert '受取確認: false' in page.locator('#ibcHistory').inner_text();steps.append('Destination observation alone remains incomplete until source acknowledgement')
  page.evaluate('window.__delivered=true');page.locator('#ibcHistory button').filter(has_text='元の取引').click();page.wait_for_function("document.getElementById('ibcHistory').textContent.includes('reported-delivered')");steps.append('Receipt and source acknowledgement display separately from finality proof')
  page.locator('#ibcHistory button').filter(has_text='公開パケット').click();page.wait_for_function("document.getElementById('ibcRelayPlan').textContent.includes('privateKeysIncluded')");assert '"signingAuthority": false' in page.locator('#ibcRelayPlan').inner_text();steps.append('Relay plan contains only public packet information, no private signing authority')
  page.locator('#ibcForm button[type=submit]').click();page.wait_for_function("document.getElementById('message').textContent.includes('同じ依頼は保存済み')");assert page.evaluate("window.__calls.filter(c=>c.route==='ibc/approve').length") == 2;steps.append('Same request key displays existing record without re-signing')
  page.evaluate('window.__delivered=false');page.locator('#ibcHistory button').filter(has_text='元の取引').click();page.wait_for_function("document.getElementById('ibcHistory').textContent.includes('awaiting-ack')");steps.append('Reconciliation can withdraw an old delivered observation')
  page.locator('#ibcNewKey').click();page.evaluate('window.__delay=true');page.locator('#ibcForm button[type=submit]').click();page.wait_for_function('typeof window.__release==="function"');page.locator('#ibcAmount').fill('2');page.evaluate('window.__release()');page.wait_for_function("document.getElementById('message').textContent.includes('UI_OPERATION_CANCELLED')");assert page.locator('#ibcApproval').inner_text()=='';steps.append('Editing discards late preparation responses')
  assert not errors,errors;page.locator('#ibcPanel').evaluate("e=>{const p=document.createElement('p');p.className='notice';p.textContent='OFFLINE UI / 合成API。実HTTP・CSPの試験ではありません。';e.prepend(p);}");page.locator('#ibcPanel').screenshot(path=str(out/'ibc-desktop-offline.png'))
  page.set_viewport_size({'width':420,'height':950});assert page.locator('#ibcPanel').evaluate('e=>e.scrollWidth<=e.clientWidth');page.locator('#ibcPanel').screenshot(path=str(out/'ibc-mobile-offline.png'));steps.append('Desktop and narrow viewport render with explicit synthetic-data label')
  page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden===true");assert page.locator('#ibcApproval').inner_text()=='' and page.locator('#ibcHistory').inner_text()=='';steps.append('Lock clears approval and history content');browser.close()
 result={'status':'passed','steps':steps,'checks':len(steps),'realHttpIntegration':False,'cspEnforced':False,'syntheticApi':True};(out/'result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
