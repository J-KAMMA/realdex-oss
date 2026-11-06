#!/usr/bin/env python3
"""Offline DOM acceptance tests with synthetic API data only; no network/crypto bridge."""
from frontend_source import frontend_source
from pathlib import Path
import argparse, json, re
from playwright.sync_api import sync_playwright
ROOT = Path(__file__).resolve().parents[2]

def run(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    html = (ROOT/'wallet/public/index.html').read_text()
    html = re.sub(r'<script\b[^>]*>.*?</script>', '', html, flags=re.S)
    html = re.sub(r'<link[^>]+stylesheet[^>]*>', '', html)
    html = html.replace('</head>', '<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>')
    html = html.replace('<body>', '<body><aside style="background:#453910;color:#fff4cd;text-align:center;padding:10px;font:12px system-ui">OFFLINE DOM / 合成API・公開試験口座 / 実HTTP・CSP・暗号処理はこの画面試験の対象外</aside>')
    steps=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':1440,'height':1050}); errors=[]
        page.on('pageerror', lambda e:errors.append(str(e)));page.set_content(html)
        page.evaluate('''()=>{
          const to='0x'+'35'.repeat(20),token='0x'+'44'.repeat(20),from='0x'+'11'.repeat(20);
          window.__calls=[];window.__state={exists:true,locked:false,backupRequired:false,expiresAt:Date.now()+300000,
            accounts:[{id:'owner',label:'Personal · 試験口座',family:'evm',kind:'local',address:from},
             {id:'ai',label:'Research Agent · 専用試験口座',family:'evm',kind:'local',address:'0x'+'22'.repeat(20)},
             {id:'watch',label:'閲覧専用',family:'evm',kind:'watch',address:'0x'+'33'.repeat(20)}],
            networks:[{chainId:'31337',name:'SYNTHETIC local test',symbol:'TEST',broadcastEnabled:true,tokens:[{address:token,symbol:'TUSD',decimals:6}]}],pending:[],sessions:[],agents:[],allowedAppOrigins:[]};
          window.__fetch=async (url,init)=>{
            if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');
            if(init.headers.authorization!=='Bearer '+'f'.repeat(64))throw Error('UI_CAPABILITY_MISSING');
            const body=JSON.parse(init.body),route=String(url).slice(5);window.__calls.push({route,body});let value={};
            if(route==='status')value=structuredClone(window.__state);
            else if(route==='agents/prepare'){
              if(window.__delayPrepare)await new Promise(resolve=>window.__releasePrepare=resolve);
              const policy={...body.policy,id:'policy-'+(window.__state.agents.length+1),schema:'realdex.agent-policy.v1',symbol:body.policy.asset==='native'?'TEST':'TUSD',decimals:body.policy.asset==='native'?18:6,status:'active',activated:false,usage:{count:0,lifetimeAtomic:'0',lifetimeFeeWei:'0'}};
              window.__draft={draftId:'draft',digest:'a'.repeat(64),expiresAt:Date.now()+60000,policy,confirmation:policy.mode==='auto'?'ALLOW BOUNDED AUTOMATION':'REQUIRE MY APPROVAL'};value=window.__draft;
            }else if(route==='agents/create'){
              if(body.confirmation!==window.__draft.confirmation)value={error:'AGENT_CONFIRMATION_REQUIRED'};
              else {const p={...window.__draft.policy,activated:true};window.__state.agents.push(p);value={policy:p,token:'c'.repeat(64),tokenShownOnce:true};}
            }else if(route==='agents/activate'){
              const p=window.__state.agents.find(p=>p.id===body.id);
              if(body.confirmation!==(p.mode==='auto'?'ALLOW BOUNDED AUTOMATION':'REQUIRE MY APPROVAL'))value={error:'AGENT_CONFIRMATION_REQUIRED'};
              else {p.activated=true;value={policy:p,token:'d'.repeat(64)};}
            }else if(route==='agents/stop')window.__state.agents.forEach(p=>p.activated=false);
            else if(route==='agents/revoke'){const p=window.__state.agents.find(p=>p.id===body.id);p.activated=false;p.status='revoked';}
            else if(route==='agents/history')value={requests:[{requestId:'ar1',idempotencyKey:'invoice-001',recipient:to,amountAtomic:'1000000000000000',state:'signed',broadcastState:'broadcast-unknown',feeReservedWei:'75600000000000',transactionHash:'0x'+'ab'.repeat(32),note:'<img src=x onerror=alert(1)>',error:null}]};
            else if(route==='lock'){window.__state.locked=true;window.__state.agents.forEach(p=>p.activated=false);}
            else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
            else if(route==='transfers/balance')value={atomic:'123456789',amount:'123.456789',symbol:'TUSD',nativeAmount:'1.0'};
            else if(route==='transfers/receive')value={recipient:from,chainId:'31337',uri:'ethereum:'+token+'@31337/transfer?address='+from+'&uint256=1000000'};
            else if(route==='transfers/parse-uri')value={recipient:to,asset:token,amount:'1.234567'};
            else if(route==='journal')value={records:[]};
            else throw Error('OFFLINE_METHOD_NOT_IMPLEMENTED');
            return new Response(JSON.stringify(value),{status:value.error?400:200,headers:{'content-type':'application/json'}});
          };window.fetch=window.__fetch;
        }''')
        prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
        page.add_script_tag(type='module',content=prefix+frontend_source(ROOT))
        page.wait_for_function("document.getElementById('accountCount').textContent==='3'")
        assert page.locator('#agentMode').input_value()=='manual'
        assert page.locator('#agentAccount option').count()==2
        steps.append('AI mode defaults to manual; watch-only account cannot be selected as signer')
        page.locator('#agentCreateDetails summary').click();page.locator('#agentLabel').fill('Research Agent')
        page.locator('#agentAccount').select_option('ai');page.locator('#agentRecipients').fill('0x'+'35'*20)
        page.get_by_role('button',name='権限の内容を確認',exact=True).click()
        page.wait_for_function("!document.getElementById('agentReview').hidden")
        policy=page.evaluate("window.__calls.filter(x=>x.route==='agents/prepare').at(-1).body.policy")
        assert policy['mode']=='manual' and policy['accountId']=='ai'
        assert policy['limits']['perTransferAtomic']=='1000000000000000'
        assert policy['limits']['rolling24hAtomic']=='5000000000000000'
        assert policy['limits']['perTxFeeWei']=='100000000000000'
        assert page.locator('#agentList article').count()==0 and page.locator('#agentCredential').is_hidden()
        steps.append('Two-step grant review binds account, recipients and exact atomic limits; no permission before confirmation')
        page.locator('#agentConfirmation').fill('yes');page.get_by_role('button',name='この条件だけを許可する').click()
        page.wait_for_function("document.getElementById('message').textContent.includes('AGENT_CONFIRMATION_REQUIRED')")
        assert page.locator('#agentCredential').is_hidden();steps.append('Wrong confirmation phrase does not create a capability')
        page.locator('#agentConfirmation').fill('REQUIRE MY APPROVAL');page.get_by_role('button',name='この条件だけを許可する').click()
        page.wait_for_function("!document.getElementById('agentCredential').hidden")
        assert page.locator('#agentToken').get_attribute('type')=='password'
        assert page.locator('#agentToken').input_value()=='c'*64
        assert page.locator('#agentList article').count()==1
        assert page.evaluate("window.__calls.every(c=>!JSON.stringify(c.body).includes('c'.repeat(64)))")
        steps.append('Capability appears once in password field; subsequent UI calls do not include it')
        page.locator('#hideAgentToken').click();assert page.locator('#agentToken').input_value()==''
        steps.append('Explicit hide removes the credential from the DOM')
        page.locator('#agentMode').select_option('auto');page.locator('#agentLabel').fill('Bounded Research Agent')
        page.get_by_role('button',name='権限の内容を確認',exact=True).click()
        page.wait_for_function("document.getElementById('agentPhraseHelp').textContent.includes('ALLOW BOUNDED AUTOMATION')")
        page.locator('#agentConfirmation').fill('ALLOW BOUNDED AUTOMATION');page.get_by_role('button',name='この条件だけを許可する').click()
        page.wait_for_function("document.querySelectorAll('#agentList article').length===2")
        steps.append('Automatic mode requires its own explicit phrase, separate from manual mode')
        page.locator('#agentStop').click();page.wait_for_function("window.__state.agents.every(p=>!p.activated)")
        assert page.locator('#agentCredential').is_hidden() and page.locator('#agentToken').input_value()==''
        page.wait_for_function("document.querySelectorAll('#agentList article input').length===2")
        page.locator('#agentList article').first.locator('input').fill('REQUIRE MY APPROVAL')
        page.locator('#agentList article').first.get_by_role('button',name='確認して再有効化').click()
        page.wait_for_function("document.getElementById('agentToken').value==='d'.repeat(64)")
        steps.append('Stop hides tokens; reactivation is explicit and receives a new capability')
        page.locator('#lock').click();page.wait_for_function("!document.getElementById('access').hidden")
        assert page.locator('#agentToken').input_value()==''
        page.locator('#password').fill('synthetic unlock password');page.locator('#unlock').click()
        page.wait_for_function("document.getElementById('access').hidden")
        assert page.evaluate("window.__state.agents.every(p=>!p.activated)")
        steps.append('Lock clears credentials; unlocking does not reactivate AI authority')
        page.locator('#sendAsset').select_option('0x'+'44'*20);page.locator('#balance').click()
        page.wait_for_function("document.getElementById('balanceResult').textContent.includes('123.456789 TUSD')")
        page.locator('#amount').fill('1');page.locator('#receive').click()
        page.wait_for_function("document.getElementById('receiveResult').textContent.includes('@31337/transfer')")
        steps.append('Selected ERC20 balance and chain-qualified receive request render with exact quantities')
        page.locator('#paymentUriForm').locator('xpath=..').locator('summary').click()
        page.locator('#paymentUri').fill('ethereum:synthetic-test-input');n=page.evaluate("window.__calls.filter(c=>['approve','transfers/prepare'].includes(c.route)).length")
        page.get_by_role('button',name='内容を入力欄に反映').click();page.wait_for_function("document.getElementById('amount').value==='1.234567'")
        assert page.evaluate("window.__calls.filter(c=>['approve','transfers/prepare'].includes(c.route)).length")==n
        steps.append('Payment URI import changes the form only; no preparation, signing or transmission')
        page.locator('#agentHistory').click();page.wait_for_function("document.querySelectorAll('#agentRequests article').length===1")
        assert page.locator('#agentRequests img').count()==0 and '<img' in page.locator('#agentRequests').inner_text()
        assert 'broadcast-unknown' in page.locator('#agentRequests').inner_text()
        steps.append('Unknown result and untrusted AI note render honestly as text without HTML execution')
        page.evaluate("window.__delayPrepare=true")
        page.get_by_role('button',name='権限の内容を確認',exact=True).click();page.wait_for_function("typeof window.__releasePrepare==='function'")
        page.locator('#agentStop').click();page.wait_for_function("window.__calls.filter(x=>x.route==='agents/stop').length===2")
        page.evaluate('window.__releasePrepare()');page.wait_for_timeout(200)
        assert page.locator('#agentReview').is_hidden()
        steps.append('Emergency stop works while UI is busy; late draft cannot restore the review')
        page.evaluate("window.__delayPrepare=false;window.__state.agents[0].usage={count:2,lifetimeAtomic:'2000000000000000',lifetimeFeeWei:'151200000000000'}")
        page.wait_for_timeout(2200)
        page.locator('#agentCreateDetails').evaluate('(el)=>el.open=false')
        page.locator('#agentList article').first.locator('details').evaluate('(el)=>el.open=true')
        page.locator('#agentPanel').evaluate("el=>{const b=document.createElement('p');b.className='notice';b.textContent='OFFLINE DOM / 合成APIの画面試験 / 実チェーン・実HTTP結合ではありません';el.prepend(b);}")
        page.locator('#agentPanel').scroll_into_view_if_needed()
        page.screenshot(path=str(out/'agent-wallet-desktop.png'),full_page=True)
        page.locator('#agentPanel').screenshot(path=str(out/'agent-wallet-panel.png'))
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(200)
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        page.screenshot(path=str(out/'agent-wallet-mobile.png'),full_page=True)
        steps.append('Desktop and 390px mobile rendering; no horizontal overflow')
        assert not errors, errors
        result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False}
        (out/'agent-browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        browser.close();return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',required=True,type=Path);a=p.parse_args();print(json.dumps(run(a.output),ensure_ascii=False,indent=2))
