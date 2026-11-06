#!/usr/bin/env python3
"""Offline DOM regression for receipt reconciliation; synthetic responses, no network or signing."""
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
    banner = 'OFFLINE DOM / 合成API・公開試験口座 / 実HTTP・CSP・実チェーンは未検証'
    html = html.replace('<body>', '<body><aside style="background:#453910;color:#fff4cd;text-align:center;padding:10px;font:12px system-ui">'+banner+'</aside>')
    steps = []
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        page = browser.new_page(viewport={'width':1440,'height':1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.set_content(html)
        page.evaluate('''()=>{
          const from='0x'+'11'.repeat(20),to='0x'+'35'.repeat(20);
          window.__calls=[];
          window.__state={exists:true,locked:false,backupRequired:false,expiresAt:Date.now()+300000,
            accounts:[{id:'owner',family:'evm',kind:'local',label:'公開試験口座',address:from}],
            networks:[{chainId:'31337',name:'SYNTHETIC local test',symbol:'TEST',broadcastEnabled:true,tokens:[]}],
            pending:[],sessions:[],agents:[],allowedAppOrigins:[]};
          window.__success={schema:'realdex.settlement-observation.v1',observation:'receipt-observed',observedAt:Date.UTC(2026,8,5,0,0),
            confirmations:'17',policySatisfied:true,deliveryObserved:true,reorgObserved:false,transactionReportedSuccessful:true,
            matchingTransferEventObserved:null,finalityVerified:false};
          window.__record={id:'record-001',state:'reported-confirmed',family:'evm',signed:{transactionHash:'0x'+'ab'.repeat(32)},
            summary:{chainId:'31337',from,recipient:to,amountAtomic:'1000000000000000',executionFeeCapWei:'75600000000000'},report:structuredClone(window.__success)};
          window.__mode='success';
          window.fetch=async (url,init)=>{
            if(!String(url).startsWith('/api/'))throw Error('OFFLINE_NETWORK_DISABLED');
            const route=String(url).slice(5),body=JSON.parse(init.body);window.__calls.push({route,body});let value={};
            if(route==='status')value=structuredClone(window.__state);
            else if(route==='journal')value={records:window.__state.locked?[]:[structuredClone(window.__record)]};
            else if(route==='reconcile'){
              if(window.__mode==='delay')await new Promise(resolve=>window.__release=resolve);
              if(window.__mode==='success'){
                window.__record.state='reported-confirmed';window.__record.report=structuredClone(window.__success);
              }else{
                window.__record.state='broadcast-unknown';window.__record.report={schema:'realdex.settlement-observation.v1',observedAt:Date.UTC(2026,8,5,0,1),
                  observation:window.__mode==='error'?'reconciliation-unavailable':'receipt-missing-after-observed-reorg',
                  transactionReportedSuccessful:null,confirmations:'0',policySatisfied:false,deliveryObserved:false,reorgObserved:window.__mode!=='error'};
              }
              value=window.__mode==='error'?{error:'RPC_DISAGREEMENT'}:structuredClone(window.__record);
            }else if(route==='lock'){window.__state.locked=true;}
            else if(route==='unlock'){window.__state.locked=false;window.__state.expiresAt=Date.now()+300000;}
            else throw Error('OFFLINE_UNSUPPORTED_ROUTE');
            return new Response(JSON.stringify(value),{status:value.error?400:200,headers:{'content-type':'application/json'}});
          };
        }''')
        prefix="const location={origin:'http://127.0.0.1:8790',pathname:'/wallet/',hash:'#key='+'f'.repeat(64)};const history={replaceState(){}};\n"
        page.add_script_tag(type='module',content=prefix+frontend_source(ROOT))
        page.wait_for_function("document.getElementById('accountCount').textContent==='1'")
        page.locator('#history').click()
        page.wait_for_function("document.querySelectorAll('#journal article').length===1")
        host=page.locator('#journal')
        assert host.get_by_role('button',name='RPCで状況を再照合').count()==1
        assert '観測日時（保存値）' in host.inner_text() and 'はい（RPCの観測）' in host.inner_text()
        assert '最新状況は再照合' in host.inner_text()
        steps.append('Previously successful cached receipt remains refreshable and displays observation time and RPC-only assurance')
        for _ in range(2):
            host.get_by_role('button',name='RPCで状況を再照合').click()
            page.wait_for_timeout(80)
        assert page.evaluate("window.__calls.filter(c=>c.route==='reconcile').length") == 2
        steps.append('Repeated refresh remains available after a reported success')
        page.evaluate("window.__mode='missing'")
        host.get_by_role('button',name='RPCで状況を再照合').click()
        page.wait_for_function("document.getElementById('journal').textContent.includes('receipt-missing-after-observed-reorg')")
        assert 'reported-confirmed' not in host.inner_text() and '未確認' in host.inner_text()
        assert 'なし／不明' in host.inner_text() and '以前と異なるブロック' in host.inner_text()
        steps.append('Missing/reorg observation removes cached success, delivery and confirmation badges')
        page.evaluate("window.__mode='success'")
        host.get_by_role('button',name='RPCで状況を再照合').click()
        page.wait_for_function("document.getElementById('journal').textContent.includes('reported-confirmed')")
        page.evaluate("window.__mode='error'")
        host.get_by_role('button',name='RPCで状況を再照合').click()
        page.wait_for_function("document.getElementById('message').textContent.includes('RPC_DISAGREEMENT')")
        assert 'reconciliation-unavailable' in host.inner_text() and 'reported-confirmed' not in host.inner_text()
        steps.append('RPC error reloads durable journal in finally, clearing stale success even though the operation throws')
        assert not page.evaluate("window.__calls.some(c=>['broadcast','approve','transfers/prepare'].includes(c.route))")
        steps.append('No observation or error triggers a send, signature request or transaction preparation')
        page.evaluate("window.__mode='missing'")
        host.get_by_role('button',name='RPCで状況を再照合').click()
        page.wait_for_function("document.getElementById('journal').textContent.includes('receipt-missing-after-observed-reorg')")
        journal_section=host.locator('xpath=..')
        journal_section.evaluate("(el,text)=>{const p=document.createElement('p');p.className='notice';p.textContent=text;el.prepend(p);}",banner)
        page.screenshot(path=str(out/'settlement-desktop.png'),full_page=True)
        journal_section.screenshot(path=str(out/'settlement-panel.png'))
        page.set_viewport_size({'width':390,'height':844});page.wait_for_timeout(150)
        assert page.evaluate('document.documentElement.scrollWidth<=window.innerWidth')
        page.screenshot(path=str(out/'settlement-mobile.png'),full_page=True)
        steps.append('Desktop and 390px mobile render without horizontal overflow')
        page.evaluate("window.__mode='delay'")
        host.get_by_role('button',name='RPCで状況を再照合').click()
        page.wait_for_function("typeof window.__release==='function'")
        page.locator('#lock').click();page.wait_for_function("!document.getElementById('access').hidden")
        page.evaluate('window.__release()');page.wait_for_timeout(150)
        assert page.locator('#journal article').count()==0
        steps.append('Lock during an in-flight recheck clears the journal and late data cannot restore it')
        assert not errors, errors
        result={'mode':'offline-dom-synthetic-api','stepsPassed':len(steps),'steps':steps,'pageErrors':errors,'browser':browser.version,
                'realHttpIntegration':False,'realCryptographyInBrowserTest':False,'cspCorsIntegration':False,'liveChain':False}
        (out/'settlement-browser-results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        browser.close()
        return result
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',required=True,type=Path)
    print(json.dumps(run(parser.parse_args().output),ensure_ascii=False,indent=2))
