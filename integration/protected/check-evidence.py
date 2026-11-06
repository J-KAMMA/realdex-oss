"""Independent arithmetic/record checks of UP01 local scenario evidence, not chain attestation."""
import argparse,hashlib,json,re
from pathlib import Path

def need(v,c):
    if not v:raise ValueError(c)
def uint(s):
    need(isinstance(s,str) and re.fullmatch(r'0|[1-9][0-9]{0,77}',s),'UINT');return int(s)
def verify(r):
    need(r['schema']=='realdex.protected-integration.v1','SCHEMA')
    need(r['apiPassed'] is True and r['productionReady'] is False and r['legacyInj13Compatible'] is False,'APPROVAL')
    need(r['sourceStable'] is True and r['runtimeStable'] is True,'STABILITY')
    t=r['roundtrip'];need(t['status']=='passed' and t['mode']=='api' and len(t['transactions'])==5,'ROUNDTRIP')
    need(t['driver']=={'transport':'direct-http','externalRequests':0,'syntheticResponses':0},'DRIVER')
    need(t['protectedStorage']['samePairAfterRestart'] is True and t['protectedStorage']['scheme']=='realdex.vault-checkpoint-lease.v1','PAIR')
    before,after=t['before'],t['after']
    need(uint(after['sequence'])-uint(before['sequence'])==5,'SEQUENCE')
    need(uint(before['gas'])-uint(after['gas'])==sum(uint(x['feeAtomic']) for x in t['transactions']),'FEES')
    need(uint(before['base'])-uint(after['base'])==500000000000000000,'BASE')
    need(after['exchangeBase']=='0' and after['exchangeQuote']=='0' and after['openOrders']==0,'EXCHANGE')
    need(t['ownerSends']==5 and t['walletRestarts']==1 and len({x['hash'] for x in t['transactions']})==5,'SENDS')
    # Use exact rational rate, not float, for the total quote outcome.
    rate=t['makerFeeRate'];neg=rate.startswith('-');whole,_,frac=rate.lstrip('-').partition('.')
    den=10**len(frac);num=(int(whole)*den+int(frac or '0'))*(-1 if neg else 1)
    n=uint(t['quoteNotionalAtomic']);need(n*num%den==0,'FRACTIONAL_FEE')
    need(uint(after['quote'])-uint(before['quote'])==n-n*num//den,'QUOTE')
    recovery=r['recovery'];need(recovery['status']=='passed' and recovery['ownerSubmissions']==1 and recovery['restartedSubmissions']==0,'RECOVERY')
    cases=recovery['cases'];need([x['mode'] for x in cases]==['before-request','after-inclusion','save-intent'],'CASE_SET')
    for c in cases:
        included=c['mode']=='after-inclusion';b,a=c['before'],c['after']
        need(c['sameDirectory'] is True and c['permanentLocksRetained'] is True and
             c['checkpointReset'] is False and c['vaultCopiedToDifferentDirectory'] is False,'SAME_DIRECTORY')
        need(c['ownerSubmissions']==int(included) and c['restartedSubmissions']==0,'RESTART_SEND')
        need(uint(a['sequence'])-uint(b['sequence'])==int(included),'RECOVERY_SEQUENCE')
        need(uint(b['base'])-uint(a['base'])==(uint(c['amountAtomic']) if included else 0),'RECOVERY_BASE')
        need(uint(b['gas'])-uint(a['gas'])==(uint(c['feeAtomic']) if included else 0),'RECOVERY_FEE')
        need(c['finalState']==('reported-confirmed' if included else 'broadcast-unknown'),'RECOVERY_STATE')
        if included:
            need(c['restore']=={'tested':True,'oldRejected':True,'currentCiphertextMatched':True,
                 'checkpointUnchanged':True,'signaturesPreserved':True,'transmissions':0},'RESTORE')
        if c['mode']=='save-intent':need(c['storageRecoveryPerformed'] is True,'INTENT_RECOVERY')
    need(recovery['jointRollbackDetected'] is False and recovery['powerLossTested'] is False,'LIMITS')
    need(r['browserPassed']==cases[1]['browser']['passed'],'BROWSER_SCOPE')
    need(cases[1]['browser']['syntheticResponses']==0 and cases[1]['browser']['policyChanged'] is False,'BROWSER_POLICY')
    return {'passed':True,'roundtripChecks':len(t['checks']),'recoveryChecks':sum(len(x['checks']) for x in cases),'independentChainProof':False}

def main():
    p=argparse.ArgumentParser();p.add_argument('--directory',required=True);a=p.parse_args();d=Path(a.directory)
    try:
        manifest=json.loads((d/'FILES.json').read_text())
        for item in manifest:
            name=item['path'];need('/' not in name and '..' not in name and (d/name).is_file() and not (d/name).is_symlink(),'PATH')
            need(hashlib.sha256((d/name).read_bytes()).hexdigest()==item['sha256'],'HASH')
        r=json.loads((d/'result.json').read_text());report=verify(r)
        before=json.loads((d/'source-before.json').read_text());after=json.loads((d/'source-after.json').read_text())
        need(before['commit']==after['commit']==r['commit'] and before['tree']==after['tree']==r['tree'],'SOURCE')
        need(before['digest']==after['digest']==r['sourceDigest'],'SOURCE_DIGEST')
        print(json.dumps(report))
    except Exception as e:
        print(json.dumps({'passed':False,'error':str(e) if isinstance(e,ValueError) else type(e).__name__}))
        raise SystemExit(1)
if __name__=='__main__':main()
