import test from 'node:test';import assert from 'node:assert/strict';
import {runSettingsCli} from '../../integration/protected/settings-cli.mjs';
test('Actual protected product CLI retains approved settings and backup across process restart',async()=>{
 const r=await runSettingsCli();assert.equal(r.passed,true);assert.equal(r.checks.length,11);assert.equal(r.browserTested,false);assert.equal(r.signerUsed,false);
});
