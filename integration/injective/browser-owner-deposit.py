#!/usr/bin/env python3
"""Actual Chromium -> WalletServer -> pinned Injective node. No synthetic fetch or key import.
Ephemeral UI capability enters via stdin, stays in memory, and is never logged.
"""
import json,sys,time,urllib.request,urllib.error,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright

def run(c):
    origin=c['origin'];rest=c['rest'];steps=[];receipts=[];errors=[];blocked=[]
    def read(route):
        with urllib.request.urlopen(rest+route,timeout=5) as response:return json.load(response)
    def sequence():return read('/cosmos/auth/v1beta1/accounts/'+c['address'])['account']['base_account']['sequence']
    def balance(denom):return read('/cosmos/bank/v1beta1/spendable_balances/'+c['address']+'/by_denom?denom='+denom)['balance']['amount']
    initial_base=int(balance('ubase'));initial_gas=int(balance('inj'));start_sequence=sequence()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
        context=browser.new_context(viewport={'width':1280,'height':1000})
        def allow(route):
            if route.request.url.startswith(origin+'/'):route.continue_()
            else:blocked.append('external-request-blocked');route.abort()
        context.route('**/*',allow)
        page=context.new_page();page.set_default_timeout(15000);page.on('pageerror',lambda e:errors.append(str(e)))
        page.goto(origin+'/wallet/#key='+c['token'],wait_until='networkidle')
        page.wait_for_function("document.getElementById('injectiveActionAccount').options.length===1")
        assert page.evaluate('location.hash')==''
        steps.append('Actual wallet page loads over HTTP and removes the UI capability from the URL')
        amount='9007199254740993'
        for kind in ['deposit','withdraw']:
            before=sequence();key='browser-'+kind+'-inj08'
            page.locator('#injectiveActionKind').select_option(kind)
            page.locator('#injectiveActionKey').fill(key)
            page.locator('#injectiveActionEndpoint').fill(rest)
            page.locator('#injectiveActionSubaccount').fill(c['subaccountId'])
            page.locator('#injectiveActionDenom').fill('ubase');page.locator('#injectiveActionAmount').fill(amount)
            with page.expect_response(lambda r:r.url==origin+'/api/non-evm/injective/'+kind+'/prepare') as response:
                page.locator('#injectiveActionForm button[type=submit]').click()
            r=response.value;data=r.json();assert r.ok,data.get('error');summary=data['summary']
            assert summary['action']==kind and summary['amountAtomic']==amount
            assert summary['destination']==(c['subaccountId'] if kind=='deposit' else c['address'])
            page.wait_for_selector('#pending input');assert page.locator('#pending input[type=checkbox]').count()==0
            assert page.locator('#pending h3').inner_text().find('入金' if kind=='deposit' else '出金')>=0
            assert sequence()==before
            steps.append(kind+': actual node preflight fixes exact amount/destination; no signature or chain mutation')
            page.locator('#pending input').fill(summary['reviewSha256'])
            with page.expect_response(lambda r:r.url==origin+'/api/non-evm/approve') as response:
                page.get_by_role('button',name='この非EVM操作だけ承認').click()
            r=response.value;data=r.json();assert r.ok,data.get('error');record=data['record'];tx=record['signed']['requestId']
            assert record['state']=='signed' and sequence()==before
            card=page.locator('#nonEvmJournal article').filter(has_text=key);card.wait_for()
            steps.append(kind+': UI confirmation creates signed durable record without changing sequence')
            field=card.get_by_label('初回送信するtx hashを全文再入力');field.fill('wrong')
            with page.expect_response(lambda r:r.url==origin+'/api/non-evm/injective/submit') as response:
                card.get_by_role('button',name='保存済みInjective署名を初めて送信').click()
            assert not response.value.ok and sequence()==before
            steps.append(kind+': wrong tx hash rejected before broadcast')
            field.fill(tx)
            with page.expect_response(lambda r:r.url==origin+'/api/non-evm/injective/submit') as response:
                card.get_by_role('button',name='保存済みInjective署名を初めて送信').click()
            r=response.value;assert r.ok,r.json();assert r.json()['state']=='broadcast'
            receipt=None;deadline=time.monotonic()+15
            while time.monotonic()<deadline:
                try:
                    receipt=read('/cosmos/tx/v1beta1/txs/'+tx)['tx_response']
                    if int(receipt['height'])>0:break
                except urllib.error.HTTPError:pass
                time.sleep(.15)
            assert receipt and int(receipt['code'])==0
            with page.expect_response(lambda r:r.url==origin+'/api/non-evm/injective/reconcile') as response:
                card.get_by_role('button',name='Injectiveの収録状態を再照合').click()
            data=response.value.json();assert response.value.ok and data['state']=='reported-confirmed'
            assert data['report']['actionEffect']['kind']==kind and data['report']['actionEffect']['independentProof'] is False
            page.wait_for_function("document.getElementById('nonEvmJournal').textContent.includes('reported-confirmed')")
            assert card.get_by_role('button',name='保存済みInjective署名を初めて送信').count()==0
            assert int(sequence())==int(before)+1
            steps.append(kind+': actual included transaction, typed post-state, no resend control')
            receipts.append({'kind':kind,'hash':tx,'height':receipt['height'],'code':receipt['code'],'feeAtomic':summary['feeAtomic']})
        assert int(balance('ubase'))==initial_base
        assert int(balance('inj'))==initial_gas-sum(int(r['feeAtomic']) for r in receipts)
        assert int(sequence())==int(start_sequence)+2
        steps.append('Independent node reads: deposit/withdraw round trip restores base balance; exactly two fees and sequences')
        for width in [390,768,1280]:
            page.set_viewport_size({'width':width,'height':1000})
            assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        steps.append('Actual HTTP UI has no horizontal overflow at 390/768/1280px')
        if c.get('screenshot'):
            page.locator('#nonEvmJournal').screenshot(path=c['screenshot'])
        assert not errors and not blocked,{'pageErrors':errors,'blockedRequests':blocked}
        context.close();browser.close()
    return {'schema':'realdex.inj08-browser-real-node.v1','passed':True,'mode':'actual-browser-wallet-server-local-node','stepsPassed':len(steps),'steps':steps,'transactions':receipts,'publicNetwork':False,'productionReady':False,'pageErrors':errors,'externalRequests':len(blocked)}
if __name__=='__main__':
    config=json.load(sys.stdin)
    try:print(json.dumps(run(config),ensure_ascii=False))
    except Exception:
        # Browser navigation errors may contain the one-use URL capability. Never log it.
        print(traceback.format_exc().replace(config.get('token',''), '[REDACTED_EPHEMERAL_UI_CAPABILITY]'),file=sys.stderr)
        raise SystemExit(1)
