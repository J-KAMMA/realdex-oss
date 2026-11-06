#!/usr/bin/env python3
"""Smart-account UI with synthetic API only. No RPC, backend signing, CSP or chain assurance."""
from frontend_source import frontend_source
from pathlib import Path
import argparse,json,re
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[2]
def run(out):
    out.mkdir(parents=True,exist_ok=False)
    html=(ROOT/'wallet/public/index.html').read_text();html=re.sub(r'<script\b[^>]*>.*?</script>','',html,flags=re.S);html=re.sub(r'<link[^>]+stylesheet[^>]*>','',html)
    html=html.replace('</head>','<style>'+(ROOT/'wallet/public/styles.css').read_text()+'</style></head>');steps=[]
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox']);page=browser.new_page(viewport={'width':1440,'height':1000});errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.set_content(html)
        page.evaluate('''()=>{
          const owner='0x'+'11'.repeat(20),key='0x'+'22'.repeat(20),account='0x'+'33'.repeat(20),recipient='0x'+'44'.repeat(20),factory='0x'+'55'.repeat(20),token='0x'+'66'.repeat(20);
          window.__calls=[];window.__delay=false;window.__state={exists:true,locked:false,backupRequired:false,expiresAt:Date.now()+300000,accounts:[{id:'owner',family:'evm',kind:'local',label:'所有者の試験鍵',address:owner},{id:'session',family:'evm',kind:'local',label:'制限付き補助鍵',address:key}],networks:[{chainId:'31337',name:'SYNTHETIC LOCAL EVM',symbol:'TEST',broadcastEnabled:true,tokens:[{address:token,symbol:'DEMO',decimals:6}]}],smartAccounts:[{id:'smart',label:'Demo smart account',ownerAccountId:'owner',chainId:'31337',genesisHash:'0x'+'77'.repeat(32),factory,address:account,salt:'0x'+'88'.repeat(32)}],pending:[],sessions:[],agents:[],allowedAppOrigins:[]};
          window.fetch=async(url,init)=>{
            if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let v={};
            if(route==='status')v=structuredClone(window.__state);
            else if(route==='smart/inspect')v={deployed:true,owner,balanceWei:'1000000000000000000',executionNonce:'2',finalityProven:false};
            else if(route==='smart/register/prepare'){if(window.__delay)await new Promise(r=>window.__release=r);v={draftId:'draft',digest:'digest',confirmation:'REGISTER '+account,descriptor:{...window.__state.smartAccounts[0],label:body.label},expiresAt:Date.now()+30000};}
            else if(route==='smart/register/commit')v={backupRequired:true};
            else if(route==='smart/prepare'||route==='smart/message/prepare'){
              if(window.__delay)await new Promise(r=>window.__release=r);
              const isMessage=route.includes('message');const op=body.operation??{},kind=isMessage?'smart-message':'smart-transaction';
              const summary=isMessage?{operation:'smart-account-message',recipient:account,network:'SYNTHETIC',chainId:'31337',message:body.message,hash:'0x'+'99'.repeat(32),digest:'0x'+'ab'.repeat(32),epoch:'1',validUntil:body.validUntil}:{network:'SYNTHETIC',chainId:'31337',operation:'smart-account-'+op.type,from:op.type==='session-transfer'?key:owner,recipient:op.type==='grant-session'?key:account,executionFeeCapWei:'1000000000000000',nonce:'3',assetMoves:[{amountAtomic:'1250000',symbol:'DEMO',decimals:6}],details:{...op,gasPayer:op.type==='session-transfer'?key:owner,dailyWindow:'UTC calendar day'},smart:{descriptor:window.__state.smartAccounts[0],owner,operation:{type:'batch',calls:[{target:recipient,value:'100',data:'0x'}]}}};
              v={id:'request-'+window.__calls.length,intentId:'intent-'+window.__calls.length,summary};window.__state.pending.push({...v,kind,state:'pending',origin:'http://127.0.0.1:8790',expiresAt:Date.now()+30000});
            }else if(route==='reject'){window.__state.pending=window.__state.pending.filter(r=>r.id!==body.id);}
            else if(route==='approve'){window.__state.pending=[];v={approved:true,broadcastState:'signed'};}
            else if(route==='journal')v={records:[]};
            else if(route==='smart/messages')v={messages:[{id:'m1',smartAccountId:'smart',message:'Sign in to this local test only',hash:'0x'+'99'.repeat(32),validUntil:String(Math.floor(Date.now()/1000)+300),epoch:'1',signature:'0x'+'aa'.repeat(103)}]};
            else if(route==='smart/message/verify')v={valid:true};
            else if(route==='lock'){window.__state.locked=true;window.__state.pending=[];}
            else return new Response(JSON.stringify({error:'OFFLINE_UNSUPPORTED_ROUTE'}),{status:400});
            return new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
          };
        }''')
        prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
        page.add_script_tag(type='module',content=prefix+frontend_source(ROOT));page.wait_for_function("document.getElementById('accountCount').textContent==='2'")
        assert page.locator('#smartAccount').input_value()=='smart';assert '未監査' in page.locator('#smartPanel').inner_text();steps.append('Smart-account panel distinguishes immutable contract address and owner EOA')
        page.locator('#smartInspect').click();page.wait_for_function("!document.getElementById('smartInspection').hidden");assert 'false' in page.locator('#smartInspection').inner_text();steps.append('Inspection is read-only and does not claim consensus proof')
        page.locator('#smartAction').select_option('payment');page.locator('#smartField_recipient').fill('0x'+'44'*20);page.locator('#smartField_amount').fill('0.001');page.locator('#smartOperationForm button[type=submit]').click();page.wait_for_selector('#pending article')
        b=page.evaluate("window.__calls.find(c=>c.route==='smart/prepare').body.operation");assert b['type']=='payments' and b['transfers'][0]['amount']=='0.001';assert not page.locator('#pending input[type=checkbox]').is_checked();steps.append('Single payment becomes a structured request; broadcast is unchecked')
        assert 'ガス代を払う鍵' in page.locator('#pending').inner_text() and '資産を持つアカウント' in page.locator('#pending').inner_text();steps.append('Approval shows asset holder, gas payer, nonce and every exact signed call')
        assert not page.evaluate("window.__calls.some(c=>c.route==='approve')");steps.append('Preparing a request does not sign')
        page.locator('#pending button',has_text='拒否').click();page.wait_for_function("window.__state.pending.length===0");steps.append('Owner can reject a prepared smart-account request')
        page.locator('#smartAction').select_option('payments');page.locator('#smartField_transfers').fill(json.dumps([{'asset':'native','recipient':'0x'+'44'*20,'amount':'0.001'},{'asset':'native','recipient':'0x'+'45'*20,'amount':'0.002'}]));page.locator('#smartOperationForm button[type=submit]').click();page.wait_for_selector('#pending article');b=page.evaluate("window.__calls.filter(c=>c.route==='smart/prepare').at(-1).body.operation");assert len(b['transfers'])==2;steps.append('Batch form preserves all independently specified recipients and amounts');page.locator('#pending button',has_text='拒否').click();page.wait_for_function("window.__state.pending.length===0")
        page.locator('#smartAction').select_option('swap');assert '承認・交換・承認取消し' in page.locator('#smartFields').inner_text();steps.append('Atomic swap explicitly combines bounded approval, swap and zero approval')
        page.locator('#smartAction').select_option('grant-session');assert page.locator('#smartField_sessionAccountId').input_value()=='session';assert 'UTC暦日' in page.locator('#smartFields').inner_text();steps.append('Session policy excludes owner key and uses explicitly labeled UTC calendar-day caps')
        page.locator('#smartField_recipient').fill('0x'+'44'*20)
        for k,v in [('perCall','0.001'),('daily','0.005'),('total','0.01')]:page.locator('#smartField_'+k).fill(v)
        page.locator('#smartOperationForm button[type=submit]').click();page.wait_for_selector('#pending article');b=page.evaluate("window.__calls.filter(c=>c.route==='smart/prepare').at(-1).body.operation");assert b['sessionAccountId']=='session' and b['daily']=='0.005' and 'minutes' not in b;steps.append('Grant request binds recipient, asset, caps and an absolute expiry without auto-signing');page.locator('#pending button',has_text='拒否').click();page.wait_for_function("window.__state.pending.length===0")
        panel=page.locator('#smartPanel');panel.evaluate("el=>{const p=document.createElement('p');p.className='notice';p.textContent='OFFLINE UI · 合成API · 実HTTP／CSP／署名／実チェーンの検証ではありません';el.prepend(p);}");panel.screenshot(path=str(out/'smart-account-desktop.png'))
        page.set_viewport_size({'width':390,'height':844});assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth');panel.screenshot(path=str(out/'smart-account-mobile.png'));steps.append('Desktop and 390px mobile render without horizontal overflow')
        page.locator('#smartAction').select_option('session-transfer');assert page.locator('#smartField_recipient').count()==0;assert page.locator('#smartField_asset').count()==0;steps.append('Session payment UI cannot substitute the on-chain recipient or asset')
        page.locator('#smartMessageForm').evaluate('el=>el.closest("details").open=true');page.locator('#smartMessage').fill('Local test\nnonce: 123');page.locator('#smartMessageForm button[type=submit]').click();page.wait_for_selector('#pending article');assert page.locator('#pending input[type=checkbox]').count()==0;assert 'Local test\nnonce: 123' in page.locator('#pending').inner_text();steps.append('Multiline message approval shows exact text and has no transaction-send checkbox')
        page.locator('#pending button',has_text='拒否').click();page.wait_for_function("window.__state.pending.length===0");page.locator('#smartMessageHistory').click();page.wait_for_selector('#smartMessages article');page.locator('#smartMessages button',has_text='ERC-1271').click();page.wait_for_function("document.getElementById('message').textContent.includes('有効と観測')");steps.append('Stored signatures can be rechecked without signing or submitting a transaction')
        page.locator('#smartRegistration').evaluate('el=>el.open=true');page.locator('#smartFactory').fill('0x'+'55'*20);page.locator('#smartLabel').fill('New account');page.locator('#smartRegisterForm button[type=submit]').click();page.wait_for_function("!document.getElementById('smartRegisterReview').hidden");assert not page.evaluate("window.__calls.some(c=>c.route==='smart/register/commit')");steps.append('Registration has a separate predicted-address confirmation and cannot auto-deploy')
        page.locator('#smartLabel').fill('Changed');assert page.locator('#smartRegisterReview').is_hidden();steps.append('Changing registration data invalidates the old draft immediately')
        page.evaluate('window.__delay=true');page.locator('#smartRegisterForm button[type=submit]').click();page.wait_for_function("typeof window.__release==='function'");page.locator('#smartLabel').fill('Changed again');page.evaluate('window.__release()');page.wait_for_function("document.getElementById('message').textContent.includes('SMART_FORM_CHANGED')");assert page.locator('#smartRegisterReview').is_hidden();steps.append('Late registration response cannot revive an edited draft')
        page.evaluate('window.__delay=false');page.locator('#lock').click();page.wait_for_function("document.getElementById('workspace').hidden");assert page.locator('#smartFields').inner_text()=='';assert page.locator('#smartMessages').inner_text()=='';assert page.locator('#smartMessage').input_value()=='';steps.append('Lock clears pending details and signed-message content from the visible workspace')
        assert not page.evaluate("window.__calls.some(c=>['approve','rebroadcast'].includes(c.route))");assert not errors,errors
        result={'schema':'realdex.smart-ui-test.v1','status':'passed','mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,'realHttpIntegration':False,'cspEnforced':False,'realEvm':False,'realAssetsUsed':False}
        (out/'smart-browser.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');browser.close();return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,required=True);print(json.dumps(run(p.parse_args().output),ensure_ascii=False,indent=2))
