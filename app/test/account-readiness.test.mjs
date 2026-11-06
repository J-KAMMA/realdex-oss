import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ACCOUNT_RUNTIME_GATES,acceptancePassed} from '../lib/acceptance.mjs';
test('Native Stellar and Aptos runtime gates cannot be inferred from synthetic HTTP tests',()=>{
 assert.deepEqual(ACCOUNT_RUNTIME_GATES,['stellar-core-runtime','aptos-local-runtime']);
 assert.equal(acceptancePassed([{name:'wallet-tests',status:'passed'}],['wallet-tests',...ACCOUNT_RUNTIME_GATES]),false);
});
test('Blocked real account runtimes keep full chain acceptance false',()=>{
 const gates=[{name:'wallet-tests',status:'passed'},...ACCOUNT_RUNTIME_GATES.map(name=>({name,status:'blocked'}))];
 assert.equal(acceptancePassed(gates,['wallet-tests',...ACCOUNT_RUNTIME_GATES]),false);
});
test('Full verifier derives Stellar block reason from immutable Quickstart preflight and runs explicitly pinned Aptos integration',()=>{
 const code=fs.readFileSync(new URL('../verify.mjs',import.meta.url),'utf8');
 assert.ok(code.includes('stellarQuickstartStatus'));
 assert.ok(code.includes("blocked('stellar-core-runtime',stellarTool.reason"));
 assert.ok(!code.includes('REAL_STELLAR_CORE_INTEGRATION_NOT_IMPLEMENTED'));
 assert.ok(code.includes("run('aptos-local-runtime'"));
 assert.ok(code.includes('fullLocalAcceptancePassed:full&&acceptancePassed(gates,[...localNames,...ROOT_GATES,...ACCOUNT_RUNTIME_GATES,'));
});
