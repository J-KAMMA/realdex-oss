import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import path from 'node:path';
test('Pinned runtime provisioner: independent Python unit/fault matrix, no network',()=>{
 const r=spawnSync('python3',['-I','dev/test_runtime_provision.py'],{cwd:path.resolve(import.meta.dirname,'../..'),encoding:'utf8',timeout:60000,shell:false,maxBuffer:1048576});
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);
 const report=JSON.parse(r.stdout);assert.equal(report.tests,38);
 assert.equal(report.failures,0);assert.equal(report.errors,0);assert.equal(report.skipped,0);
});
