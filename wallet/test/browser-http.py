#!/usr/bin/env python3
"""Real browser -> loopback HTTP -> real wallet. No fetch stubs, CSP bypass, or funds.
An enterprise-policy block is recorded as blocked, never converted into a DOM-only pass.
"""
import argparse, json, os, re, shutil, socket, subprocess, tempfile, threading, queue, time, urllib.request, urllib.error
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]

def run(output: Path, executable: str | None = None):
    output.mkdir(parents=True, exist_ok=False)
    result = {"schema": "realdex.browser-http.v1", "status": "failed", "steps": [],
              "realHttpIntegration": False, "cspEnforced": False, "networkRPCConfigured": False,
              "transactionsSubmitted": False, "backendFetchMocked": False, "productionReady": False}
    temporary = Path(tempfile.mkdtemp(prefix='realdex-browser-http-'))
    service = None
    stage = "setup"
    try:
        try:
            from playwright.sync_api import sync_playwright, expect, Error as BrowserError
        except ImportError:
            result.update(status='blocked', reason='PLAYWRIGHT_NOT_INSTALLED'); return result
        node = shutil.which('node')
        if not node:
            result.update(status='blocked', reason='NODE_NOT_INSTALLED'); return result
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
        environment = {k: v for k, v in os.environ.items() if k in ('PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ')}
        service = subprocess.Popen([node, 'wallet/cli.mjs', 'start', '--directory', str(temporary / 'vault'), '--port', str(port)],
                                   cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        lines = queue.Queue()
        def read_stdout():
            for line in service.stdout:
                lines.put(line)
        threading.Thread(target=read_stdout, daemon=True).start()
        launch = None; deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if service.poll() is not None: raise RuntimeError('WALLET_SERVICE_EXITED')
            try: line = lines.get(timeout=.2)
            except queue.Empty: continue
            matched = re.search(r'http://127\.0\.0\.1:\d+/wallet/#key=[0-9a-f]{64}', line)
            if matched: launch = matched.group(0); break
        if not launch: raise RuntimeError('WALLET_START_TIMEOUT')
        origin = launch.split('/wallet/')[0]
        stage = 'http-headers'
        with urllib.request.urlopen(origin+'/wallet/', timeout=5) as response:
            assert response.status == 200
            assert "frame-ancestors 'none'" in response.headers['Content-Security-Policy']
            assert response.headers['Cache-Control'] == 'no-store'
        result['steps'].append('Real loopback wallet serves no-store HTML with CSP')
        with sync_playwright() as p:
            args = ['--no-sandbox'] if hasattr(os, 'geteuid') and os.geteuid() == 0 else []
            try:
                browser = p.chromium.launch(executable_path=executable, headless=True, args=args)
            except BrowserError:
                result.update(status='blocked', reason='BROWSER_NOT_AVAILABLE'); return result
            with browser:
                page = browser.new_page(viewport={'width':1280,'height':1000})
                errors=[]; page.on('pageerror', lambda error: errors.append(str(error)))
                stage = 'navigation'
                try: response=page.goto(launch, wait_until='networkidle', timeout=15000)
                except BrowserError as error:
                    result.update(status='blocked' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(error) else 'failed',
                                  reason='BROWSER_POLICY_BLOCK' if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(error) else 'BROWSER_HTTP_NAVIGATION_FAILED')
                    return result
                assert response is not None and response.status == 200
                assert "default-src 'none'" in response.headers['content-security-policy']
                # Locator assertions poll without compiling a string predicate in the CSP page.
                stage = 'module-startup'
                expect(page.locator('#existsLabel')).to_have_text('未作成', timeout=10000)
                assert '#' not in page.url
                result['steps'].append('Native module loads over HTTP; startup capability removed from URL')
                # Inline scripts must not run in this real CSP-served page.
                stage = 'csp-enforcement'
                page.evaluate("()=>{const s=document.createElement('script');s.textContent='window.__cspBypassed=true';document.head.append(s);}")
                assert page.evaluate('window.__cspBypassed === undefined')
                result['cspEnforced']=True
                result['steps'].append('CSP rejects inline script injection without bypass flags')
                stage = 'vault-password-input'
                password='ephemeral browser test password only'
                page.locator('#password').fill(password);page.locator('#passwordAgain').fill(password)
                stage = 'vault-creation'
                page.locator('#create').click()
                stage = 'vault-workspace-visible'
                page.locator('#workspace').wait_for(state='visible',timeout=20000)
                assert page.locator('#password').input_value()==''
                stage = 'account-form-open'
                page.locator('#accountForm').evaluate('(form)=>{form.closest("details").open=true;}')
                stage = 'account-input'
                page.locator('#accountLabel').fill('Ephemeral browser test');page.locator('#accountFamily').select_option('evm')
                stage = 'account-creation'
                page.locator('#accountForm button[type=submit]').click()
                expect(page.locator('#accountCount')).to_have_text('1',timeout=10000)
                addresses=page.locator('#accounts').inner_text()
                result['steps'].append('Real backend creates encrypted vault and a fresh unfunded EVM account')
                stage = 'backup-download'
                with page.expect_download() as download:
                    page.locator('#backup').click()
                backup=temporary/'backup.json';download.value.save_as(backup)
                envelope=json.loads(backup.read_text())
                assert envelope['cipher']=='aes-256-gcm' and 'secretHex' not in backup.read_text()
                stage = 'backup-verification'
                page.locator('#verifyFile').set_input_files(backup);page.locator('#verifyPassword').fill(password)
                page.locator('#verifyForm button[type=submit]').click()
                expect(page.locator('#backupState')).to_contain_text('済',timeout=20000)
                result['steps'].append('Browser downloads encrypted backup and verifies it through real backend KDF')
                stage = 'lock-and-reopen'
                page.locator('#lock').click();page.locator('#workspace').wait_for(state='hidden',timeout=10000)
                page.locator('#password').fill(password);page.locator('#unlock').click()
                page.locator('#workspace').wait_for(state='visible',timeout=20000)
                assert page.locator('#accounts').inner_text()==addresses
                result['steps'].append('Lock/reopen retains the same account and no unencrypted backup')
                stage = 'final-page-check'
                page.screenshot(path=str(output/'wallet-real-http.png'),full_page=True)
                assert not errors
                result.update(status='passed',realHttpIntegration=True,browser=browser.version)
    except Exception as error:
        # Do not persist request bodies, startup capability, passwords or arbitrary exception text.
        result.update(status='failed',reason='BROWSER_HTTP_ASSERTION_OR_SETUP_FAILED',errorType=type(error).__name__,failureStage=stage)
        # Only this harness's line number; never serialize stack text, URLs or values.
        detail = str(error)
        if 'unsafe-eval' in detail: result['failureCategory'] = 'CSP_UNSAFE_EVAL'
        elif 'strict mode violation' in detail: result['failureCategory'] = 'SELECTOR_AMBIGUOUS'
        elif 'Execution context was destroyed' in detail: result['failureCategory'] = 'CONTEXT_DESTROYED'
        elif 'Cannot read properties of null' in detail: result['failureCategory'] = 'DOM_ELEMENT_MISSING'
        else: result['failureCategory'] = 'UNCLASSIFIED'
        trace = error.__traceback__
        while trace is not None:
            if trace.tb_frame.f_code.co_filename == __file__:
                result['failureLine'] = trace.tb_lineno
            trace = trace.tb_next
    finally:
        if service is not None and service.poll() is None:
            service.terminate()
            try: service.wait(timeout=10)
            except subprocess.TimeoutExpired: service.kill();service.wait(timeout=5)
        shutil.rmtree(temporary,ignore_errors=True)
        result['stepsPassed']=len(result['steps'])
        (output/'browser-http.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    return result

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--executable',default=os.environ.get('REALDEX_BROWSER_EXECUTABLE'))
    opts=parser.parse_args();result=run(opts.output,opts.executable);print(json.dumps(result,ensure_ascii=False,indent=2))
    raise SystemExit(0 if result['status']=='passed' else 2 if result['status']=='blocked' else 1)
