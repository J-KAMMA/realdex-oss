#!/usr/bin/env node
/** Disposable local demo; never reads user wallet directories or broadcasts publicly. */
import assert from 'node:assert/strict';
import {startSimd,simdWalletFixture,waitFor} from './fixture.mjs';
import {decodeAuthz} from '../../wallet/test/cosmos-authz-wire.mjs';
import {PASSWORD} from '../../wallet/test/fixtures.mjs';
let chain,f;
try {
  chain=await startSimd();
  f=await simdWalletFixture(chain,{}, {decodeSimulation:raw=>decodeAuthz(raw,chain.chainId,async a=>(await chain.account(a)).account_number,{simulation:true})});
  const helper=await f.vault.addAccount({family:'cosmos',label:'PUBLIC TEST DELEGATE',secretHex:Buffer.alloc(32,chain.nextKey()).toString('hex')});
  const b=await f.vault.backup();await f.vault.verifyBackup(b.encrypted,PASSWORD);
  const status=()=>f.call('non-evm/cosmos-authz/status',{networkId:f.network.id,granter:f.account.address,grantee:helper.address});
  async function operation(action,terms) {
    const p=await f.call('non-evm/cosmos-authz/prepare',{accountId:action==='execute'?helper.id:f.account.id,networkId:f.network.id,payment:{action,requestKey:action,feeAtomic:'800',gasLimit:'400000',...terms}});
    const {record:r}=await f.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true});
    return waitFor(async()=>{const v=await f.call('non-evm/cosmos-authz/reconcile',{id:r.id});return v.state==='reported-confirmed'?v:false;},18000);
  }
  await operation('grant',{grantee:helper.address,recipient:chain.to,limitAtomic:'3000000',expirationSeconds:String(Math.floor(Date.now()/1000)+3600)});
  const before={granter:await chain.balance(f.account.address),grantee:await chain.balance(helper.address),recipient:await chain.balance(chain.to)};
  const allowanceBefore=(await status()).grant.remainingAtomic;
  await operation('execute',{granter:f.account.address,recipient:chain.to,amountAtomic:'1000000'});
  const allowanceAfter=(await status()).grant.remainingAtomic;
  const changes={granter:String((await chain.balance(f.account.address))-before.granter),grantee:String((await chain.balance(helper.address))-before.grantee),recipient:String((await chain.balance(chain.to))-before.recipient)};
  assert.deepEqual(changes,{granter:'-1000000',grantee:'-800',recipient:'1000000'});
  await operation('revoke',{grantee:helper.address});assert.equal((await status()).grant,null);
  console.log(JSON.stringify({status:'passed',network:'disposable single local simd validator',allowanceBefore,allowanceAfter,balanceChangesForExecution:changes,revocationObserved:true,submissions:f.state.sent,privateKeysExported:false,finalityProven:false,productionReady:false},null,2));
}finally{await f?.close();await chain?.close();}
