#!/usr/bin/env python3
"""Independent evidence checks, no RPC or source JS execution. Self hashes are not authentication."""
import argparse, hashlib, json, re, stat
from pathlib import Path

def need(ok, name):
    if not ok: raise ValueError(name)
def pairs(items):
    out={}
    for k,v in items:
        need(k not in out and k not in ('__proto__','constructor','prototype'),'DUPLICATE_JSON')
        out[k]=v
    return out
def parse(data): return json.loads(data,object_pairs_hook=pairs,parse_constant=lambda x: (_ for _ in ()).throw(ValueError('JSON_NUMBER')))
def integer(x):
    need(isinstance(x,str) and re.fullmatch(r'0|[1-9][0-9]{0,77}',x) is not None,'INTEGER')
    return int(x)
def sha(b): return hashlib.sha256(b).hexdigest()
def snapshot(s):
    need(type(s)==dict and set(s)=={'writes','reads','sends','locked','epoch','cipherSha256','requestsSha256','recordsSha256'},'SNAPSHOT_FIELDS')
    for k in ('writes','reads','sends','epoch'): need(type(s[k])==int and s[k]>=0,'COUNTER')
    need(type(s['locked'])==bool,'LOCK')
    for k in ('cipherSha256','requestsSha256','recordsSha256'): need(isinstance(s[k],str) and re.fullmatch('[a-f0-9]{64}',s[k]),'HASH')

A=[('missing-authorization',401,'UI_AUTH_REQUIRED'),('wrong-capability',401,'UI_AUTH_REQUIRED'),('missing-origin',400,'WALLET_ORIGIN_REQUIRED'),('foreign-origin-with-owner-capability',400,'WALLET_ORIGIN_REQUIRED'),('allowed-app-origin-with-owner-capability',400,'WALLET_ORIGIN_REQUIRED'),('null-origin',400,'WALLET_ORIGIN_REQUIRED'),('different-host',400,'HOST_NOT_ALLOWED'),('absolute-foreign-target',400,'REQUEST_URL_INVALID'),('query-token',400,'REQUEST_URL_INVALID'),('cross-site-fetch',400,'FETCH_SITE_FORBIDDEN'),('get-operation',400,'METHOD_NOT_ALLOWED'),('options-operation',400,'METHOD_NOT_ALLOWED'),('form-content-type',400,'JSON_CONTENT_TYPE_REQUIRED'),('malformed-json',400,'JSON_INVALID')]
C=[('unlisted-app-origin',400,'APP_ORIGIN_NOT_ALLOWED'),('bridge-owner-route',404,'NOT_FOUND'),('bridge-without-marker',400,'BRIDGE_HEADER_REQUIRED'),('bridge-cors-owner-header',400,'CORS_HEADERS_FORBIDDEN'),('agent-browser-origin',400,'AGENT_BROWSER_REQUEST_FORBIDDEN'),('agent-invalid-capability',401,'AGENT_UNAUTHORIZED')]
CHECKS=['static-headers-no-capability']+[f'prepare/{a[0]}' for a in A]+['valid-prepare-no-signature']+[f'approve/{a[0]}' for a in A]+['valid-approve-no-send']+[f'submit/{a[0]}' for a in A]+['cross-route/'+a[0] for a in C]+['valid-submit-once','included-deposit-exact','owner-rate-limit','rate-limited-mutation-denied','emergency-lock-at-limit','same-store-restart','old-capability-after-restart','no-resend-on-repeat','exact-fee-and-sequence']

def check(r,commit,tree):
    allowed=set('schema mode status commit tree checks checkCount rejections rate staticHeaders sourceStable runtimeStable transport syntheticResponses externalRequests before after transaction ownerSends restartSends walletRestarts oldCapabilityStatus oldCapabilityError repeatStatus repeatError chainVersion genesisSha256 createdAt durationMs sourceDigest trackedFiles nodeVersion publicNetwork productionReady stateProofVerified browserEndToEndPassed checkpointCompatibilityVerified productSuccessor wholeProductAcceptance independentAudit'.split())
    need(type(r)==dict and set(r)<=allowed,'FIELDS')
    need(r['schema']=='realdex.owner-authority-e2e.v1' and r['mode']=='api-authority' and r['status']=='passed','SCHEMA')
    need(r['commit']==commit and r['tree']==tree and re.fullmatch('[a-f0-9]{40}',commit) and re.fullmatch('[a-f0-9]{40}',tree),'IDENTITY')
    for k in ('publicNetwork','productionReady','stateProofVerified','browserEndToEndPassed','checkpointCompatibilityVerified','productSuccessor','wholeProductAcceptance','independentAudit'):need(r[k] is False,'SCOPE')
    need(r['sourceStable'] is True and r['runtimeStable'] is True and r['transport']=='direct-loopback-http' and type(r['syntheticResponses'])==int and r['syntheticResponses']==0 and type(r['externalRequests'])==int and r['externalRequests']==0,'SCOPE')
    need(r['checks']==CHECKS and type(r['checkCount'])==int and r['checkCount']==60,'CHECKS')
    expected=[(p+'/'+n,s,e) for p in ('prepare','approve','submit') for n,s,e in A]+[('cross-route/'+n,s,e) for n,s,e in C]
    need(type(r['rejections'])==list and len(r['rejections'])==48,'REJECTION_SET')
    for row,(name,status,error) in zip(r['rejections'],expected):
        need(set(row)=={'id','status','error','before','after'} and row['id']==name and type(row['status'])==int and row['status']==status and row['error']==error,'REJECTION')
        snapshot(row['before']);snapshot(row['after']);need(row['before']==row['after'],'SIDE_EFFECT')
    rt=r['rate'];need(set(rt)=={'status','error','before','after','requests','mutationStatus','mutationError','lockStatus','locked'},'RATE_FIELDS')
    need(rt['status']==429 and rt['error']=='REQUEST_RATE_LIMIT' and type(rt['requests'])==int and 0<rt['requests']<=601 and rt['mutationStatus']==429 and rt['mutationError']=='REQUEST_RATE_LIMIT' and rt['lockStatus']==200 and rt['locked'] is True,'RATE')
    snapshot(rt['before']);snapshot(rt['after']);need(rt['before']==rt['after'],'RATE_SIDE_EFFECT')
    for k,v in {'ownerSends':1,'restartSends':0,'walletRestarts':1,'oldCapabilityStatus':401,'repeatStatus':400}.items(): need(type(r[k])==int and r[k]==v,'COUNTS')
    need(r['oldCapabilityError']=='UI_AUTH_REQUIRED' and r['repeatError']=='INJECTIVE_RESUBMISSION_FORBIDDEN','RESTART')
    tx=r['transaction'];need(re.fullmatch('[A-F0-9]{64}',tx['hash']) and type(tx['code'])==int and tx['code']==0 and integer(tx['height'])>0 and tx['feeAtomic']=='500000000000000' and tx['gasLimit']==tx['gasWanted']=='1000000' and 0<integer(tx['gasUsed'])<=1000000,'TX')
    for v in (r['before'],r['after']):
        need(set(v)=={'base','gas','sequence','exchangeBase'},'STATE_FIELDS')
        for x in v.values():integer(x)
    b,a=r['before'],r['after'];need(integer(b['base'])-integer(a['base'])==10**18 and integer(a['exchangeBase'])-integer(b['exchangeBase'])==10**18 and integer(b['gas'])-integer(a['gas'])==500000000000000 and integer(a['sequence'])-integer(b['sequence'])==1,'ACCOUNTING')
    expected_headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cross-origin-opener-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"}
    need(r['staticHeaders']==expected_headers,'HEADERS')
    need(isinstance(r['chainVersion'],str) and re.fullmatch('[a-f0-9]{64}',r['genesisSha256']),'RUNTIME')
    return {'passed':True,'checks':60,'rejectedOperations':48,'ownerSends':1,'productionReady':False,'browserEndToEndPassed':False}

def directory_check(directory,commit,tree):
    root=Path(directory);need(root.resolve()==root.absolute() and root.is_dir(),'DIRECTORY')
    names={'source-before.json','source-after.json','result.json','steps.ndjson','FILES.json'}
    need({p.name for p in root.iterdir()}==names,'FILE_SET')
    raw={}
    for n in names:
        s=(root/n).lstat();need(stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode) and s.st_nlink==1 and s.st_size<=8388608,'FILE')
        raw[n]=(root/n).read_bytes();need(len(raw[n])==s.st_size,'FILE_CHANGED')
    manifest=parse(raw['FILES.json']);need(type(manifest)==list and len(manifest)==4,'MANIFEST')
    seen=set()
    for f in manifest:
        need(set(f)=={'path','sha256'} and f['path'] in names-{'FILES.json'} and f['path'] not in seen,'MANIFEST')
        seen.add(f['path']);need(sha(raw[f['path']])==f['sha256'],'FILE_HASH')
    before=parse(raw['source-before.json']);after=parse(raw['source-after.json']);r=parse(raw['result.json'])
    need(before==after and before['commit']==commit and before['tree']==tree and before['digest']==r['sourceDigest'] and before['trackedFiles']==r['trackedFiles'],'SOURCE')
    # ASCII, integer-only source inventory has the same canonical JSON form in Node/Python.
    files=before['files'];need(type(files)==list and len(files)==before['trackedFiles'],'SOURCE_FILES')
    need(sha(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode())==before['digest'],'SOURCE_DIGEST')
    steps=[parse(x) for x in raw['steps.ndjson'].splitlines() if x]
    need(steps==[{'id':s} for s in CHECKS],'STEP_SEQUENCE')
    return check(r,commit,tree)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);p.add_argument('--expect-commit',required=True);p.add_argument('--expect-tree',required=True);a=p.parse_args()
    try:print(json.dumps(directory_check(a.directory,a.expect_commit,a.expect_tree)))
    except Exception as e:print(json.dumps({'passed':False,'error':str(e) if type(e)==ValueError else 'EVIDENCE_INVALID'}));raise SystemExit(1)
