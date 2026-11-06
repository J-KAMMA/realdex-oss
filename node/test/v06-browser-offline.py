#!/usr/bin/env python3
"""Optional offline Chromium DOM test with synthetic ICP query replies.
No browser HTTP/CSP/CORS or live ICP compatibility is asserted. Requires
Playwright and Chromium. No network restriction is bypassed or relaxed.
"""
from __future__ import annotations
import argparse,base64,json,re,shutil
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]

def run(output:Path,chromium:str|None)->dict:
 output.mkdir(parents=True,exist_ok=True);cache={}
 def module(p:Path)->str:
  p=p.resolve();key=str(p)
  if key in cache:return cache[key]
  s=p.read_text()
  def sub(m):
   target=m.group(2);dep=(ROOT/target.lstrip('/')) if target.startswith('/node/') else p.parent/target
   return m.group(1)+"'"+module(dep)+"'"
  s=re.sub(r"(from\s*)['\"]([^'\"]+)['\"]",sub,s)
  uri='data:text/javascript;base64,'+base64.b64encode(s.encode()).decode();cache[key]=uri;return uri
 html=(ROOT/'node/public/privacy.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'node/public/privacy.css').read_text()+'</style></head>')
 html=html.replace('<body>','<body><aside style="padding:10px 20px;background:#3d3218;color:#fff5c4;text-align:center;font:12px system-ui">OFFLINE DOM TEST / 合成ICP応答 / 実RPC・HTTP結合・CSPは未検証</aside>')
 profiles=json.loads((ROOT/'node/extended/networks.json').read_text());ledgers=json.loads((ROOT/'node/icp/ledgers.json').read_text());vectors=json.loads((ROOT/'node/test/v06-candid-vectors.json').read_text())['vectors']
 steps=[]
 with sync_playwright() as pw:
  b=pw.chromium.launch(executable_path=chromium,headless=True,args=['--no-sandbox']);page=b.new_page(viewport={'width':1440,'height':1300},device_scale_factor=1);errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('(data)=>{window.__fixtureData=data;window.__fetches=[];window.__delayed=false;window.__pending=[];}',{'profiles':profiles,'ledgers':ledgers,'vectors':vectors})
  fake="""import {encodeCbor,decodeCbor} from 'CBOR';
   window.fetch=async(url,init={})=>{
    url=String(url);window.__fetches.push(url);
    if(url==='/node/extended/networks.json')return new Response(JSON.stringify(window.__fixtureData.profiles),{headers:{'content-type':'application/json'}});
    if(url==='/node/icp/ledgers.json')return new Response(JSON.stringify(window.__fixtureData.ledgers),{headers:{'content-type':'application/json'}});
    if(!url.startsWith('http://127.0.0.1:4943/api/v2/canister/'))throw Error('DOM_TEST_NETWORK_DISABLED');
    if(window.__delayed)await new Promise(resolve=>window.__pending.push(resolve));
    const method=decodeCbor(init.body).content.method_name,hex=window.__fixtureData.vectors[method];
    if(!hex)throw Error('DOM_TEST_METHOD_FORBIDDEN');
    const arg=Uint8Array.from(hex.match(/../g),h=>parseInt(h,16));
    return new Response(encodeCbor({status:'replied',reply:{arg}}),{headers:{'content-type':'application/cbor'}});
   };
   window.__fetchReady=true;
  """.replace('CBOR',module(ROOT/'node/icp/cbor.mjs'))
  page.add_script_tag(type='module',content=fake);page.wait_for_function('window.__fetchReady===true')
  page.add_script_tag(type='module',content="import '"+module(ROOT/'node/public/privacy.mjs')+"';")
  page.wait_for_function("document.getElementById('profileCount').textContent==='28'")
  assert page.locator('#ledgerCount').inner_text()=='9';assert page.locator('#selection option').count()==28;steps.append('28 extension profiles and 9 ICP ledger candidates render')
  page.locator('#mode').select_option('icrc');assert page.locator('#selection option').count()==9;assert page.locator('#ledger').input_value()=='ryjl3-tyaaa-aaaaa-aaaba-cai';steps.append('ICP metadata mode selects ledger by canister, not token ticker')
  page.locator('#endpoints').fill('https://not-authorized.example');page.locator('#run').click();page.wait_for_function("document.getElementById('status').textContent.includes('REMOTE_DISCLOSURE_NOT_AUTHORIZED')")
  assert len(page.evaluate('window.__fetches'))==2;steps.append('Remote request without origin consent rejected before mock fetch')
  page.locator('#endpoints').fill('http://127.0.0.1:4943');page.locator('#run').click();page.wait_for_function("document.getElementById('status').textContent.includes('読み取り完了')")
  result=json.loads(page.locator('#result').inner_text());assert result['transferFeeAtomic']=='10000';assert result['assurance']['certifiedLedgerState'] is False;assert result['executable'] is False
  steps.append('Ten anonymous synthetic query replies decoded; result remains unverified and nonexecutable')
  page.screenshot(path=str(output/'icp-privacy-desktop.png'),full_page=True)
  page.locator('#endpoints').fill('http://127.0.0.1:4943/');assert page.locator('#result').inner_text()=='未実行';steps.append('Input change discards existing result')
  page.locator('#endpoints').fill('http://127.0.0.1:4943');page.evaluate('window.__delayed=true');page.locator('#run').click();page.wait_for_function('window.__pending.length>0');page.locator('#cancel').click();page.evaluate('window.__delayed=false;window.__pending.splice(0).forEach(r=>r())');page.wait_for_timeout(100)
  assert page.locator('#result').inner_text()=='未実行';assert '中止しました' in page.locator('#status').inner_text();steps.append('Cancelled late response cannot resurrect an old result')
  p={'id':'private-evm:office','name':'Office private EVM (fixture)','family':'evm','environment':'local','networkIdentity':'1','nativeSymbol':'LOCAL','nativeDecimals':18,'privacyModel':'permissioned-not-confidential','restricted':True,'genesisHash':'a'*64,'source':'https://docs.besu-eth.org/private-networks/concepts/permissioning','status':'candidate-unverified'}
  before=len(page.evaluate('window.__fetches'));page.locator('#privateRegistry').set_input_files({'name':'office.json','mimeType':'application/json','buffer':json.dumps({'schema':'realdex.extended-networks.v1','profiles':[p]}).encode()});page.wait_for_function("document.getElementById('profileCount').textContent==='29'")
  assert page.locator('#selection').input_value()=='private-evm:office';assert page.locator('#pin').input_value()=='a'*64;assert page.locator('#endpoints').input_value()=='';assert len(page.evaluate('window.__fetches'))==before;steps.append('Local private profile import has no server upload, RPC call or persistence')
  page.locator('#privateRegistry').set_input_files({'name':'bad.json','mimeType':'application/json','buffer':b'{"schema":"realdex.extended-networks.v1","profiles":[],"seed":"test-secret"}'});page.wait_for_function("document.getElementById('status').textContent.includes('SCHEMA_INVALID')");assert page.locator('#profileCount').inner_text()=='29';assert 'test-secret' not in page.locator('body').inner_text();steps.append('Unknown fields in imported private profile are rejected without echoing their content')
  page.locator('#selection').select_option('monero:mainnet');assert page.locator('#endpoints').get_attribute('placeholder').endswith('/json_rpc');assert page.locator('#pin').input_value()=='';steps.append('Switching network clears pins/endpoints and chooses protocol-appropriate hint')
  page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth');page.screenshot(path=str(output/'icp-privacy-mobile.png'),full_page=True);steps.append('390px mobile viewport has no horizontal overflow')
  assert errors==[],errors
  result={'mode':'offline-dom-synthetic-icrc','browser':b.version,'stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'httpCspCorsIntegrationTested':False,'liveRpcTested':False,'localPrivateFilePersisted':False}
  (output/'browser-offline-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');b.close();return result
if __name__=='__main__':
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',required=True,type=Path);parser.add_argument('--chromium',default=shutil.which('chromium'));a=parser.parse_args();print(json.dumps(run(a.output,a.chromium),ensure_ascii=False,indent=2))
