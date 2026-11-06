#!/usr/bin/env python3
"""Spot observer UI checks. --offline-dom explicitly excludes HTTP/CSP coverage.
Never changes browser policy, reads a wallet, or contacts a public market.
"""
import argparse,base64,json,re,socket,subprocess,tempfile,time,urllib.request
from functools import lru_cache
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[3]
a=argparse.ArgumentParser();a.add_argument('--output',required=True);a.add_argument('--offline-dom',action='store_true');args=a.parse_args();out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
report={'scope':'offline DOM and in-page synthetic provider' if args.offline_dom else 'real local HTTP static UI with synthetic in-page provider; not full wallet/browser acceptance','browserHttp':not args.offline_dom,'checks':[],'pageErrors':[],'networkRequests':[],'passed':False}
def check(ok,name):
 if not ok:raise AssertionError(name)
 report['checks'].append(name)
@lru_cache(None)
def module_url(path):
 path=Path(path);source=path.read_text()
 def sub(m):
  dep=(path.parent/m[2]).resolve()
  if not dep.exists() and path.parent==ROOT/'node/public':dep=(ROOT/'node'/m[2]).resolve()
  return m[1]+module_url(dep)+m[3]
 source=re.sub(r"((?:from\s*|import\s*)['\"])(\.[^'\"]+)(['\"])",sub,source)
 return 'data:text/javascript;base64,'+base64.b64encode(source.encode()).decode()
exitcode=1
with tempfile.TemporaryDirectory(prefix='realdex-spot-browser-') as tmp:
 proc=None
 try:
  origin=None
  if not args.offline_dom:
   with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
   config=Path(tmp)/'node'
   subprocess.run(['node','node/cli.mjs','init','--directory',str(config),'--port',str(port)],cwd=ROOT,check=True,capture_output=True)
   proc=subprocess.Popen(['node','node/cli.mjs','start','--config',str(config/'config.json')],cwd=ROOT,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
   origin=f'http://127.0.0.1:{port}'
   for i in range(200):
    try:
     with urllib.request.urlopen(origin+'/node/spot/',timeout=.2) as r:report['staticHttpStatus']=r.status;report['csp']=r.headers.get('content-security-policy');break
    except OSError:time.sleep(.03)
  with sync_playwright() as p:
   browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
   page=browser.new_page(locale='ja-JP',viewport={'width':1360,'height':1450});page.on('pageerror',lambda e:report['pageErrors'].append(str(e)))
   page.on('request',lambda r:report['networkRequests'].append(r.url) if not r.url.startswith('data:') else None)
   if args.offline_dom:
    html=(ROOT/'node/public/spot.html').read_text();html=re.sub(r'<link[^>]+>','',html);html=re.sub(r'<script.*?</script>','',html,flags=re.S);page.set_content(html);page.add_style_tag(content=(ROOT/'node/public/spot.css').read_text())
   else:
    response=page.goto(origin+'/node/spot/',wait_until='networkidle',timeout=10000)
    check(response.status==200,'static HTTP page and modules loaded')
   page.evaluate("Date.now=()=>1788652800000; Object.defineProperty(window,'ethereum',{get(){throw Error('WALLET_ACCESS_FORBIDDEN')}});")
   if args.offline_dom:page.evaluate('(url)=>import(url)',module_url(ROOT/'node/public/spot-ui.mjs'))
   check(page.title()=='RealDEX · 外部現物板','page title')
   check(page.locator('#calculate').is_disabled(),'no estimate before observation')
   page.click('#demo');check('9.481000' in page.inner_text('#net'),'synthetic Injective two-level fee quote')
   check('架空データ' in page.inner_text('#mode'),'demo labeled synthetic')
   check('filled'==page.inner_text('#fill'),'full sell input identified')
   page.fill('#amount','10');check(not page.locator('#output').is_visible(),'input edit hides old quote')
   page.click('#calculate');check(page.inner_text('#fill')=='depth-exhausted','partial fill shown explicitly')
   check('7.500000000000000000' in page.inner_text('#remaining'),'unspent amount displayed')
   page.select_option('#side','buy-base');page.fill('#amount','11.022');page.click('#calculate');check('1.000000000000000000' in page.inner_text('#net'),'quote budget includes taker fee')
   page.fill('#limit','10');page.click('#calculate');check(page.inner_text('#fill')=='limit-reached','price bound excludes expensive asks')
   page.click('#stop');check(page.locator('#calculate').is_disabled() and not page.locator('#output').is_visible(),'stop clears observation and estimate')
   page.select_option('#provider','hypercore');page.select_option('#side','sell-base');page.fill('#limit','');page.fill('#amount','1');page.click('#demo');check('未計算' in page.inner_text('#net'),'unknown HyperCore account fee never shown as zero')
   page.fill('#network','changed');check(page.locator('#calculate').is_disabled(),'network edit invalidates observation')
   page.click('#observe');check('SPOT_CONSENT_REQUIRED' in page.inner_text('#status'),'explicit remote consent required')
   # An in-page synthetic provider tests the browser's response parsing, not actual public HTTP.
   v=json.loads((ROOT/'node/external/test/golden-protobuf.json').read_text())
   page.evaluate('''v=>{window.__fetchCount=0;window.__slow=false;window.__inputs=[];window.fetch=async(u,o)=>{window.__fetchCount++;window.__inputs.push({url:String(u),credentials:o.credentials,redirect:o.redirect});if(window.__slow)await new Promise(r=>setTimeout(r,200));const hex=String(u).endsWith('/Market')?v.marketHex:v.bookHex;const b=Uint8Array.from(hex.match(/../g).map(x=>parseInt(x,16)));const t=new TextEncoder().encode('grpc-status: 0\\r\\n');const all=new Uint8Array(5+b.length+5+t.length);new DataView(all.buffer).setUint32(1,b.length);all.set(b,5);all[5+b.length]=128;new DataView(all.buffer).setUint32(6+b.length,t.length);all.set(t,10+b.length);return new Response(all,{headers:{'content-type':'application/grpc-web+proto'}});};}''',v)
   page.select_option('#provider','injective');page.fill('#network','test');page.fill('#endpoint','https://example.com');page.fill('#market','0x'+'ab'*32);page.check('#consent');page.click('#observe');page.wait_for_function("document.getElementById('output').hidden===false")
   check(page.evaluate('window.__fetchCount')==3,'metadata-book-metadata read sequence')
   check('未認証' in page.inner_text('#mode'),'provider observation is labeled unverified')
   check(page.evaluate("window.__inputs.every(x=>x.credentials==='omit'&&x.redirect==='error')"),'no credentials and no redirects')
   page.evaluate('window.__slow=true');page.click('#observe');page.click('#stop');page.wait_for_timeout(350);check(page.locator('#calculate').is_disabled() and not page.locator('#output').is_visible(),'late response after stop cannot revive data')
   page.click('#demo');page.screenshot(path=str(out/'spot-desktop.png'),full_page=True)
   for width in [390,320]:
    page.set_viewport_size({'width':width,'height':850});check(page.evaluate('document.documentElement.scrollWidth<=innerWidth'),f'no horizontal overflow at {width}px')
    if width==390:page.screenshot(path=str(out/'spot-mobile.png'),full_page=True)
   check(not report['pageErrors'],'no browser runtime errors')
   report['passed']=True;exitcode=0;browser.close()
 except Exception as e:
  report['error']=str(e)[:1500]
  if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e):report['blockedByPolicy']=True;exitcode=2
 finally:
  if proc:proc.terminate();proc.wait(timeout=10)
  (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ['networkRequests','csp']},ensure_ascii=False,indent=2));raise SystemExit(exitcode)
