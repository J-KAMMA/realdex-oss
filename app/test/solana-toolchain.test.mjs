import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {solanaToolStatus} from '../../integration/solana/toolchain.mjs';
test('Solana runtime is unavailable without explicit toolchain and never uses fake RPC fallback',()=>{assert.equal(solanaToolStatus('').available,false);});
test('Solana runtime rejects tampered archive without evaluating its contents',t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'solana-pin-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'bad.zip');fs.writeFileSync(file,'not a wheel, never execute');assert.equal(solanaToolStatus(file).reason,'SOLANA_TEST_ARCHIVE_HASH_MISMATCH');});
test('Solana runtime rejects directories and nonexistent paths',()=>{assert.equal(solanaToolStatus(os.tmpdir()).available,false);assert.equal(solanaToolStatus(path.join(os.tmpdir(),'missing-'+Date.now())).available,false);});
