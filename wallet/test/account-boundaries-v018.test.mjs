/** Structural and compatibility boundaries, independent of real consensus. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAccountJson,accountRequestTarget,AccountRest} from '../non-evm/account-network.mjs';
import {normalizeAptosRpcAddress} from '../non-evm/aptos-online.mjs';
import {normalizePublicAccount} from '../lib/keys.mjs';
import {decodeStellarPaymentResult} from '../non-evm/stellar-result.mjs';
import {accountOnlineFixture} from './account-online-fixtures.mjs';
const result=(tx=0,op=0,payment=0,extension=0)=>{
 const b=Buffer.alloc(op===0?32:24);b.writeBigInt64BE(100n);b.writeInt32BE(tx,8);b.writeInt32BE(1,12);b.writeInt32BE(op,16);
 if(op===0){b.writeInt32BE(1,20);b.writeInt32BE(payment,24);}b.writeInt32BE(extension,b.length-4);return b.toString('base64');
};
test('account JSON preserves quoted uint64 and valid Unicode without rounding',()=>{
 const value=parseAccountJson(Buffer.from('{"amount":"18446744073709551615","height":9007199254740991,"memo":"円\\ud83d\\ude80"}'));
 assert.equal(value.amount,'18446744073709551615');assert.equal(value.height,9007199254740991);assert.equal(value.memo,'円🚀');
});
test('account JSON rejects exhausted node budgets and trailing second documents',()=>{
 assert.throws(()=>parseAccountJson(Buffer.from('['+Array(20001).fill('0').join(',')+']')),/ACCOUNT_RPC_JSON_INVALID/);
 assert.throws(()=>parseAccountJson(Buffer.from('{}{}')),/ACCOUNT_RPC_JSON_INVALID/);
});
test('Stellar exact operations query allows reordering but not query widening',()=>{
 const n={family:'stellar'},p='transactions/'+'ab'.repeat(32)+'/operations';
 assert.equal(accountRequestTarget(n,p+'?include_failed=true&limit=2','GET').endpoint,p+'?include_failed=true&limit=2');
 assert.throws(()=>accountRequestTarget(n,p+'?include_failed=false&limit=2','GET'));
 assert.throws(()=>accountRequestTarget(n,'','GET',true));
});
test('Aptos exact request contract rejects auto gas estimation and out of range snapshots',()=>{
 const n={family:'aptos'};
 assert.throws(()=>accountRequestTarget(n,'transactions/simulate?estimate_gas_unit_price=true&estimate_max_gas_amount=false','POST'));
 assert.throws(()=>accountRequestTarget(n,'view?ledger_version=18446744073709551616','POST'));
 assert.equal(accountRequestTarget(n,'view?ledger_version=18446744073709551615','POST').requestedVersion,18446744073709551615n);
});
test('Aptos RPC short address normalization does not relax owner input validation',()=>{
 const full='0x'+'0'.repeat(60)+'ab12';assert.equal(normalizeAptosRpcAddress('0xAB12'),full);
 assert.equal(normalizeAptosRpcAddress(full),full);
 assert.throws(()=>normalizePublicAccount('aptos','0xab12'));
 for(const v of ['0x','ab12','0x'+'1'.repeat(65),'0xz',' 0xab12'])assert.throws(()=>normalizeAptosRpcAddress(v));
});
test('Stellar XDR recognizes exactly one successful native Payment',()=>{
 assert.deepEqual(decodeStellarPaymentResult(result(), '100',true),{feeAtomic:'100',transactionCode:0,operationCode:0,paymentCode:0,success:true});
});
test('Stellar XDR recognizes defined payment failures and generic operation failures',()=>{
 for(let p=-1;p>=-9;p--)assert.equal(decodeStellarPaymentResult(result(-1,0,p),'100',false).success,false);
 for(let op=-1;op>=-6;op--)assert.equal(decodeStellarPaymentResult(result(-1,op),'100',false).operationCode,op);
});
for(const [name,bytes,fee,success] of [
 ['mismatched success flag',result(),'100',false],
 ['failed transaction with successful operation',result(-1),'100',false],
 ['successful transaction with failed operation',result(0,0,-2),'100',true],
 ['unknown payment code',result(-1,0,-10),'100',false],
 ['unknown operation code',result(-1,-100),'100',false],
 ['fee mismatch',result(),'101',true],
 ['unsupported extension',result(0,0,0,1),'100',true],
 ['trailing bytes',Buffer.concat([Buffer.from(result(),'base64'),Buffer.alloc(4)]).toString('base64'),'100',true],
 ['truncated result',Buffer.from(result(),'base64').subarray(0,28).toString('base64'),'100',true],
 ['noncanonical base64',result()+'\n','100',true]
])test(`Stellar XDR refuses ${name}`,()=>assert.throws(()=>decodeStellarPaymentResult(bytes,fee,success),/STELLAR_RESULT_XDR_INVALID/));
test('simulation response may omit type but a committed Aptos receipt may not',async t=>{
 const f=await accountOnlineFixture('aptos');t.after(()=>f.close());
 f.state.mutate=(v,c)=>{if(c.path==='/transactions/simulate')delete v[0].type;return v;};
 const {record}=await f.approve(await f.prepare(),true);
 assert.equal((await f.reconcile(record)).report.received,true);
 f.state.mutate=(v,c)=>{if(c.path.startsWith('/transactions/by_'))delete v.type;return v;};
 const r=await f.reconcile(record);assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');
});
test('Stellar receipt cannot confirm before the reported account sequence was consumed',async t=>{
 const f=await accountOnlineFixture('stellar');t.after(()=>f.close());const {record}=await f.approve(await f.prepare(),true);
 f.state.mutate=(v,c)=>{if(c.path==='/accounts/'+f.account.address)v.sequence=String(BigInt(record.summary.transfer.sequence)-1n);return v;};
 const r=await f.reconcile(record);assert.equal(r.report.received,false);assert.equal(r.state,'broadcast-unknown');
});
test('Aptos pruned snapshot header fails closed despite a plausible historical body',async t=>{
 const f=await accountOnlineFixture('aptos');t.after(()=>f.close());
 const rest=new AccountRest({fetchImpl:async()=>new Response('{}',{headers:{'content-type':'application/json','x-aptos-chain-id':'4','x-aptos-ledger-version':'200','x-aptos-ledger-oldest-version':'101'}})});
 await assert.rejects(rest.call(f.network,0,'accounts/'+f.account.address+'?ledger_version=100'),/APTOS_RPC_SNAPSHOT_PRUNED/);
});
