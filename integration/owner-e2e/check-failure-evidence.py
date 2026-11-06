#!/usr/bin/env python3
"""Independent fixed-scenario arithmetic, evidence set and hashes. Not chain authentication."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

CHECKS = ['fresh-owner','order-included','cancel-reviewed-signed','before-send-barrier',
 'counterparty-full-fill','unchanged-owner-sequence','one-failed-submission','failure-on-real-chain',
 'restart-boundary-verified','old-session-rejected','exact-unresolved-record','resubmit-rejected',
 'unresolved-blocks-new-approval','failed-receipt-reconciled','failure-has-no-action-effect','failed-tx-costs-retained',
 'terminal-reconcile-idempotent','restart-after-failure-preserves-record','new-owner-approval','successor-included',
 'final-accounting','unique-sends']
NAMES = {'source-before.json','source-after.json','result.json','steps.ndjson'}
FLAGS = ['publicNetwork','productionReady','wholeProductAcceptance','browserEndToEndPassed',
 'checkpointCompatibilityVerified','powerLossTested','stateProofVerified','productSuccessor']

def need(ok):
    if not ok:
        raise ValueError('E2E_FAILURE_INDEPENDENT_REJECTED')

def digest(raw):
    return hashlib.sha256(raw).hexdigest()

def unique(pairs):
    out = {}
    for k,v in pairs:
        need(k not in out)
        out[k] = v
    return out

def decode(raw):
    def bad(_):
        raise ValueError('E2E_FAILURE_NONFINITE')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=unique, parse_constant=bad)

def read(p, maximum=4194304):
    s=p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and 0<=s.st_size<=maximum)
    return p.read_bytes()

def number(s):
    need(isinstance(s,str) and re.fullmatch(r'(0|[1-9][0-9]{0,77})',s))
    return int(s)

def integer(x, value):
    need(type(x) is int and x==value)

def h64(s, upper=False):
    need(isinstance(s,str) and re.fullmatch('[A-F0-9]{64}' if upper else '[a-f0-9]{64}',s))

def receipt(r, h):
    need(set(r)=={'hash','code','codespace','height','gasWanted','gasUsed'})
    need(r['hash']==h and type(r['code']) is int and r['code']==19 and r['codespace']=='exchange')
    need(number(r['height'])>0 and r['gasWanted']=='1000000' and 0<number(r['gasUsed'])<=1000000)

def check(directory, commit, tree):
    need(re.fullmatch('[a-f0-9]{40}',commit) and re.fullmatch('[a-f0-9]{40}',tree))
    p=Path(directory);need(p.is_dir() and not p.is_symlink())
    need({x.name for x in p.iterdir()} == NAMES|{'FILES.json'})
    m=decode(read(p/'FILES.json'));need(type(m) is list and len(m)==4)
    seen=set()
    for entry in m:
        need(set(entry)=={'path','sha256'} and entry['path'] in NAMES and entry['path'] not in seen)
        seen.add(entry['path']);need(digest(read(p/entry['path']))==entry['sha256'])
    b=decode(read(p/'source-before.json'));a=decode(read(p/'source-after.json'))
    need(a==b and b['commit']==commit and b['tree']==tree)
    files=b['files'];need(type(files) is list and len(files)>0 and type(b['trackedFiles']) is int and len(files)==b['trackedFiles'])
    need([f['path'] for f in files]==sorted({f['path'] for f in files}))
    for f in files:
        need(set(f)=={'path','bytes','mode','sha256'} and not Path(f['path']).is_absolute() and '..' not in Path(f['path']).parts)
        need(type(f['bytes']) is int and f['bytes']>=0 and f['mode'] in ['100644','100755']);h64(f['sha256'])
    need(digest(json.dumps(files,separators=(',',':'),ensure_ascii=False).encode())==b['digest'])
    r=decode(read(p/'result.json',262144))
    need(r['schema']=='realdex.owner-included-failure-e2e.v1' and r['mode']=='api-included-failure' and r['status']=='passed')
    need(r['commit']==commit and r['tree']==tree and r['sourceDigest']==b['digest'] and r['sourceStable'] is True and r['referenceProduct']=='INJ12')
    for k in FLAGS:need(r[k] is False)
    for k,v in [('ownerSubmissions',6),('counterpartySubmissions',2),('failedIncludedTransactions',2),('forcedCrashes',1),('checkCount',44)]:integer(r[k],v)
    need(len(r['cases'])==2);hashes=set();expected_steps=[]
    for i,c in enumerate(r['cases']):
        mode=['response','kill-before-record'][i];need(c['mode']==mode and c['checks']==CHECKS)
        expected_steps.extend({'mode':mode,'id':name,'index':j+1} for j,name in enumerate(CHECKS))
        for k in ['orderHash','failureHash','counterpartyHash','successorHash']:
            h64(c[k],True);need(c[k] not in hashes);hashes.add(c[k])
        t=c['receipt'];h=c['failureHash'];receipt(t,h)
        integer(c['checkTxCode'],0);integer(c['lookupStatus'],200)
        need(c['preRaceSequence']==c['beforeFailure']['sequence']=='1')
        need(c['failedState']=='reported-reverted' and c['failedReason']=='INCLUDED_FAILURE' and c['failureReceived'] is True and c['savedFailureCode']==t['code'] and c['savedFailureHeight']==t['height'])
        for k in ['actionEffectPresent','automaticRetry','finalityProven','retirementPresent','sameHomeAutoRecovered']:need(c[k] is False)
        integer(c['oldTokenStatus'],401);need(c['newTokenDistinct'] is True)
        need(type(c['oldPid']) is int and c['oldPid']>0 and type(c['restartedPid']) is int and c['restartedPid']>0 and c['oldPid']!=c['restartedPid'])
        need(c['restoredState']==('broadcast-unknown' if i else 'broadcast') and c['restoredReason']==('SUBMISSION_STARTING' if i else 'RPC_ACCEPTED_NOT_CONFIRMED'))
        need(c['signedSha256']==c['restoredSignedSha256']==c['finalSignedSha256']);h64(c['signedSha256'])
        need(c['unresolvedError']=='INJECTIVE_UNRESOLVED_TRANSACTION' and c['resubmitError']=='INJECTIVE_RESUBMISSION_FORBIDDEN')
        for k,v in [('firstProcessSends',2),('beforeReconcileSends',0),('afterReconcileSends',0),('successorProcessSends',1),('finalRecordCount',3),('reconcileWriteDelta',0),('reconcileQueryDelta',0)]:integer(c[k],v)
        need(c['failurePersistsAfterSecondRestart'] is True and c['successorState']=='reported-confirmed')
        need(c['feeAtomic']=='500000000000000' and c['successorAmountAtomic']=='250000000000000000')
        b,a,z=[c[k] for k in ['beforeFailure','afterFailure','afterSuccessor']]
        for s in [b,a,z]:
            need(set(s)=={'base','quote','gas','sequence','exchangeBase','openOrders'});integer(s['openOrders'],0)
            for k in ['base','quote','gas','sequence','exchangeBase']:number(s[k])
        need(b['exchangeBase']=='0' and a['base']==b['base'] and a['quote']==b['quote'] and a['exchangeBase']==b['exchangeBase'])
        need(number(a['sequence'])-number(b['sequence'])==1 and number(b['gas'])-number(a['gas'])==500000000000000)
        need(number(z['sequence'])-number(a['sequence'])==1 and number(a['gas'])-number(z['gas'])==500000000000000)
        need(number(a['base'])-number(z['base'])==250000000000000000 and z['exchangeBase']=='250000000000000000' and z['quote']==a['quote'])
        barrier=c['barrier'];need(barrier['mode']==mode and barrier['requestHash']==h and barrier['state']=='broadcast-unknown' and barrier['reason']=='SUBMISSION_STARTING' and barrier['signedSha256']==c['signedSha256']);integer(barrier['ownerSends'],1)
        if i:
            need(c['exit']=={'code':None,'signal':'SIGKILL'} and c['httpResult']=='connection-lost')
            need(c['staleLockPreserved'] is True and c['fixtureCopyOnly'] is True)
            need(c['ciphertextSha256']==c['copiedCiphertextSha256']);h64(c['ciphertextSha256'])
            marker=c['crashMarker'];need(marker['schema']=='realdex.failure-crash-marker.v1' and marker['requestHash']==h and marker['state']=='broadcast-unknown' and marker['reason']=='SUBMISSION_STARTING')
            need(marker['signedSha256']==c['signedSha256'] and marker['ciphertextSha256']==c['ciphertextSha256'] and marker['receipt']==t);integer(marker['ownerSends'],2)
        else:
            need(c['exit']=={'code':0,'signal':None} and c['httpResult']=='response-returned' and c['fixtureCopyOnly'] is False)
            for k in ['staleLockPreserved','crashMarker','ciphertextSha256','copiedCiphertextSha256']:need(c[k] is None)
    steps=[decode(line) for line in read(p/'steps.ndjson',32768).splitlines()]
    need(steps==expected_steps)
    return {'schema':'realdex.owner-included-failure-independent.v1','passed':True,'commit':commit,'tree':tree,'cases':2,'checks':44,'stateProofVerified':False,'checkpointCompatibilityVerified':False,'productionReady':False}

if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory',required=True);p.add_argument('--expect-commit',required=True);p.add_argument('--expect-tree',required=True)
    args=p.parse_args()
    try:print(json.dumps(check(args.directory,args.expect_commit,args.expect_tree)))
    except Exception:
        print(json.dumps({'passed':False,'error':'E2E_FAILURE_INDEPENDENT_REJECTED'}));sys.exit(1)
