#!/usr/bin/env python3
"""Offline DOM unit test: pure synthetic API responses, no network or crypto.
Does not bypass blocked HTTP; no real service data are proxied into the browser.
"""
from frontend_source import frontend_source
from pathlib import Path
import argparse,json,re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
 out.mkdir(parents=True,exist_ok=True)
 html=(ROOT/'wallet/public/index.html').read_text()
 html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
 html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
 html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
 html=html.replace('<body>','<body><aside style="background:#453910;color:#fff4cd;text-align:center;padding:10px;font:12px system-ui">OFFLINE DOM / 合成API・公開試験口座 / 実HTTP・CSP・暗号処理はこの画面試験の対象外</aside>')
 steps=[]
 with sync_playwright() as p:
  browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1050});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
  page.evaluate('''()=>{
    const origin='http://127.0.0.1:8790',to='0x'+'35'.repeat(20);
    window.__calls=[];window.__historyClean=false;
    window.__state={exists:true,locked:false,expiresAt:Date.now()+300000,backupRequired:false,accounts:[
      {id:'a1',label:'EVM · 公開試験アドレス',family:'evm',kind:'local',address:'0x9d8a62f656a8d1615c1294fd71e9cfb3e4855a4f'},
      {id:'a2',label:'ICP · 公開試験アドレス',family:'icp',kind:'local',address:'wf3fv-4c4nr-7ks2b-xa4u7-kf3no-32glf-lf7e4-4ng4a-wwtlu-a2vnq-nae'},
      {id:'a3',label:'Solana · 公開試験アドレス',family:'solana',kind:'local',address:'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9'},
      {id:'a4',label:'閲覧専用',family:'evm',kind:'watch',address:'0x'+'36'.repeat(20)}],
      networks:[{chainId:'31337',name:'SYNTHETIC local test',symbol:'TEST',broadcastEnabled:true,tokens:[]}],pending:[],sessions:[],allowedAppOrigins:['http://127.0.0.1:5173']};
    window.__summary={network:'SYNTHETIC local test',chainId:'31337',operation:'native-transfer',assetMoves:[{address:null,amountAtomic:'10000000000000000',decimals:18,symbol:'TEST'}],from:window.__state.accounts[0].address,to,recipient:to,amountAtomic:'10000000000000000',asset:'TEST',minimumOutputAtomic:null,executionFeeCapWei:'75600000000000',nonce:'0',details:null};
    window.__pending=()=>({id:'req1',kind:'transaction',origin,intentId:'intent1',expiresAt:Date.now()+90000,summary:window.__summary});
    window.__state.pending=[window.__pending()];
    window.fetch=async (url,init)=>{
      if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');
      if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('CAPABILITY_NOT_ATTACHED');
      const b=JSON.parse(init.body),route=String(url).slice(5);window.__calls.push({route,body:b});let value={};
      if(route==='status')value=structuredClone(window.__state);
      else if(route==='approve'){
        if(b.confirm!==to)value={error:'TRANSACTION_CONFIRMATION_MISMATCH'};
        else {window.__state.pending=[];value={approved:true,broadcastState:'signed'};}
      }else if(route==='journal')value={records:[]};
      else if(route==='transfers/prepare'){
        if(window.__delayPrepare)await new Promise(resolve=>window.__releasePrepare=resolve);
        window.__state.pending=[window.__pending()];value=window.__pending();
      }else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];window.__state.sessions=[];}
      else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
      else if(route==='backup/verify'){window.__state.backupRequired=false;value={verified:true};}
      else if(route==='accounts/add'){window.__state.backupRequired=true;value={added:true};}
      else if(route==='transfers/balance')value={atomic:'1000000000000000000',amount:'1',nativeAmount:'1',symbol:'TEST'};
      else if(route==='reject')window.__state.pending=[];
      else throw Error('OFFLINE_METHOD_NOT_IMPLEMENTED');
      return new Response(JSON.stringify(value),{status:value.error?400:200,headers:{'content-type':'application/json'}});
    };
  }''')
  prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){window.__historyClean=true;}};\n"
  page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('accountCount').textContent==='4'")
  assert page.locator('#accounts article').count()==4;assert page.locator('#sendAccount option').count()==1;assert page.evaluate('window.__historyClean');steps.append('Four key/watch account cards; watch-only is absent from signer selector; fragment clearing requested')
  page.screenshot(path=str(out/'wallet-desktop.png'),full_page=True)
  confirmation=page.locator('#pending article input:not([type=checkbox])');confirmation.fill('wrong');page.get_by_role('button',name='この内容だけ承認').click();page.wait_for_function("document.getElementById('message').textContent.includes('CONFIRMATION')");assert page.locator('#pending article').count()==1;steps.append('Recipient mismatch displayed, no successful approval')
  confirmation.fill('0x'+'35'*20);page.get_by_role('button',name='この内容だけ承認').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='0'");steps.append('Exact recipient sends only bound intent approval; request clears')
  page.locator('#balance').click();page.wait_for_function("document.getElementById('balanceResult').textContent.includes('1000000000000000000')");steps.append('Read-only balance observation renders in atomic units')
  page.locator('#recipient').fill('0x'+'35'*20);page.locator('#amount').fill('0.000000000000000001');page.get_by_role('button',name='照合して確認画面へ').click();page.wait_for_function("document.getElementById('pendingCount').textContent==='1'")
  request=page.evaluate("window.__calls.filter(c=>c.route==='transfers/prepare').at(-1).body.transfer");assert request['amount']=='0.000000000000000001';steps.append('Human decimal amount is sent unchanged to the signer-side transfer builder')
  page.locator('#lock').click();page.wait_for_function("!document.getElementById('access').hidden");page.locator('#password').fill('mock password persists while typing');page.wait_for_timeout(2300);assert page.locator('#password').input_value()=='mock password persists while typing';steps.append('Locked status polling does not erase a password being entered')
  page.locator('#unlock').click();page.wait_for_function("document.getElementById('access').hidden");assert page.locator('#password').input_value()=='';steps.append('Unlock clears password DOM after submission')
  page.evaluate("window.__state.accounts[0].label='<img src=x onerror=alert(1)>'");page.wait_for_timeout(2200);assert '<img' in page.locator('#accounts').inner_text();assert page.locator('#accounts img').count()==0;steps.append('Untrusted labels render as text, not HTML')
  page.evaluate("window.__state.accounts[0].label='EVM · 公開試験アドレス';window.__delayPrepare=true")
  page.get_by_role('button',name='照合して確認画面へ').click();page.wait_for_function('typeof window.__releasePrepare==="function"');page.locator('#lock').click();page.wait_for_function("!document.getElementById('access').hidden");page.evaluate('window.__releasePrepare()');page.wait_for_timeout(200);assert page.locator('#workspace').is_hidden();steps.append('Lock works during a pending operation; late result cannot unlock the UI')
  page.locator('#password').fill('mock unlock password');page.locator('#unlock').click();page.wait_for_function("document.getElementById('access').hidden")
  page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200);assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth'),page.evaluate('[document.documentElement.scrollWidth,window.innerWidth]');page.screenshot(path=str(out/'wallet-mobile.png'),full_page=True);steps.append('390px mobile layout has no horizontal overflow')
  assert not errors,errors
  result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False};(out/'browser-offline-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');browser.close();return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
