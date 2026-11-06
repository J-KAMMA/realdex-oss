#!/usr/bin/env python3
"""Independent E2E02 report/accounting and file-hash checker. Not a signature or state proof."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat
import sys

CHECKS = ['fresh-owner', 'review-bound', 'signed-no-send', 'crash-marker-bound',
          'sigkill-confirmed', 'stale-lock-preserved', 'ciphertext-copied-exactly',
          'new-process-new-token', 'old-token-rejected', 'exact-record-restored',
          'resubmit-rejected', 'unresolved-blocks-new-approval',
          'chain-outcome-matches-boundary', 'stored-hash-reconciled',
          'no-restart-send', 'exact-accounting']
NAMES = {'source-before.json', 'source-after.json', 'result.json', 'steps.ndjson'}


def need(ok):
    if not ok:
        raise ValueError('E2E_CRASH_INDEPENDENT_REJECTED')


def sha(b):
    return hashlib.sha256(b).hexdigest()


def unique(pairs):
    d = {}
    for k, v in pairs:
        need(k not in d)
        d[k] = v
    return d


def decode(b):
    def bad(_):
        raise ValueError('E2E_CRASH_NONFINITE')
    return json.loads(b.decode('utf-8'), object_pairs_hook=unique, parse_constant=bad)


def integer(s):
    need(isinstance(s, str) and re.fullmatch(r'(0|[1-9][0-9]{0,77})', s))
    return int(s)


def read(p, limit=4194304):
    s = p.lstat()
    need(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size <= limit)
    return p.read_bytes()


def check(directory, commit, tree):
    need(re.fullmatch('[a-f0-9]{40}', commit) and re.fullmatch('[a-f0-9]{40}', tree))
    d = Path(directory)
    need(d.is_dir() and not d.is_symlink())
    need({p.name for p in d.iterdir()} == NAMES | {'FILES.json'})
    manifest = decode(read(d / 'FILES.json'))
    need(isinstance(manifest, list) and len(manifest) == 4)
    seen = set()
    for entry in manifest:
        need(set(entry) == {'path', 'sha256'} and entry['path'] in NAMES and entry['path'] not in seen)
        seen.add(entry['path'])
        need(sha(read(d / entry['path'])) == entry['sha256'])
    before = decode(read(d / 'source-before.json'))
    after = decode(read(d / 'source-after.json'))
    need(before == after and before['commit'] == commit and before['tree'] == tree)
    files = before['files']
    need(len(files) == before['trackedFiles'] and len(files) > 0)
    need([f['path'] for f in files] == sorted({f['path'] for f in files}))
    for f in files:
        need(set(f) == {'path', 'bytes', 'mode', 'sha256'})
        need(not Path(f['path']).is_absolute() and '..' not in Path(f['path']).parts)
        need(type(f['bytes']) is int and f['bytes'] >= 0 and f['mode'] in ('100644', '100755'))
        need(re.fullmatch('[a-f0-9]{64}', f['sha256']))
    need(sha(json.dumps(files, separators=(',', ':'), ensure_ascii=False).encode()) == before['digest'])
    r = decode(read(d / 'result.json', 262144))
    need(r['schema'] == 'realdex.owner-crash-e2e.v1' and r['status'] == 'passed' and r['mode'] == 'api-crash')
    need(r['commit'] == commit and r['tree'] == tree and r['sourceDigest'] == before['digest'] and r['sourceStable'] is True)
    need(r['referenceProduct'] == 'INJ12')
    for k in ['publicNetwork', 'productionReady', 'wholeProductAcceptance', 'browserEndToEndPassed',
              'checkpointCompatibilityVerified', 'powerLossTested', 'stateProofVerified', 'productSuccessor']:
        need(r[k] is False)
    need(type(r['ownerSubmissions']) is int and r['ownerSubmissions'] == 1 and r['forcedCrashes'] == 2 and r['checkCount'] == 32)
    need(len(r['cases']) == 2)
    steps = [decode(line) for line in read(d / 'steps.ndjson', 32768).splitlines()]
    expected_steps = []
    hashes = set()
    for i, c in enumerate(r['cases']):
        boundary = ['before-request', 'after-inclusion'][i]
        need(c['boundary'] == boundary and c['checks'] == CHECKS)
        expected_steps.extend({'boundary': boundary, 'id': name, 'index': j + 1} for j, name in enumerate(CHECKS))
        h = c['requestHash']
        need(re.fullmatch('[A-F0-9]{64}', h) and h not in hashes)
        hashes.add(h)
        m = c['marker']
        need(m['schema'] == 'realdex.owner-crash-marker.v1' and m['boundary'] == boundary and m['requestHash'] == h)
        need(m['publicNetwork'] is False and m['productionReady'] is False)
        need(m['recordState'] == c['restoredState'] == 'broadcast-unknown')
        need(m['recordReason'] == c['restoredReason'] == 'SUBMISSION_STARTING')
        need(c['exit'] == {'code': None, 'signal': 'SIGKILL'} and c['httpResult'] == 'connection-lost')
        for k in ['staleLockRejected', 'staleLockUnchanged', 'fixtureCopyOnly', 'tokenChanged']:
            need(c[k] is True)
        need(c['sameHomeAutoRecovered'] is False and c['oldTokenStatus'] == 401)
        need(type(c['oldPid']) is int and c['oldPid'] > 0 and type(c['newPid']) is int and c['newPid'] > 0 and c['newPid'] != c['oldPid'])
        need(c['ciphertextSha256'] == c['copySha256'] == m['ciphertextSha256'] and re.fullmatch('[a-f0-9]{64}', c['ciphertextSha256']))
        need(c['signedSha256'] == c['restoredSignedSha256'] == m['signedSha256'] and re.fullmatch('[a-f0-9]{64}', c['signedSha256']))
        need(c['resubmitError'] == 'INJECTIVE_RESUBMISSION_FORBIDDEN' and c['newApprovalError'] == 'INJECTIVE_UNRESOLVED_TRANSACTION')
        need(c['records'] == 1 and type(c['transportCalls']) is int and c['transportCalls'] == m['transportCalls'] == i and c['restartedTransportCalls'] == 0)
        need(c['lookupStatus'] == (200 if i else 404) and c['finalState'] == ('reported-confirmed' if i else 'broadcast-unknown'))
        b, a = c['before'], c['after']
        need(b['sequence'] == '0' and b['exchangeBase'] == '0')
        need(c['amountAtomic'] == '1000000000000000000' and c['feeAtomic'] == '500000000000000')
        need(integer(a['sequence']) - integer(b['sequence']) == i)
        need(integer(b['gas']) - integer(a['gas']) == i * 500000000000000)
        need(integer(b['base']) - integer(a['base']) == i * 10**18)
        need(integer(b['exchangeBase']) == 0 and integer(a['exchangeBase']) == i * 10**18)
        if i:
            t = c['receipt']
            need(t == m['included'] and t['hash'] == h and type(t['code']) is int and t['code'] == 0)
            need(integer(t['height']) > 0 and t['gasWanted'] == '1000000' and 0 < integer(t['gasUsed']) <= 1000000)
        else:
            need(c['receipt'] is None and m['included'] is None)
    need(steps == expected_steps)
    return {'schema': 'realdex.owner-crash-independent.v1', 'passed': True, 'commit': commit,
            'tree': tree, 'cases': 2, 'checks': 32, 'checkpointCompatibilityVerified': False,
            'stateProofVerified': False, 'productionReady': False}


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', required=True)
    p.add_argument('--expect-commit', required=True)
    p.add_argument('--expect-tree', required=True)
    args = p.parse_args()
    try:
        print(json.dumps(check(args.directory, args.expect_commit, args.expect_tree)))
    except Exception:
        print(json.dumps({'passed': False, 'error': 'E2E_CRASH_INDEPENDENT_REJECTED'}))
        sys.exit(1)
