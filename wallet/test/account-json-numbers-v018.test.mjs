/** Integer-only numeric tokens at the account RPC boundary. Quoted protocol
 * decimals and uint64 fields remain strings; no test submits a transaction. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAccountJson, AccountRest} from '../non-evm/account-network.mjs';
const parse = source => parseAccountJson(Buffer.from(source, 'utf8'));
const network = {
  family:'stellar', id:'stellar:standalone', name:'Numeric boundary test',
  rpcUrls:['http://127.0.0.1:8001/', 'http://127.0.0.1:8002/'],
  checkpoint:{height:1, hash:'11'.repeat(32)}, broadcastEnabled:false,
  maxTransferAtomic:'1000000', maxFeeAtomic:'10000', minConfirmations:1,
  networkPassphrase:'Standalone Network ; February 2017',
};

test('account JSON integer tokens preserve zero and signed safe-integer endpoints', () => {
  for (const raw of ['0','1','-1','9007199254740991','-9007199254740991']) {
    const v = parse(`{"height":${raw}}`).height;
    assert.equal(typeof v, 'number');
    assert.equal(BigInt(v), BigInt(raw));
    assert.equal(Object.is(v, -0), false);
  }
});

test('account JSON rejects integer overflow on both signs before numeric coercion', () => {
  for (const raw of ['9007199254740992','9007199254740993','-9007199254740992',
    '-9007199254740993','18446744073709551615','1'.repeat(100)]) {
    assert.throws(() => parse(`{"value":${raw}}`), /ACCOUNT_RPC_JSON_INVALID/);
  }
});

test('account JSON numeric grammar deliberately rejects decimals and exponents, including exact ones', () => {
  // This is the RPC client's stricter schema, not a claim these are invalid JSON.
  for (const raw of ['1.0','0.0','1e0','1E+0','0e1','1e2','-0.0','-0e0',
    '0.99999999999999999','1.0000000000000001','-1.0000000000000001',
    '5e-324','1e-9999','-1e-9999','1e9999','0e9999']) {
    assert.throws(() => parse(`{"value":${raw}}`), /ACCOUNT_RPC_JSON_INVALID/, raw);
  }
});

test('account JSON compares original numeric lexemes in nested arrays without changing quoted fields', () => {
  const source = '{"records":[{"version":"18446744073709551615","balance":"1.2500000","fee":100},[null,true,false,-2,"1e-9999"]]}';
  assert.deepEqual(parse(source), JSON.parse(source));
  assert.throws(() => parse('{"records":[{},[null,{"sequence":1.0000000000000001}]]}'), /ACCOUNT_RPC_JSON_INVALID/);
  assert.throws(() => parse('[{"a":0},[1e-9999]]'), /ACCOUNT_RPC_JSON_INVALID/);
});

test('account JSON seeded safe-integer round trips and sub-integer perturbations never round silently', () => {
  let seed = 0x18c0ffee;
  for (let i = 0; i < 256; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const exact = (i % 2 ? -1n : 1n) * BigInt(seed);
    assert.equal(BigInt(parse(`[${exact}]`)[0]), exact);
    // The added fraction is smaller than Number's precision for these values.
    assert.throws(() => parse(`[${exact}.00000000000000001]`), /ACCOUNT_RPC_JSON_INVALID/);
  }
});

test('account REST applies exact numeric checks after multi-chunk streaming and returns no rounded body', async () => {
  for (const raw of ['{"amount":1e-9999}', '{"sequence":1.0000000000000001}']) {
    const bytes = Buffer.from(raw);
    const rest = new AccountRest({fetchImpl:async () => new Response(new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.subarray(i, i + 3));
        controller.close();
      },
    }), {headers:{'content-type':'application/json'}})});
    await assert.rejects(rest.call(network, 0, ''), {message:'ACCOUNT_RPC_JSON_INVALID'});
  }
});
