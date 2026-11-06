"""Independent UP02 result/accounting checker. Reads no keys; does not query chain or prove authenticity."""
import json,sys
from pathlib import Path
p=Path(sys.argv[1])
r=json.loads((p/'result.json').read_text())
a=json.loads((p/'source-before.json').read_text());b=json.loads((p/'source-after.json').read_text())
s=json.loads((p/'lifecycle.json').read_text());c=json.loads((p/'product-cli.json').read_text())
assert r['schema']=='realdex.up02-acceptance.v1'
assert r['configurationPassed'] is True and r['sourceStable'] is True and r['runtimeStable'] is True
assert r['commit']==a['commit']==b['commit'] and r['tree']==a['tree']==b['tree'] and a['digest']==b['digest']
assert not r['browserTested'] and not r['publicNetwork'] and not r['productionReady']
expected={
'empty-settings-before-first-review','read-only-review-and-wrong-hash-rejected','one-reviewed-ciphertext-commit',
'saved-settings-hidden-while-locked','decrypt-restores-exact-owner-configuration','same-pair-restart-does-not-rewrite-or-load-settings',
'old-owner-token-rejected','settings-digest-survives-process-restart','configuration-alone-sends-no-transaction',
'signed-operation-blocks-configuration-mutation','unknown-submission-does-not-unlock-settings','settings-and-unknown-history-recover-together',
'saved-hash-reconciled-without-resend','resolved-history-allows-separate-owner-settings-approval','configuration-does-not-delete-signed-history',
'one-deposit-one-fee-one-sequence','both-permanent-locks-and-pair-retained'}
assert s['schema']=='realdex.up02-settings-lifecycle.v1' and s['passed'] is True
assert len(s['checks'])==len(expected) and set(s['checks'])==expected
assert s['ownerSubmissions']==1 and s['restartedSubmissions']==0 and s['configurationRevisions']==[1,2]
assert int(s['before']['base'])-int(s['after']['base'])==int(s['amountAtomic'])==10**18
assert int(s['before']['gas'])-int(s['after']['gas'])==int(s['feeAtomic'])==500000000000000
assert int(s['after']['sequence'])-int(s['before']['sequence'])==1
assert int(s['finalGeneration'])>int(s['initialGeneration']) and s['sameDirectories'] and s['permanentLocksRetained']
assert s['syntheticResponses']==0 and not s['browserTested'] and not s['publicNetwork'] and not s['productionReady']
assert c['schema']=='realdex.up02-settings-cli.v1' and c['passed'] is True and c['baseline'] is False
assert len(c['checks'])==11 and len(set(c['checks']))==11 and c['actualProductEntry'] is True
assert not c['browserTested'] and not c['signerUsed'] and not c['userFunds'] and not c['productionReady']
print(json.dumps({'passed':True,'lifecycleChecks':len(expected),'productCliChecks':len(c['checks']),'independentIntegerAccounting':True,'stateProofVerified':False}))
