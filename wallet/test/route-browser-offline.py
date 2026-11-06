#!/usr/bin/env python3
"""Owner route UI, synthetic responses; no HTTP/CSP/EVM or signature proof."""
from frontend_source import frontend_source
from pathlib import Path
import argparse,json,re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]

def run(out):
    out.mkdir(parents=True,exist_ok=False)
    html=(ROOT/'wallet/public/index.html').read_text()
    html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S)
    html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
    html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
    steps=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
        page.evaluate('''()=>{
          const A='0x'+'a1'.repeat(20),B='0x'+'b1'.repeat(20),C='0x'+'c1'.repeat(20),P='0x'+'d1'.repeat(20),Q='0x'+'d2'.repeat(20),R='0x'+'e1'.repeat(20),from='0x'+'35'.repeat(20);
          window.__calls=[];window.__delay=false;window.__expired=false;
          window.__state={exists:true,locked:false,backupRequired:false,expiresAt:Date.now()+300000,accounts:[{id:'owner',family:'evm',kind:'local',label:'公開試験用 / 合成API',address:from}],networks:[{chainId:'31337',name:'SYNTHETIC EVM — 実チェーン接続なし',symbol:'TEST',broadcastEnabled:true,tokens:[]}],pending:[],sessions:[],agents:[],allowedAppOrigins:[]};
          window.__catalog={chainId:'31337',maxSlippageBps:100,tokens:[A,B,C].map((address,i)=>({address,symbol:'TEST-'+i,decimals:6})),pools:[{address:P,token0:A,token1:B},{address:Q,token0:B,token1:C}],factories:[],spenders:[{address:P,kind:'pool'},{address:Q,kind:'pool'},{address:R,kind:'router'}]};
          window.fetch=async(url,init)=>{
            if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');
            const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let value={};
            if(route==='status')value=structuredClone(window.__state);
            else if(route==='dex/catalog')value=structuredClone(window.__catalog);
            else if(route==='dex/quote-route'){
              if(window.__delay)await new Promise(r=>window.__release=r);
              value={expiresAt:Date.now()+(window.__expired?-1:30000),output:'0.4965',minimumOutput:'0.494018',outputSymbol:'TEST-2',tokenPath:[A,B,C],hops:[{pool:P,feeBps:30},{pool:Q,feeBps:30}]};
            }else if(route==='dex/prepare'){
              value={id:'request-'+window.__calls.length,intentId:'intent-'+window.__calls.length,summary:{network:'SYNTHETIC',chainId:'31337',operation:'local-router-swap',from,to:R,recipient:body.operation.recipient,asset:'TEST-0',amountAtomic:'500000',minimumOutputAtomic:'494018',executionFeeCapWei:'1000000000000',nonce:'0',details:{pools:[P,Q],tokenPath:[A,B,C]},assetMoves:[]}};
              window.__state.pending.push({...value,kind:'transaction',state:'pending',origin:'http://127.0.0.1:8790',expiresAt:Date.now()+30000});
            }else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
            else throw Error('OFFLINE_UNSUPPORTED_ROUTE');
            return new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
          };
        }''')
        prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
        page.add_script_tag(type='module',content=prefix+frontend_source(ROOT))
        page.wait_for_function("document.getElementById('accountCount').textContent==='1'")
        page.locator('#dexLoad').click();page.wait_for_selector('#dex_amount')
        page.locator('#dexAction').select_option('route-swap')
        P='0x'+'d1'*20;Q='0x'+'d2'*20
        page.locator('#dex_pools').fill(P+', '+Q);page.locator('#dex_amount').fill('0.5');page.locator('#dex_pools').dispatch_event('change')
        assert 'TEST-1' in page.locator('#dexPairInfo').inner_text()
        steps.append('Owner chooses a local router and explicit ordered pools, including intermediate assets')
        page.locator('#dexQuote').click();page.wait_for_selector('#dexQuotes article')
        b=page.evaluate("window.__calls.find(c=>c.route==='dex/quote-route').body.quote")
        assert b['pools']==[P,Q] and b['amount']=='0.5'
        assert 'ガス代控除前' in page.locator('#dexQuotes').inner_text()
        assert not page.evaluate("window.__calls.some(c=>c.route==='dex/prepare'||c.route==='approve')")
        steps.append('Read-only route quote sends ordered addresses, shows gross output, and creates no approval')
        page.locator('#dexQuotes button').click();assert page.locator('#dex_minimumOutput').input_value()=='0.494018'
        assert not page.evaluate("window.__calls.some(c=>c.route==='dex/prepare'||c.route==='approve')")
        steps.append('Applying a quote fills only the final-token minimum, without preparing or signing')
        page.locator('#dexPrepare').click();page.wait_for_function("window.__calls.some(c=>c.route==='dex/prepare')");page.wait_for_selector('#pending article')
        request=page.evaluate("window.__calls.find(c=>c.route==='dex/prepare').body.operation")
        assert request['action']=='route-swap' and request['pools']==[P,Q]
        assert page.locator('#pending input[type=checkbox]').is_checked() is False
        assert ('0x'+'b1'*20) in page.locator('#pending').inner_text()
        steps.append('Structured route preparation displays every hop and keeps the separate send checkbox unchecked')
        page.locator('#dex_amount').fill('0.51');assert page.locator('#dexQuotes article').count()==0
        steps.append('An input change immediately discards an old quote')
        page.evaluate('window.__delay=true');page.locator('#dexQuote').click();page.wait_for_function("typeof window.__release==='function'")
        page.locator('#dex_pools').fill(Q+', '+P);page.evaluate('window.__release()');page.wait_for_function("document.getElementById('message').textContent.includes('DEX_FORM_CHANGED')")
        assert page.locator('#dexQuotes article').count()==0
        steps.append('Late response after an ordered-path change is rejected')
        page.evaluate('window.__delay=false;window.__expired=true');page.locator('#dex_pools').fill(P+', '+Q);page.locator('#dexQuote').click();page.wait_for_selector('#dexQuotes article');page.locator('#dexQuotes button').click()
        page.wait_for_function("document.getElementById('message').textContent.includes('DEX_QUOTE_EXPIRED_OR_CHANGED')")
        steps.append('Expired quote cannot be applied to the form')
        page.evaluate('window.__expired=false');page.locator('#dexQuote').click();page.wait_for_selector('#dexQuotes article')
        panel=page.locator('#dexPanel');panel.evaluate("el=>{const p=document.createElement('p');p.className='notice';p.textContent='OFFLINE DOM / 合成応答 / この画面試験に実HTTP・CSP・実EVMは含みません';el.prepend(p);}")
        panel.screenshot(path=str(out/'route-panel.png'))
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(100)
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        panel.screenshot(path=str(out/'route-mobile.png'))
        steps.append('Desktop and 390px mobile route panels render without horizontal overflow')
        page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden")
        assert page.locator('#dexFields').inner_text()=='' and page.locator('#dexQuotes').inner_text()==''
        assert not page.evaluate("window.__calls.some(c=>['approve','rebroadcast'].includes(c.route))")
        steps.append('Lock clears the route UI; this entire test never approves or broadcasts')
        assert not errors,errors
        result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,'realHttpIntegration':False,'cspCorsIntegration':False,'realEvm':False,'liveChain':False}
        (out/'route-browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');browser.close();return result

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path)
    print(json.dumps(run(p.parse_args().output),ensure_ascii=False,indent=2))
