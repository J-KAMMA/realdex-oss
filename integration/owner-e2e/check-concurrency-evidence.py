#!/usr/bin/env python3
"""Independent fixed-scenario verifier. Self-hashes are not signatures or a chain-state proof."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

MODES=['double-click','lock-approval','lock-submit','lock-response','disconnect-approval']
CHECKS={
 'double-click':['owner-ready','approval-held','eight-approvals-busy','one-signature-saved','old-approval-rejected','submission-start-persisted','eight-submits-busy','concurrent-reconcile-busy','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting'],
 'lock-approval':['owner-ready','approval-held','emergency-lock-returned','approval-stopped','no-signature-or-send','unlock-restores-no-record','old-approval-rejected','final-accounting'],
 'lock-submit':['owner-ready','one-signature-saved','submission-recheck-held','emergency-lock-returned','submission-stopped','signed-record-preserved','fresh-explicit-submit','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting'],
 'lock-response':['owner-ready','one-signature-saved','accepted-response-held','one-transaction-included','emergency-lock-returned','response-not-saved','same-home-graceful-restart','old-token-rejected','unknown-record-preserved','resubmit-rejected','receipt-saved','terminal-idempotent','final-accounting'],
 'disconnect-approval':['owner-ready','approval-held','client-disconnected','approval-completed-on-server','one-signature-saved','old-approval-rejected','fresh-explicit-submit','one-transaction-included','receipt-saved','terminal-idempotent','final-accounting']}
FLAGS=['publicNetwork','productionReady','wholeProductAcceptance','browserEndToEndPassed','checkpointCompatibilityVerified','powerLossTested','stateProofVerified','productSuccessor']
FEE=500000000000000
AMOUNT=250000000000000000
NAMES={'source-before.json','source-after.json','result.json','steps.ndjson'}

def need(ok, code='E2E_CONCURRENCY_INDEPENDENT_REJECTED'):
    if not ok:
        raise ValueError(code)

def unique(pairs):
    result={}
    for k,v in pairs:
        need(k not in result)
        result[k]=v
    return result

def decode(data):
    def bad(_):
        raise ValueError('E2E_CONCURRENCY_NONFINITE')
    return json.loads(data.decode('utf8'),object_pairs_hook=unique,parse_constant=bad)

def integer(n, expected):
    need(type(n) is int and n==expected)

def number(s):
    need(type(s) is str and re.fullmatch(r'(0|[1-9][0-9]{0,77})',s))
    return int(s)

def hash64(s, upper=False):
    need(type(s) is str and re.fullmatch('[A-F0-9]{64}' if upper else '[a-f0-9]{64}',s))

def keys(v, names):
    need(type(v) is dict and set(v)==set(names))

def rejects(v,count,code):
    need(type(v) is list and len(v)==count)
    for r in v:
        keys(r,['status','error']);integer(r['status'],400);need(r['error']==code)

def check_result(r,commit,tree):
    need(re.fullmatch('[a-f0-9]{40}',commit) and re.fullmatch('[a-f0-9]{40}',tree))
    need(set(r).issubset(set(['schema','mode','commit','tree','status','sourceStable','referenceProduct','cases','ownerSubmissions','forcedCrashes','checkCount','syntheticResponses','externalRequests','chainVersion','genesisSha256','createdAt','durationMs','sourceDigest','trackedFiles','nodeVersion'])|set(FLAGS)))
    need(r['commit']==commit and r['tree']==tree and r['schema']=='realdex.owner-concurrency-e2e.v1' and r['status']=='passed' and r['mode']=='api-concurrency' and r['sourceStable'] is True and r['referenceProduct']=='INJ12')
    for k in FLAGS:need(r[k] is False)
    for k,v in [('ownerSubmissions',4),('forcedCrashes',0),('checkCount',55),('syntheticResponses',0),('externalRequests',0)]:integer(r[k],v)
    need(type(r['cases']) is list and len(r['cases'])==5)
    seen=set()
    for c,mode in zip(r['cases'],MODES):
        keys(c,['mode','checks','before','after','feeAtomic','amountAtomic','ownerSends','records','hash','signedSha256','restoredSignedSha256','finalState','reconcileWriteDelta','reconcileQueryDelta','details'])
        need(c['mode']==mode and c['checks']==CHECKS[mode] and c['feeAtomic']==str(FEE) and c['amountAtomic']==str(AMOUNT))
        n=0 if mode=='lock-approval' else 1
        integer(c['ownerSends'],n);integer(c['records'],n)
        b,a=c['before'],c['after']
        for s in [b,a]:
            keys(s,['base','gas','sequence','exchangeBase'])
            for v in s.values():number(v)
        need(number(a['sequence'])-number(b['sequence'])==n and number(b['gas'])-number(a['gas'])==FEE*n and number(b['base'])-number(a['base'])==AMOUNT*n and number(a['exchangeBase'])-number(b['exchangeBase'])==AMOUNT*n)
        if n:
            hash64(c['hash'],True);hash64(c['signedSha256']);need(c['hash'] not in seen);seen.add(c['hash'])
            need(c['signedSha256']==c['restoredSignedSha256'] and c['finalState']=='reported-confirmed')
            integer(c['reconcileWriteDelta'],0);integer(c['reconcileQueryDelta'],0)
        else:
            for k in ['hash','signedSha256','restoredSignedSha256','finalState','reconcileWriteDelta','reconcileQueryDelta']:need(c[k] is None)
        d=c['details']
        if mode=='double-click':
            keys(d,['approvalBusy','submitBusy','reconcileBusy','approvalWrites','approvalSends','startingWrites','startingState','startingReason','startingSends','duplicateWriteDelta','duplicateQueryDelta','lateApprovalError'])
            rejects(d['approvalBusy'],8,'NON_EVM_OPERATION_BUSY');rejects(d['submitBusy'],8,'NON_EVM_OPERATION_BUSY');rejects(d['reconcileBusy'],1,'NON_EVM_OPERATION_BUSY')
            for k,v in [('approvalWrites',1),('approvalSends',0),('startingWrites',1),('startingSends',0),('duplicateWriteDelta',0),('duplicateQueryDelta',0)]:integer(d[k],v)
            need(d['startingState']=='broadcast-unknown' and d['startingReason']=='SUBMISSION_STARTING' and d['lateApprovalError']=='NON_EVM_REQUEST_NOT_PENDING')
        elif mode in ['lock-approval','lock-submit']:
            keys(d,['lockStatus','locked','operationError','interruptedWriteDelta','interruptedSends','ciphertextPreserved','stateAfterUnlock','oldApprovalError','explicitSendAfterUnlock'])
            integer(d['lockStatus'],200);integer(d['interruptedWriteDelta'],0);integer(d['interruptedSends'],0)
            need(d['locked'] is True and d['operationError']=='VAULT_LOCKED' and d['ciphertextPreserved'] is True)
            need(d['stateAfterUnlock']==('signed' if n else None) and d['oldApprovalError']==(None if n else 'NON_EVM_REQUEST_NOT_PENDING') and d['explicitSendAfterUnlock'] is bool(n))
        elif mode=='lock-response':
            keys(d,['lockStatus','operationError','acceptedCode','unknownState','unknownReason','originalSends','restartedSends','oldTokenStatus','tokenChanged','pidChanged','exit','sameHome','copiedVault','resubmitError','ciphertextPreserved'])
            for k,v in [('lockStatus',200),('acceptedCode',0),('originalSends',1),('restartedSends',0),('oldTokenStatus',401)]:integer(d[k],v)
            need(d['operationError']=='VAULT_LOCKED' and d['unknownState']=='broadcast-unknown' and d['unknownReason']=='SUBMISSION_STARTING' and d['resubmitError']=='INJECTIVE_RESUBMISSION_FORBIDDEN')
            for k in ['tokenChanged','pidChanged','sameHome','ciphertextPreserved']:need(d[k] is True)
            need(d['copiedVault'] is False);keys(d['exit'],['code','signal']);integer(d['exit']['code'],0);need(d['exit']['signal'] is None)
        else:
            keys(d,['clientAborted','serverFinished','approvalWrites','approvalSends','oldApprovalError','explicitSubmit'])
            for k in ['clientAborted','serverFinished','explicitSubmit']:need(d[k] is True)
            integer(d['approvalWrites'],1);integer(d['approvalSends'],0);need(d['oldApprovalError']=='NON_EVM_REQUEST_NOT_PENDING')
    return True

def read(p,maximum=4194304):
    s=p.lstat();need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<=s.st_size<=maximum)
    return p.read_bytes()

def check(directory,commit,tree):
    p=Path(directory);need(p.is_dir() and not p.is_symlink())
    need({x.name for x in p.iterdir()}==NAMES|{'FILES.json'})
    manifest=decode(read(p/'FILES.json'));need(type(manifest) is list and len(manifest)==4);seen=set()
    for e in manifest:
        keys(e,['path','sha256']);need(e['path'] in NAMES and e['path'] not in seen);seen.add(e['path'])
        need(hashlib.sha256(read(p/e['path'])).hexdigest()==e['sha256'])
    b=decode(read(p/'source-before.json'));a=decode(read(p/'source-after.json'));need(b==a and b['commit']==commit and b['tree']==tree)
    files=b['files'];need(type(files) is list and len(files)>0);integer(b['trackedFiles'],len(files))
    need([f['path'] for f in files]==sorted({f['path'] for f in files}))
    for f in files:
        keys(f,['path','bytes','mode','sha256']);need(not Path(f['path']).is_absolute() and '..' not in Path(f['path']).parts and f['mode'] in ['100644','100755'] and type(f['bytes']) is int and f['bytes']>=0);hash64(f['sha256'])
    digest=hashlib.sha256(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode()).hexdigest();need(b['digest']==digest)
    r=decode(read(p/'result.json',262144));check_result(r,commit,tree)
    need(r['sourceDigest']==digest);integer(r['trackedFiles'],len(files));need(type(r['durationMs']) is int and r['durationMs']>=0)
    steps=[decode(x) for x in read(p/'steps.ndjson',32768).splitlines()]
    expected=[{'mode':mode,'id':k,'index':i+1} for mode in MODES for i,k in enumerate(CHECKS[mode])];need(steps==expected)
    return {'passed':True,'cases':5,'checks':len(expected),'ownerSubmissions':4,'sourceFiles':len(files),'sourceDigest':digest,'stateProofVerified':False}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--directory',required=True);p.add_argument('--expect-commit',required=True);p.add_argument('--expect-tree',required=True);a=p.parse_args()
    try:print(json.dumps(check(a.directory,a.expect_commit,a.expect_tree)))
    except Exception:
        print(json.dumps({'passed':False,'error':'E2E_CONCURRENCY_INDEPENDENT_REJECTED'}));raise SystemExit(1) from None
if __name__=='__main__':main()
