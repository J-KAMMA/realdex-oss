#!/usr/bin/env python3
"""Read-only exchange UI QA. Optional: Python Playwright, Chromium, cryptography,
installed TypeScript. All state is synthetic. NO browser HTTP, EVM, live-wallet,
CSP, or browser-native WebCrypto success claim is made by --offline-dom.
The managed browser policy is never changed. Native Node WebCrypto and actual
loopback HTTP are separately tested by verified-*.test.mjs.
"""
from __future__ import annotations
import argparse, json, re, shutil, subprocess
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.exceptions import InvalidSignature
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('--output',default=str(ROOT/'node/evidence/v04/browser'));p.add_argument('--chromium',default=shutil.which('chromium'));p.add_argument('--offline-dom',action='store_true');p.add_argument('--origin',default='http://127.0.0.1:8787');args=p.parse_args()
output=Path(args.output);output.mkdir(parents=True,exist_ok=True)
report={'scope':'offline DOM + synthetic RPC + explicit TEST Factory policy + Python Ed25519 verification bridge',
 'browserHttpEndToEnd':False,'browserNativeWebCryptoTested':False,'actualEvmExecution':False,'liveTransactions':False,
 'testOnlySourceAdaptations':['about:blank origin substitution','synthetic local Factory policy toggle in test loader','Python cryptography bridge for absent about:blank SubtleCrypto'],
 'viewports':[],'checks':{},'pageErrors':[],'requests':[]}
NOW=1788566400000
private=Ed25519PrivateKey.generate();key=private.public_key().public_bytes(Encoding.Raw,PublicFormat.Raw).hex()
factories=[{'chainId':'eip155:84532','address':'0x'+c*40,'protocol':'realdex-cpmm-v1'} for c in ['a','b']]
def sign(payload):
 canonical=json.dumps(payload,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
 return {'payload':payload,'signature':private.sign(canonical).hex()}
def snapshot(nonce,now):
 announcement=sign({'schema':'realdex.node.factories.v1','publisher':key,'revision':1,'issuedAt':now,'expiresAt':now+300000,'factories':factories})
 return sign({'schema':'realdex.node.snapshot.v1','publisher':key,'nonce':nonce,'issuedAt':now,'expiresAt':now+15000,'announcements':[announcement]})
def verify(key_bytes,signature,data):
 try:Ed25519PublicKey.from_public_bytes(bytes(key_bytes)).verify(bytes(signature),bytes(data));return True
 except InvalidSignature:return False
html=(ROOT/'node/public/exchange.html').read_text();html=re.sub(r'<link[^>]+>','',html);html=re.sub(r'<script.*?</script>','',html,flags=re.S)
css='\n'.join((ROOT/'node/public'/f).read_text() for f in ['styles.css','exchange.css'])
html=html.replace('</head>','<style>'+css+'</style></head>')
bundle=subprocess.run([shutil.which('node'),'node/test/build-exchange-test-bundle.cjs'],cwd=ROOT,text=True,capture_output=True,check=True).stdout
with sync_playwright() as pw:
 browser=pw.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox']);report['browser']=browser.version
 context=browser.new_context(locale='ja-JP');page=context.new_page();page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
 if not args.offline_dom:
  try:
   page.goto(args.origin+'/node/exchange/',wait_until='networkidle',timeout=10000)
   report['navigationAttempt']={'loaded':True,'note':'Use the offline harness for scripted synthetic scenarios; this only checked navigation.'}
  except Exception as e:report['navigationAttempt']={'loaded':False,'error':str(e)}
  browser.close();(output/'navigation-result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2));print(json.dumps(report,ensure_ascii=False));raise SystemExit(0 if report['navigationAttempt']['loaded'] else 2)
 page.expose_function('__signedSnapshot',snapshot);page.expose_function('__pythonVerify',verify)
 page.set_content(html)
 page.evaluate('''() => {const b=document.createElement('div');b.className='notice';b.textContent='合成試験データ / SYNTHETIC TEST DATA — 実チェーン・実資産・取引実行の画面ではありません。';document.querySelector('main').prepend(b);}''')
 page.evaluate('''() => {
   window.__clock=1788566400000;Date.now=()=>window.__clock;window.__useSyntheticPolicy=true;window.__requests=[];
   window.__walletTouched=false;Object.defineProperty(window,'ethereum',{get(){window.__walletTouched=true;throw new Error('WALLET_ACCESS_FORBIDDEN')}});
   Object.defineProperty(crypto,'subtle',{value:{importKey:async(format,key)=>({raw:Array.from(key)}),verify:async(algorithm,key,signature,data)=>window.__pythonVerify(key.raw,Array.from(signature),Array.from(data))}});
   Object.defineProperty(crypto,'randomUUID',{value:()=>{const b=crypto.getRandomValues(new Uint8Array(16));return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')}});
 }''')
 page.evaluate(bundle)
 def fill_form():
  for id,value in {'relay-key':key,'rpc-one':'http://127.0.0.1:8545','rpc-two':'http://127.0.0.1:8546','chain-id':'84532',
    'fee-tiers':'5, 30','token-in':'0x'+'1'*40,'token-out':'0x'+'2'*40,'amount-in':'100000','account':'0x'+'9'*40}.items():page.locator('#'+id).fill(value)
 def success():
  page.locator('#verify').click();page.wait_for_function("document.querySelector('#pool-rows').children.length===2 && !document.querySelector('#observation-section').hidden && !document.querySelector('#verify').disabled")
 def assert_progress(text):
  page.wait_for_function('(s)=>document.querySelector("#progress").textContent.includes(s)',arg=text)
 fill_form();success();assert '実質比較不可' in page.locator('#pool-rows').inner_text()
 report['checks']['signedCatalogueAndTwoObservedPools']=True;report['checks']['missingCostsNotFree']=True
 page.locator('#simulate').click();page.wait_for_function("document.querySelector('#simulation-result').textContent.includes('125,000') && !document.querySelector('#verify').disabled")
 assert '1,100,000,000' in page.locator('#simulation-result').inner_text();report['checks']['readOnlyGasEstimate']=True
 page.locator('#split').click();assert '追加費用は引いていません' in page.locator('#split-result').inner_text();report['checks']['grossOnlySplit']=True
 for name,width,height in [('desktop',1440,1080),('mobile',390,844),('small-mobile',320,780)]:
  page.set_viewport_size({'width':width,'height':height});metrics=page.evaluate('({scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth})');assert metrics['scrollWidth']<=width,(name,metrics)
  page.screenshot(path=str(output/(name+'.png')),full_page=True);report['viewports'].append({'name':name,**metrics,'screenshot':name+'.png'})
 page.set_viewport_size({'width':1280,'height':1000});page.evaluate("document.documentElement.style.zoom='2'");metrics=page.evaluate('({scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth})');assert metrics['scrollWidth']<=1280,metrics
 report['checks']['cssZoom200LayoutOnly']=metrics;page.evaluate("document.documentElement.style.zoom='1'")
 page.locator('#amount-in').fill('100001');assert page.locator('#observation-section').is_hidden();report['checks']['inputInvalidatesOldObservation']=True
 page.locator('#amount-in').fill('100000');success();page.evaluate('window.__clock+=30001');assert_progress('期限切れ');assert page.locator('#observation-section').is_hidden();report['checks']['expiryHidesOldObservation']=True
 # Advance monotonically: rollback must remain rejected, including in the UI.
 page.evaluate('window.__clock=1788566430001')
 # Block fixture now is 30 seconds old but still within the block-age allowance.
 success();page.evaluate('window.__approvalMissing=true');page.locator('#simulate').click();page.wait_for_function("document.querySelector('#simulation-result').textContent.includes('承認が不足') && !document.querySelector('#verify').disabled")
 report['checks']['missingApprovalStopsWithoutCreatingTransaction']=True;page.evaluate('window.__approvalMissing=false')
 page.locator('#amount-in').fill('100000');page.evaluate('window.__forceDisagreement=true');page.locator('#verify').click();assert_progress('一致しません');assert page.locator('#observation-section').is_hidden();report['checks']['rpcDisagreementHidesResults']=True;page.evaluate('window.__forceDisagreement=false')
 page.evaluate('window.__forgeSignature=true');page.locator('#verify').click();assert_progress('SIGNATURE_INVALID');assert page.locator('#observation-section').is_hidden();report['checks']['forgedSignatureStops']=True;page.evaluate('window.__forgeSignature=false')
 page.evaluate('window.__delayReads=true');page.locator('#verify').click();page.locator('#cancel').click();page.wait_for_timeout(800);assert_progress('中止');assert page.locator('#observation-section').is_hidden();report['checks']['cancelledResultDoesNotResurrect']=True;page.evaluate('window.__delayReads=false')
 # Production default policy must reject these synthetic factories, even though all signatures are valid.
 page.evaluate('window.__useSyntheticPolicy=false');page.locator('#verify').click();assert_progress('0プール');assert page.locator('#pool-rows').count()==1;assert page.locator('#pool-rows tr').count()==0
 assert 'FACTORY_CODE_MISMATCH' in page.locator('#rejections').text_content(),repr(page.locator('#rejections').text_content());report['checks']['productionPolicyRejectsSyntheticFactory']=True
 report['requests']=page.evaluate('window.__requests');assert all(m in ['eth_chainId','eth_getBlockByNumber','eth_getCode','eth_call','eth_estimateGas','eth_gasPrice'] for m in report['requests'])
 report['checks']['walletNeverAccessed']=not page.evaluate('window.__walletTouched');assert report['checks']['walletNeverAccessed'];assert not report['pageErrors'],report['pageErrors']
 report['passed']=True;browser.close()
(output/'browser-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps(report,ensure_ascii=False,indent=2))
