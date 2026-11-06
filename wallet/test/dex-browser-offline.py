#!/usr/bin/env python3
"""Offline UI test: synthetic API, no CSP/HTTP integration, no actual crypto, EVM or send."""
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
    banner='OFFLINE DOM / 合成API・公開試験口座 / 実HTTP・CSP・実EVMは未検証'
    html=html.replace('<body>','<body><aside style="padding:10px;text-align:center;background:#453910;color:#fff4cd">'+banner+'</aside>')
    steps=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1000});errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.set_content(html)
        page.evaluate('''()=>{
          const A='0x'+'aa'.repeat(20),B='0x'+'bb'.repeat(20),P='0x'+'cc'.repeat(20),F='0x'+'ee'.repeat(20),from='0x'+'11'.repeat(20);
          window.__calls=[];window.__delay=false;
          window.__state={exists:true,locked:false,backupRequired:false,expiresAt:Date.now()+300000,
            accounts:[{id:'owner',family:'evm',kind:'local',label:'公開試験口座',address:from}],
            networks:[{chainId:'31337',name:'SYNTHETIC EVM — 実チェーンではありません',symbol:'TEST',broadcastEnabled:true,tokens:[]}],
            pending:[],sessions:[],agents:[],allowedAppOrigins:[]};
          window.__catalog={chainId:'31337',maxSlippageBps:100,tokens:[{address:A,symbol:'TEST-A',decimals:6},{address:B,symbol:'TEST-B',decimals:18}],
            pools:[{address:P,token0:A,token1:B}],factories:[{address:F}],spenders:[{address:P,kind:'pool'}]};
          window.fetch=async(url,init)=>{
            if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');
            const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let value={};
            if(route==='status')value=structuredClone(window.__state);
            else if(route==='dex/catalog')value=structuredClone(window.__catalog);
            else if(route==='dex/quote'){
              if(window.__delay)await new Promise(r=>window.__release=r);
              value={expiresAt:Date.now()+30000,outputSymbol:'TEST-B',comparisonComplete:true,excluded:[],
                candidates:[{pool:P,output:'2.51',minimumOutput:'2.49745',feeBps:30}]};
            }else if(route==='dex/prepare'){
              value={id:'request-'+window.__state.pending.length,intentId:'intent-'+window.__state.pending.length,
                summary:{network:'SYNTHETIC EVM',chainId:'31337',operation:body.operation.action,from,to:P,recipient:body.operation.recipient||from,
                  asset:'TEST',amountAtomic:'1250000',minimumOutputAtomic:'2497450000000000000',executionFeeCapWei:'75600000000000',nonce:'0',details:{},assetMoves:[]}};
              window.__state.pending.push({...value,kind:'transaction',state:'pending',origin:'http://127.0.0.1:8790',expiresAt:Date.now()+30000});
            }else if(route==='networks/review')value={id:'review-1',digest:'ab'.repeat(32),chainId:'31337',expiresAt:Date.now()+90000,
              confirmation:'REPLACE 31337 AND LOCK',before:{contracts:[]},after:body.network,contractChanges:[{action:'added',after:{symbol:'<img src=x>'}}],contractsCertified:false};
            else if(route==='networks/replace'){
              if(body.confirmation!=='REPLACE 31337 AND LOCK')value={error:'NETWORK_REVIEW_CONFIRMATION_REQUIRED'};
              else{window.__state.locked=true;window.__state.pending=[];value={changed:true,locked:true};}
            }else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
            else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
            else throw Error('OFFLINE_UNSUPPORTED_ROUTE');
            return new Response(JSON.stringify(value),{status:value.error?400:200,headers:{'content-type':'application/json'}});
          };
        }''')
        prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
        page.add_script_tag(type='module',content=prefix+frontend_source(ROOT))
        page.wait_for_function("document.getElementById('accountCount').textContent==='1'")
        assert not page.evaluate("window.__calls.some(c=>c.route.startsWith('dex/'))")
        assert page.locator('#dexPrepare').is_disabled()
        steps.append('Initial load does not query contracts or sign; owner explicitly loads the local catalogue')
        page.locator('#dexLoad').click();page.wait_for_selector('#dex_amount')
        page.locator('#dex_amount').fill('1.25');page.locator('#dexQuote').click()
        page.wait_for_selector('#dexQuotes article')
        assert '追加費用を引く前' in page.locator('#dexQuotes').inner_text()
        page.locator('#dexQuotes').get_by_role('button',name='この見積りを入力欄へ').click()
        assert page.locator('#dex_minimumOutput').input_value()=='2.49745'
        assert not page.evaluate("window.__calls.some(c=>c.route==='dex/prepare'||c.route==='approve')")
        steps.append('Direct-pair quote fills a bounded minimum without preparing, approving or sending a transaction')
        def submit():
            count=page.evaluate("window.__calls.filter(c=>c.route==='dex/prepare').length")
            page.locator('#dexPrepare').click()
            page.wait_for_function("n=>window.__calls.filter(c=>c.route==='dex/prepare').length===n+1",arg=count)
            page.wait_for_timeout(100)
            return page.evaluate("window.__calls.filter(c=>c.route==='dex/prepare').at(-1).body")
        b=submit();assert b['operation']['amount']=='1.25' and b['operation']['minimumOutput']=='2.49745'
        assert page.locator('#pending article').count()==1
        assert not page.locator('#pending input[type=checkbox]').is_checked()
        steps.append('Swap preparation sends human amounts to the signer and creates a separate, unchecked-send approval card')
        page.locator('#dexAction').select_option('create-pool');page.locator('#dex_feeBps').fill('30');b=submit()
        assert b['operation']['tokenA']!=b['operation']['tokenB'] and b['operation']['feeBps']==30
        assert '作成したプールも別途検証' in page.locator('#dexPanel').inner_text()
        steps.append('Factory creation uses two explicit tokens and fee without automatically registering a pool')
        page.locator('#dexAction').select_option('approve');page.locator('#dex_amount').fill('1.25');b=submit();assert b['operation']['amount']=='1.25'
        page.locator('#dexAction').select_option('revoke');b=submit();assert set(b['operation'])=={'action','token','spender'}
        steps.append('Finite approval and revoke are separate structured requests, never a combined auto-approval')
        page.locator('#dexAction').select_option('add-liquidity')
        for name,value in [('amount0','1.2'),('amount1','2.4'),('minimumShares','0.000001')]:page.locator('#dex_'+name).fill(value)
        b=submit();assert b['operation']['minimumShares']=='0.000001'
        page.locator('#dexAction').select_option('remove-liquidity')
        for name,value in [('shares','0.000001'),('minimum0','1.1'),('minimum1','2.2')]:page.locator('#dex_'+name).fill(value)
        b=submit();assert b['operation']['minimum1']=='2.2'
        assert not page.evaluate("window.__calls.some(c=>['approve','rebroadcast'].includes(c.route))")
        steps.append('Liquidity deposit/withdrawal carry LP and token minima; all six operations remain unsigned')
        page.locator('#dexAction').select_option('swap');page.locator('#dex_amount').fill('1.25');page.locator('#dexQuote').click();page.wait_for_selector('#dexQuotes article')
        page.locator('#dex_amount').fill('1.26');assert page.locator('#dexQuotes article').count()==0
        steps.append('Changing amounts clears stale displayed quotes')
        page.evaluate('window.__delay=true');page.locator('#dexQuote').click();page.wait_for_function("typeof window.__release==='function'")
        page.locator('#dex_amount').fill('1.27');page.evaluate('window.__release()');page.wait_for_function("document.getElementById('message').textContent.includes('DEX_FORM_CHANGED')")
        assert page.locator('#dexQuotes article').count()==0
        steps.append('Late quote response is rejected after form input changes')
        page.evaluate('window.__delay=false');page.locator('#dexQuote').click();page.wait_for_selector('#dexQuotes article')
        panel=page.locator('#dexPanel');panel.evaluate("(el,text)=>{const p=document.createElement('p');p.className='notice';p.textContent=text;el.prepend(p);}",banner)
        panel.screenshot(path=str(out/'dex-panel.png'));page.screenshot(path=str(out/'dex-desktop.png'),full_page=True)
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150)
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        panel.screenshot(path=str(out/'dex-mobile.png'))
        steps.append('DEX form and quotes render without overflow on desktop and 390px mobile')
        page.set_viewport_size({'width':1440,'height':1000})
        page.locator('.settings summary').click()
        replacement={'chainId':'31337','name':'SYNTHETIC replacement','contracts':[{'symbol':'<img src=x>'}]}
        page.locator('#networkFile').set_input_files({'name':'network.json','mimeType':'application/json','buffer':json.dumps(replacement).encode()})
        page.wait_for_function("!document.getElementById('networkReview').hidden")
        assert not page.evaluate("window.__calls.some(c=>c.route==='networks/replace')")
        assert page.locator('#networkReview img').count()==0
        assert '<img src=x>' in page.locator('#networkReviewDetails').inner_text()
        steps.append('Importing an existing network opens a text-only before/after review; JSON does not become HTML or auto-apply')
        page.locator('#networkReviewConfirm').fill('wrong');page.locator('#networkApply').click()
        page.wait_for_function("document.getElementById('message').textContent.includes('NETWORK_REVIEW_CONFIRMATION_REQUIRED')")
        assert page.locator('#workspace').is_visible()
        page.locator('#networkReviewConfirm').fill('REPLACE 31337 AND LOCK');page.locator('#networkApply').click()
        page.wait_for_function("!document.getElementById('access').hidden")
        assert page.locator('#dexFields').inner_text()=='' and page.locator('#networkReview').is_hidden()
        steps.append('Wrong replacement phrase is rejected; explicit apply locks the wallet and clears prior DEX/review state')
        assert not errors,errors
        result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,
          'realHttpIntegration':False,'cspCorsIntegration':False,'realCryptographyInBrowserTest':False,'realEvm':False,'liveChain':False}
        (out/'dex-browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        browser.close();return result
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path)
    print(json.dumps(run(parser.parse_args().output),ensure_ascii=False,indent=2))
