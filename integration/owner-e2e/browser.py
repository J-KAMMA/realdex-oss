#!/usr/bin/env python3
"""Normal managed Chromium only. Never fulfills/mock-replaces HTTP, disables policy, or logs tokens."""
import sys, json
from urllib.parse import urlsplit
from importlib.metadata import version


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


class Browser:
    def __init__(self):
        require(version('playwright') == '1.57.0', 'E2E_PLAYWRIGHT_VERSION')
        from playwright.sync_api import sync_playwright
        self.p = sync_playwright().start()
        # No alternative executable, policy edits, proxy, disabled CSP or web-security flags.
        self.browser = self.p.chromium.launch(executable_path='/usr/bin/chromium', headless=True)
        self.context = None
        self.origin = None
        self.blocked = 0
        self.errors = 0

    def open(self, c):
        u = urlsplit(c['origin'])
        require(u.scheme == 'http' and u.hostname == '127.0.0.1' and u.port and
                not u.path and not u.query and not u.fragment and not u.username,
                'E2E_LOCAL_ORIGIN')
        require(isinstance(c['token'], str) and len(c['token']) == 64, 'E2E_CAPABILITY')
        if self.context:
            self.context.close()
        self.origin = c['origin']
        self.context = self.browser.new_context(viewport={'width': 1280, 'height': 1000}, service_workers='block')
        def route(r):
            url = urlsplit(r.request.url)
            if f'{url.scheme}://{url.netloc}' == self.origin:
                r.continue_()
            else:
                self.blocked += 1
                r.abort()
        self.context.route('**/*', route)
        self.page = self.context.new_page()
        self.page.set_default_timeout(20000)
        self.page.on('pageerror', lambda _e: setattr(self, 'errors', self.errors + 1))
        try:
            self.page.goto(self.origin + '/wallet/#key=' + c['token'], wait_until='networkidle')
        except Exception as e:
            if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e):
                raise RuntimeError('E2E_BROWSER_POLICY_BLOCK') from None
            raise RuntimeError('E2E_BROWSER_NAVIGATION') from None
        self.page.wait_for_function("document.getElementById('injectiveActionAccount').options.length===1")
        require(self.page.evaluate('location.hash') == '', 'E2E_CAPABILITY_NOT_CLEARED')
        require(self.blocked == 0 and self.errors == 0, 'E2E_BROWSER_UNEXPECTED_IO')
        return {'transport': 'chromium-dom-http', 'externalRequests': self.blocked, 'syntheticResponses': 0}

    def response(self, path, action):
        with self.page.expect_response(lambda r: r.url == self.origin + '/api/' + path and r.request.method == 'POST') as pending:
            action()
        r = pending.value
        require(self.blocked == 0 and self.errors == 0, 'E2E_BROWSER_UNEXPECTED_IO')
        return {'status': r.status, 'data': r.json()}

    def prepare(self, p):
        b, kind = p['body'], p['kind']
        if kind == 'order':
            self.page.locator('#injectiveOwnerAccount').select_option(b['accountId'])
            self.page.locator('#injectiveReviewJson').fill(json.dumps(b['review']))
            return self.response('non-evm/injective/prepare', lambda: self.page.locator('#injectiveReviewForm button[type=submit]').click())
        require(kind in ('deposit', 'withdraw', 'cancel'), 'E2E_DRIVER_ACTION')
        self.page.locator('#injectiveActionKind').select_option(kind)
        self.page.locator('#injectiveActionAccount').select_option(b['accountId'])
        payment = b['payment']
        self.page.locator('#injectiveActionKey').fill(payment['requestKey'])
        for field, key in [('injectiveActionGas', 'gasLimit'), ('injectiveActionGasPrice', 'gasPriceAtomic'), ('injectiveActionMaxFee', 'maxGasFeeAtomic')]:
            self.page.locator('#' + field).fill(payment['policy'][key])
        if kind == 'cancel':
            self.response('non-evm/history', lambda: self.page.locator('#injectiveActionRefresh').click())
            self.page.locator('#injectiveCancelSource').select_option(b['sourceRecordId'])
            self.page.locator('#injectiveCancelHash').fill(payment['orderHash'])
        else:
            for field, key in [('Endpoint', 'endpoint'), ('Subaccount', 'subaccountId'), ('Denom', 'denom'), ('Amount', 'amountAtomic')]:
                self.page.locator('#injectiveAction' + field).fill(payment[key])
        return self.response('non-evm/injective/' + kind + '/prepare', lambda: self.page.locator('#injectiveActionForm button[type=submit]').click())

    def approve(self, p):
        card = self.page.locator('#pending article[data-request="' + p['id'] + '"]')
        card.wait_for()
        require(card.locator('input[type=checkbox]').count() == 0, 'E2E_UNEXPECTED_AUTO_BROADCAST')
        # Values expected by the independent orchestrator must be visible before confirmation.
        rendered = card.inner_text()
        for value in p['visible']:
            require(value in rendered, 'E2E_REVIEW_DISPLAY_MISMATCH')
        card.get_by_label('preflight SHA-256を全文再入力').fill(p['confirmation'])
        return self.response('non-evm/approve', lambda: card.get_by_role('button', name='この非EVM操作だけ承認', exact=True).click())

    def record_card(self, p):
        card = self.page.locator('#nonEvmJournal article').filter(has_text=p['requestKey'])
        card.wait_for()
        require(card.count() == 1, 'E2E_HISTORY_AMBIGUOUS')
        return card

    def submit(self, p):
        card = self.record_card(p)
        card.get_by_label('初回送信するtx hashを全文再入力').fill(p['confirmation'])
        return self.response('non-evm/injective/submit', lambda: card.get_by_role('button', name='保存済みInjective署名を初めて送信', exact=True).click())

    def reconcile(self, p):
        card = self.record_card(p)
        return self.response('non-evm/injective/reconcile', lambda: card.get_by_role('button', name='Injectiveの収録状態を再照合', exact=True).click())

    def close(self):
        try:
            if self.context:
                self.context.close()
            self.browser.close()
        finally:
            self.p.stop()


def main():
    browser = None
    try:
        for raw in sys.stdin:
            require(len(raw) <= 262144, 'E2E_CHILD_INPUT_LIMIT')
            msg = json.loads(raw)
            ident = msg.get('id')
            try:
                require(set(msg) == {'id', 'action', 'payload'} and isinstance(ident, int) and ident > 0, 'E2E_CHILD_FRAME')
                action = msg['action']
                require(action in ('open', 'prepare', 'approve', 'submit', 'reconcile'), 'E2E_DRIVER_ACTION')
                if browser is None:
                    require(action == 'open', 'E2E_CHILD_NOT_OPEN')
                    browser = Browser()
                result = getattr(browser, action)(msg['payload'])
                print(json.dumps({'id': ident, 'ok': True, 'data': result}), flush=True)
            except Exception as e:
                code = str(e) if isinstance(e, RuntimeError) and str(e).startswith('E2E_') and len(str(e)) < 80 else 'E2E_BROWSER_FAILED'
                print(json.dumps({'id': ident, 'ok': False, 'error': code}), flush=True)
                return 1
    finally:
        if browser:
            browser.close()
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception:
        # No raw traceback: Playwright errors can contain the capability-bearing navigation URL.
        sys.exit(1)
