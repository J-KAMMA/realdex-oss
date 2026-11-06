/** Standard BaseAccount + bank MsgSend only. No IBC/authz/feegrant/vesting/multisig. */
import {need,uint,canonical} from '../lib/guard.mjs';
import {decodeAccountAddress,accountAddress} from '../codec/bech32.mjs';
import {fieldBytes} from '../codec/protobuf.mjs';
import {cosmosTransaction,cosmosAddress,verifyCosmosSigned} from './cosmos-offline.mjs';
import {COSMOS_ASSURANCE,cosmosInt,cosmosHash,U64} from './cosmos-network.mjs';
import {verifyCosmosInclusion} from './cosmos-proof.mjs';
const match=(a,b,code)=>need(canonical(a)===canonical(b),code);
export class CosmosAdapter {
  constructor(rpc,now=Date.now){this.rpc=rpc;this.now=now;}
  async block(n,height){
    return this.rpc.agree(n,i=>this.rpc.comet(n,i,'block',{height:String(height)}),v=>{
      const h=v?.block?.header;need(h?.chain_id===n.chainId&&cosmosInt(h.height)===height,'COSMOS_BLOCK_IDENTITY');
      const hash=cosmosHash(v.block_id?.hash),time=Date.parse(h.time);need(Number.isSafeInteger(time),'COSMOS_BLOCK_TIME_INVALID');
      return {height,hash,time,dataHash:h.data_hash?cosmosHash(h.data_hash):'',appHash:h.app_hash?cosmosHash(h.app_hash):''};
    });
  }
  async head(n){
    const cp=await this.block(n,n.checkpoint.height);need(cp.hash===n.checkpoint.hash,'COSMOS_CHECKPOINT_MISMATCH');
    const statuses=await Promise.all(n.endpoints.map((_,i)=>this.rpc.comet(n,i,'status')));
    const heights=statuses.map(v=>{need(v?.node_info?.network===n.chainId&&v?.sync_info?.catching_up===false,'COSMOS_NODE_UNSYNCED_OR_WRONG_CHAIN');return cosmosInt(v.sync_info.latest_block_height);});
    const height=Math.min(...heights);need(height>=cp.height&&Math.max(...heights)-height<=3,'COSMOS_HEAD_SKEW');
    const b=await this.block(n,height);need(this.now()-b.time<=120000&&b.time-this.now()<=10000,'COSMOS_HEAD_STALE');return b;
  }
  async account(n,address,height){
    decodeAccountAddress(address,n.hrp);
    return this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/auth/v1beta1/accounts/'+address,{height}),v=>{
      const a=v?.account;need(a?.['@type']==='/cosmos.auth.v1beta1.BaseAccount'&&a.address===address,'COSMOS_BASE_ACCOUNT_REQUIRED');
      let publicKey=null;
      if(a.pub_key!==null){need(a.pub_key?.['@type']==='/cosmos.crypto.secp256k1.PubKey'&&typeof a.pub_key.key==='string','COSMOS_SIGNER_TYPE_UNSUPPORTED');const b=Buffer.from(a.pub_key.key,'base64');need(b.length===33&&b.toString('base64')===a.pub_key.key&&cosmosAddress(b.toString('hex'),n.hrp)===address,'COSMOS_ACCOUNT_PUBLIC_KEY_MISMATCH');publicKey=b.toString('hex');}
      return {address,publicKey,accountNumber:String(uint(a.account_number,U64)),sequence:String(uint(a.sequence,U64))};
    });
  }
  async spendable(n,address,denom,height){
    decodeAccountAddress(address,n.hrp);
    return this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/bank/v1beta1/spendable_balances/'+address+'/by_denom?denom='+encodeURIComponent(denom),{height}),v=>{
      need(v?.balance?.denom===denom,'COSMOS_BALANCE_DENOM_MISMATCH');return String(uint(v.balance.amount));
    });
  }
  from(n,a){return accountAddress(n.hrp,decodeAccountAddress(a.address,'cosmos'));}
  async balance(n,a){
    const head=await this.head(n),from=this.from(n,a),account=await this.account(n,from,head.height);
    const balanceAtomic=await this.spendable(n,from,n.denom,head.height),feeBalanceAtomic=n.denom===n.feeDenom?balanceAtomic:await this.spendable(n,from,n.feeDenom,head.height);
    match(await this.block(n,head.height),head,'COSMOS_BLOCK_CHANGED');
    return {family:'cosmos',networkId:n.id,networkFrom:from,asset:n.denom,symbol:n.symbol,decimals:n.decimals,feeAsset:n.feeDenom,feeDecimals:n.feeDecimals,account:{...account,balanceAtomic,feeBalanceAtomic},head,assurance:COSMOS_ASSURANCE,finalityProven:false};
  }
  payment(n,a,u,c){return {...u,chainId:n.chainId,hrp:n.hrp,denom:n.denom,feeDenom:n.feeDenom,accountNumber:c.account.accountNumber,sequence:c.account.sequence,timeoutHeight:String(c.head.height+n.timeoutBlocks),acknowledgeUnverifiedState:true};}
  async inspect(n,a,u,p=null){
    const c=await this.balance(n,a),height=c.head.height;
    if(a.publicKeyHex)need(c.account.publicKey===null||c.account.publicKey===a.publicKeyHex,'COSMOS_AUTHENTICATION_KEY_CHANGED');
    // Existing, standard recipient only; no accidental creation/module/vesting flows.
    await this.account(n,u.to,height);
    const amount=BigInt(u.amountAtomic),fee=BigInt(u.feeAtomic);
    need(BigInt(c.account.balanceAtomic)>=amount+(n.denom===n.feeDenom?fee:0n)&&BigInt(c.account.feeBalanceAtomic)>=fee,'COSMOS_INSUFFICIENT_SPENDABLE_BALANCE');
    if(p){
      need(c.account.sequence===p.sequence&&c.account.accountNumber===p.accountNumber,'COSMOS_SEQUENCE_OR_ACCOUNT_CHANGED');
      need(height<BigInt(p.timeoutHeight)&&BigInt(p.timeoutHeight)<=BigInt(height+n.timeoutBlocks),'COSMOS_TIMEOUT_HEIGHT_EXPIRED');
      const tx=cosmosTransaction(p,a.publicKeyHex);
      const unsigned=Buffer.concat([fieldBytes(1,tx.body),fieldBytes(2,tx.auth),fieldBytes(3,Buffer.alloc(64))]);
      // A real signature is NEVER sent to Simulate.
      const used=await this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/tx/v1beta1/simulate',{body:{tx_bytes:unsigned.toString('base64')},height}),v=>{
        const gas=String(uint(v?.gas_info?.gas_used,U64));need(BigInt(gas)>0n&&BigInt(gas)<=BigInt(p.gasLimit)&&v.result&&typeof v.result==='object','COSMOS_SIMULATION_FAILED_OR_GAS_EXCEEDED');return gas;
      });
      c.gasUsed=used;
    }
    match(await this.block(n,height),c.head,'COSMOS_BLOCK_CHANGED');return c;
  }
  async submit(n,r){
    verifyCosmosSigned(r.signed,r.summary);
    const v=await this.rpc.rest(n,0,'cosmos/tx/v1beta1/txs',{body:{tx_bytes:r.signed.txRawBase64,mode:'BROADCAST_MODE_SYNC'}});
    need(cosmosHash(v?.tx_response?.txhash)===r.signed.requestId&&cosmosInt(v.tx_response.code)===0,'COSMOS_CHECKTX_NOT_ACCEPTED');
  }
  async receipt(n,r){
    verifyCosmosSigned(r.signed,r.summary);const head=await this.head(n),raw=Buffer.from(r.signed.txRawBase64,'base64'),p=r.summary.transfer;
    const tx=await this.rpc.agree(n,i=>this.rpc.comet(n,i,'tx',{hash:Buffer.from(r.signed.requestId,'hex').toString('base64'),prove:true}),v=>{
      need(cosmosHash(v.hash)===r.signed.requestId&&v.tx===r.signed.txRawBase64,'COSMOS_TRANSACTION_MISMATCH');
      const height=cosmosInt(v.height),index=cosmosInt(v.index),code=cosmosInt(v.tx_result?.code,0xffffffff),gasUsed=String(uint(v.tx_result?.gas_used,U64));
      need(height>=n.checkpoint.height&&height<=head.height&&BigInt(gasUsed)<=BigInt(p.gasLimit)&&Array.isArray(v.tx_result.events)&&v.tx_result.events.length<=128,'COSMOS_TX_RESULT_INVALID');
      return {height,index,code,gasUsed,proof:v.proof,events:v.tx_result.events};
    });
    const block=await this.block(n,tx.height);verifyCosmosInclusion(raw,tx.proof,block.dataHash,tx.index);
    const confirmations=head.height-tx.height+1;
    if(confirmations<n.minConfirmations)return {received:false,reason:'confirmation-policy-not-met'};
    const evidence={height:tx.height,blockHash:block.hash,feeAtomic:p.feeAtomic,gasUsed:tx.gasUsed,code:tx.code,inclusionVerified:true,headerHashVerified:false,stateProofVerified:false,balanceDeltaVerified:false,transferObserved:false,confirmations,requiredConfirmations:n.minConfirmations};
    if(tx.code!==0)return {received:false,failed:true,reason:'RPC-execution-failed',...evidence};
    const transfers=tx.events.filter(e=>e.type==='transfer').map(e=>{
      need(Array.isArray(e.attributes)&&e.attributes.length<=16,'COSMOS_EVENT_INVALID');const attrs={};
      for(const a of e.attributes){need(typeof a.key==='string'&&typeof a.value==='string'&&a.key.length<=100&&a.value.length<=256&&!Object.hasOwn(attrs,a.key),'COSMOS_EVENT_INVALID');attrs[a.key]=a.value;}return attrs;
    });
    need(transfers.filter(a=>a.sender===p.networkFrom&&a.recipient===p.to&&a.amount===p.amountAtomic+p.denom).length===1,'COSMOS_TRANSFER_EVENT_MISMATCH');
    const post=await this.account(n,p.networkFrom,tx.height);
    need(post.accountNumber===p.accountNumber&&BigInt(post.sequence)>=BigInt(p.sequence)+1n,'COSMOS_SEQUENCE_RESULT_MISMATCH');
    match(await this.block(n,tx.height),block,'COSMOS_BLOCK_CHANGED');
    return {received:true,reason:'RPC-reported-execution-and-inclusion',...evidence,transferObserved:true};
  }
}
