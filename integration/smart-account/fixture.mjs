/** Disposable local EVM + wallet fixture. Never use these generated keys with assets. */
import assert from 'node:assert/strict';
import {fixture,PASSWORD,RECIPIENT} from '../anvil/fixture.mjs';
import {createMarket} from '../amm/market.mjs';
import {deploy,receipt} from '../amm/abi.mjs';
import {compileSmart} from './compile.mjs';
import {signEvmTransaction} from '../../wallet/lib/transactions.mjs';
export const {build,artifact}=compileSmart();
export const SECOND='0x4545454545454545454545454545454545454545';
export const SALT='0x'+'19'.repeat(32);
export const until=(seconds=300)=>String(Math.floor(Date.now()/1000)+seconds);
export const eth=atomic=>'0.'+String(atomic).padStart(18,'0');
export async function setup({deployed=true,funded=true}={}){
  const f=await fixture({setupContracts:async(chain,owner)=>{
    const m=await createMarket(chain,owner,build);return {...m,smartFactory:await deploy(chain,build,'contracts/smart/RealDexSmartAccountFactory.sol','RealDexSmartAccountFactory')};
  }});
  try {
    const d=await f.owner('smart/register/prepare',{ownerAccountId:f.account.id,chainId:'31337',factory:f.market.smartFactory,salt:SALT,label:'Disposable smart account'});
    await f.owner('smart/register/commit',{draftId:d.draftId,digest:d.digest,confirm:d.confirmation});f.smart=d.descriptor;
    f.backup=async()=>{const b=await f.vault.backup();await f.vault.verifyBackup(b.encrypted,PASSWORD);return b;};await f.backup();
    f.prepare=op=>f.owner('smart/prepare',{id:f.smart.id,operation:op});
    f.approve=async(p,broadcast=true)=>f.owner('approve',{id:p.id,intentId:p.intentId,confirm:p.summary.recipient,broadcast});
    f.perform=async op=>{const p=await f.prepare(op),r=await f.approve(p);assert.equal((await f.receipt(r.result.transactionHash)).status,'0x1');return (await f.vault.journal()).find(j=>j.signed.transactionHash===r.result.transactionHash);};
    f.signOnly=async op=>{const p=await f.prepare(op);const r=await f.approve(p,false);return (await f.vault.journal()).find(j=>j.signed.transactionHash===r.result.transactionHash);};
    f.raw=async (account,to,data,value='0')=>{
      // Negative contract tests deliberately bypass UI policy using disposable test keys ONLY.
      const nonce=String(BigInt(await f.chain.call('eth_getTransactionCount',[account.address,'pending'])));
      const signed=signEvmTransaction(Buffer.from(account.secretHex,'hex'),{type:0,chainId:'31337',nonce,gasLimit:'3500000',gasPrice:'3000000000',to,value,data});
      const h=await f.chain.call('eth_sendRawTransaction',[signed.rawTransaction]);return receipt(f.chain,h);
    };
    f.sessionKey=async()=>{const a=await f.vault.addAccount({family:'evm',label:'Disposable session EOA'});await f.chain.call('anvil_setBalance',[a.address,'0x56bc75e2d63100000']);await f.backup();return f.vault.account(a.id);};
    f.grant=async(key,{asset='native',per=10,daily=15,total=20,validUntil=until(172800),recipient=RECIPIENT}={})=>f.perform({type:'grant-session',sessionAccountId:key.id,asset,recipient,perCall:asset==='native'?eth(per):String(per),daily:asset==='native'?eth(daily):String(daily),total:asset==='native'?eth(total):String(total),validUntil});
    f.sessionState=key=>f.owner('smart/inspect',{id:f.smart.id,sessionAccountId:key.id});
    if(deployed)await f.perform({type:'deploy'});
    if(deployed&&funded)await f.perform({type:'fund',amount:'1'});
    return f;
  }catch(e){await f.close();throw e;}
}
export async function withF(fn,options){const f=await setup(options);try{return await fn(f);}finally{await f.close();}}
export const owner=f=>f.vault.account(f.account.id);

