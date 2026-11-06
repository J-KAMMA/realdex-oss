#!/usr/bin/env python3
"""Independent structural checker for the stable smart-account candidate.

This is deliberately not a Solidity compiler and not a security audit. It does
not import the JavaScript candidate verifier, so corruption/provenance checks
have a second implementation.
"""
from __future__ import annotations
import hashlib, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[2]
CANDIDATE = ROOT / 'wallet/smart-account/stable-build-candidate.json'
EXPERIMENTAL = ROOT / 'wallet/smart-account/build.json'
EVIDENCE = ROOT / 'integration/smart-account/stable-candidate-evidence.json'
SMART = ('RealDexSmartAccount', 'RealDexSmartAccountFactory')

def fail(code: str) -> None:
    raise RuntimeError(code)
def need(ok: bool, code: str) -> None:
    if not ok: fail(code)
def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
def load(path: pathlib.Path):
    try: return json.loads(path.read_text('utf-8'))
    except Exception as exc: raise RuntimeError('SMART_STABLE_PY_JSON_INVALID') from exc

def main() -> int:
    c, x, e = load(CANDIDATE), load(EXPERIMENTAL), load(EVIDENCE)
    checks = 0
    def ck(ok: bool, code: str) -> None:
        nonlocal checks; need(ok, code); checks += 1
    ck(c.get('schema') == 'realdex.smart-account-stable-candidate.v1', 'SMART_STABLE_PY_SCHEMA')
    ck(c.get('compiler') == e.get('compiler') == '0.8.24+commit.e11b9ed9', 'SMART_STABLE_PY_COMPILER')
    ck(c.get('compilerSha256') == e.get('compilerSha256'), 'SMART_STABLE_PY_COMPILER_HASH')
    ck(c.get('buildInfoSha256') == e.get('buildInfoSha256'), 'SMART_STABLE_PY_BUILD_INFO')
    ck(c.get('inputSha256') == e.get('inputSha256'), 'SMART_STABLE_PY_INPUT')
    ck(sha(CANDIDATE.read_bytes()) == e.get('candidateSha256'), 'SMART_STABLE_PY_CANDIDATE_HASH')
    ck(c.get('stableCompilerIdentity') is True, 'SMART_STABLE_PY_STABLE_IDENTITY')
    ck(c.get('compilerExecutionReplayed') is False, 'SMART_STABLE_PY_REPLAY_FLAG')
    ck(c.get('independentReviewComplete') is False, 'SMART_STABLE_PY_REVIEW_FLAG')
    ck(c.get('productionApproved') is False, 'SMART_STABLE_PY_APPROVAL_FLAG')
    ck(e.get('compilerExecutedInImportedEvidence') is True and e.get('compilerExecutionReplayedInThisCandidate') is False, 'SMART_STABLE_PY_EVIDENCE_FLAGS')
    source_hashes = c.get('sourceHashes')
    ck(isinstance(source_hashes, dict) and len(source_hashes) == 2, 'SMART_STABLE_PY_SOURCES')
    for rel, digest in sorted(source_hashes.items()):
        p = ROOT / rel
        ck(p.is_file() and sha(p.read_bytes()) == digest, 'SMART_STABLE_PY_SOURCE_HASH')
    contracts = c.get('contracts'); old = x.get('contracts')
    ck(isinstance(contracts, dict) and set(contracts) == set(SMART), 'SMART_STABLE_PY_CONTRACT_SET')
    for name in SMART:
        a, b = contracts[name], old[name]
        ck(a.get('abi') == b.get('abi'), 'SMART_STABLE_PY_ABI')
        for field in ('creationCode', 'runtimeTemplate'):
            value = a.get(field)
            ck(isinstance(value, str) and value.startswith('0x') and len(value) > 2 and len(value[2:]) % 2 == 0, 'SMART_STABLE_PY_BYTECODE_SHAPE')
            try: bytes.fromhex(value[2:])
            except ValueError: fail('SMART_STABLE_PY_BYTECODE_HEX')
            ck(value != b.get(field), 'SMART_STABLE_PY_BYTECODE_NOT_NIGHTLY')
    account = contracts['RealDexSmartAccount']
    refs = account.get('immutableReferences')
    ck(isinstance(refs, dict) and set(refs) == {'owner', 'factory'}, 'SMART_STABLE_PY_IMMUTABLE_NAMES')
    runtime_bytes = (len(account['runtimeTemplate']) - 2) // 2
    for values in refs.values():
        ck(isinstance(values, list) and len(values) > 0, 'SMART_STABLE_PY_IMMUTABLE_LIST')
        for r in values:
            ck(isinstance(r, dict) and set(r) == {'start', 'length'} and isinstance(r['start'], int) and r['start'] >= 0 and r['length'] == 32 and r['start'] + 32 <= runtime_bytes, 'SMART_STABLE_PY_IMMUTABLE_RANGE')
    ck(contracts['RealDexSmartAccountFactory'].get('immutableReferences') == {}, 'SMART_STABLE_PY_FACTORY_IMMUTABLES')
    print(json.dumps({'schema':'realdex.smart-account-stable-candidate-python-check.v1','success':True,'checks':checks,
                      'candidateSha256':e['candidateSha256'],'compiler':c['compiler'],'compilerReplay':False,
                      'independentSecurityReview':False,'productionApproved':False}, separators=(',',':')))
    return 0
if __name__ == '__main__':
    try: raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr); raise SystemExit(1)
