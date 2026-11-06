/** Local chain 4, original Ed25519 authentication key, existing accounts, native APT only. */
import {need,uint,canonical} from '../lib/guard.mjs';
import {normalizePublicAccount} from '../lib/keys.mjs';
import {aptosTransaction} from './aptos-offline.mjs';
import {ACCOUNT_ASSURANCE,int,hash} from './account-network.mjs';
/** Only node-returned account addresses are padded; owner inputs remain full-width. */
export function normalizeAptosRpcAddress(value) {
  need(typeof value==='string' && /^0x[0-9a-fA-F]{1,64}$/.test(value), 'APTOS_RPC_ADDRESS_INVALID');
  return normalizePublicAccount('aptos', '0x'+value.slice(2).toLowerCase().padStart(64,'0'));
}
const addr=normalizeAptosRpcAddress;
const U64=(1n<<64n)-1n;
const json=b=>JSON.stringify(b);
export class AptosAdapter {
  constructor(rest,now){this.rest=rest;this.now=now;}
  block(v){need(v&&typeof v.block_timestamp==='string','APTOS_BLOCK_INVALID');need(uint(v.first_version,U64)<=uint(v.last_version,U64),'APTOS_BLOCK_VERSION_RANGE');return {
    height:int(v.block_height,2147483647),hash:hash(v.block_hash,true),
    firstVersion:String(uint(v.first_version,U64)),lastVersion:String(uint(v.last_version,U64)),
    timestamp:Number(uint(v.block_timestamp,BigInt(Number.MAX_SAFE_INTEGER)*1000n)/1000n)
  };}
  async snapshot(n){
    const roots=await this.rest.all(n,'');
    const views=roots.map(r=>{
      need(r?.chain_id===4,'APTOS_CHAIN_ID_MISMATCH');
      const version=uint(r.ledger_version,U64),oldest=uint(r.oldest_ledger_version,U64);
      need(version>=oldest,'APTOS_LEDGER_INVALID');
      const timestamp=Number(uint(r.ledger_timestamp,BigInt(Number.MAX_SAFE_INTEGER)*1000n)/1000n);
      need(timestamp<=this.now()+30000&&this.now()-timestamp<=60000,'ACCOUNT_LEDGER_STALE_OR_FUTURE');
      return {version,oldest};
    });
    const version=views.reduce((a,v)=>a<v.version?a:v.version,views[0].version);
    need(views.every(v=>v.version-version<=100n&&v.oldest<=version),'APTOS_RPC_LAG_OR_PRUNED');
    const checkpoint=await this.rest.agree(n,`blocks/by_height/${n.checkpoint.height}?with_transactions=false`,undefined,v=>this.block(v));
    need(checkpoint.height===n.checkpoint.height&&checkpoint.hash===n.checkpoint.hash,'ACCOUNT_CHECKPOINT_MISMATCH');
    const b=await this.rest.agree(n,`blocks/by_version/${version}?with_transactions=false`,undefined,v=>this.block(v));
    need(b.height>=n.checkpoint.height&&BigInt(b.firstVersion)<=version&&BigInt(b.lastVersion)>=version,'APTOS_VERSION_BLOCK_MISMATCH');
    need(b.timestamp<=this.now()+30000&&this.now()-b.timestamp<=60000,'ACCOUNT_LEDGER_STALE_OR_FUTURE');
    return {...b,version:String(version)};
  }
  async stable(n,h){
    const now=await this.snapshot(n);need(BigInt(now.version)>=BigInt(h.version),'APTOS_LEDGER_ROLLBACK');
    const b=await this.rest.agree(n,`blocks/by_version/${h.version}?with_transactions=false`,undefined,v=>this.block(v));
    need(b.hash===h.hash&&b.height===h.height&&b.firstVersion===h.firstVersion&&b.lastVersion===h.lastVersion&&b.timestamp===h.timestamp,'APTOS_CHECKED_BLOCK_CHANGED');
  }
  async account(n,address,version,{signer=false}={}){
    address=addr(address);
    const a=await this.rest.agree(n,`accounts/${address}?ledger_version=${version}`,undefined,v=>{
      const sequence=String(uint(v.sequence_number,U64)),authenticationKey=addr(v.authentication_key);
      if(signer)need(authenticationKey===address,'APTOS_ROTATED_AUTH_KEY_UNSUPPORTED');
      return {sequence,authenticationKey};
    });
    const balanceAtomic=await this.rest.agree(n,`view?ledger_version=${version}`,{method:'POST',body:json({function:'0x1::coin::balance',type_arguments:['0x1::aptos_coin::AptosCoin'],arguments:[address]})},v=>{
      need(Array.isArray(v)&&v.length===1,'APTOS_BALANCE_VIEW_INVALID');return String(uint(v[0],U64));
    });
    return {address,...a,balanceAtomic};
  }
  checkTransaction(v,p,{simulation=false,signed}={}){
    need(v&&(simulation?(v.type===undefined||v.type==='user_transaction'):v.type==='user_transaction')&&addr(v.sender)===p.from&&v.sequence_number===p.sequence&&v.max_gas_amount===p.maxGasAmount&&v.gas_unit_price===p.gasUnitPrice&&v.expiration_timestamp_secs===p.expirationTimestampSecs,'APTOS_TRANSACTION_MISMATCH');
    const payload=v.payload;
    need(payload?.type==='entry_function_payload'&&/^(0x1|0x0{63}1)::aptos_account::transfer$/.test(payload.function)&&Array.isArray(payload.type_arguments)&&payload.type_arguments.length===0&&Array.isArray(payload.arguments)&&payload.arguments.length===2&&addr(payload.arguments[0])===p.to&&payload.arguments[1]===p.amountAtomic,'APTOS_PAYLOAD_MISMATCH');
    need(typeof v.success==='boolean'&&typeof v.vm_status==='string'&&v.vm_status.length<=4096,'APTOS_RESULT_INVALID');
    need(v.success===(v.vm_status==='Executed successfully'),'APTOS_RESULT_STATUS_MISMATCH');
    const gas=uint(v.gas_used,BigInt(p.maxGasAmount));
    if(simulation)need(v.success===true&&v.vm_status==='Executed successfully','APTOS_SIMULATION_FAILED');
    if(signed)need(v.hash===signed.requestId&&v.signature?.type==='ed25519_signature'&&v.signature.public_key==='0x'+signed.publicKeyHex&&v.signature.signature==='0x'+Buffer.from(signed.signature,'base64').toString('hex'),'APTOS_RECEIPT_SIGNATURE_MISMATCH');
    return {success:v.success,gasUsed:String(gas)};
  }
  async simulate(n,a,p){
    // Zero signature only: simulation cannot authorize a transfer.
    const raw=aptosTransaction(p).raw,pub=Buffer.from(a.publicKeyHex,'hex');
    need(pub.length===32,'APTOS_PUBLIC_KEY_INVALID');
    const unsigned=Buffer.concat([raw,Buffer.from([0,32]),pub,Buffer.from([64]),Buffer.alloc(64)]);
    return this.rest.agree(n,'transactions/simulate?estimate_gas_unit_price=false&estimate_max_gas_amount=false',{method:'POST',contentType:'application/x.aptos.signed_transaction+bcs',body:unsigned},v=>{
      need(Array.isArray(v)&&v.length===1,'APTOS_SIMULATION_INVALID');return this.checkTransaction(v[0],p,{simulation:true});
    });
  }
  async inspect(n,a,user,expected){
    const head=await this.snapshot(n);
    const source=await this.account(n,a.address,head.version,{signer:true}),destination=await this.account(n,user.to,head.version);
    need(BigInt(source.balanceAtomic)>=BigInt(user.amountAtomic)+BigInt(user.maxGasAmount)*BigInt(user.gasUnitPrice),'APTOS_INSUFFICIENT_BALANCE');
    need(BigInt(destination.balanceAtomic)+BigInt(user.amountAtomic)<=U64,'APTOS_DESTINATION_CAPACITY');
    if(expected){
      need(expected.sequence===source.sequence,'ACCOUNT_SEQUENCE_CHANGED');
      need(BigInt(expected.expirationTimestampSecs)>BigInt(Math.floor(this.now()/1000)),'ACCOUNT_TRANSACTION_EXPIRED');
      await this.simulate(n,a,expected);
    }
    await this.stable(n,head);
    return {head,source,destination};
  }
  payment(n,a,u,checked){return {...u,chainId:4,sequence:checked.source.sequence,expirationTimestampSecs:String(Math.floor(this.now()/1000)+180),acknowledgeUnverifiedState:true};}
  async balance(n,a){
    const head=await this.snapshot(n),account=await this.account(n,a.address,head.version,{signer:true});await this.stable(n,head);
    return {networkId:n.id,address:a.address,asset:'APT-local',decimals:8,account,head,observedAt:this.now(),assurance:ACCOUNT_ASSURANCE,finalityProven:false};
  }
  async submit(n,r){
    const value=await this.rest.call(n,0,'transactions',{method:'POST',contentType:'application/x.aptos.signed_transaction+bcs',body:Buffer.from(r.signed.signedTransactionHex,'hex')});
    need(value?.hash===r.signed.requestId,'ACCOUNT_SUBMISSION_HASH_MISMATCH');
  }
  async receipt(n,r){
    const h=await this.snapshot(n),p=r.summary.transfer;
    const project=v=>{
      if(v===null)return null;
      if(v.type==='pending_transaction'){need(v.hash===r.signed.requestId,'APTOS_PENDING_HASH_MISMATCH');return {pending:true};}
      const result=this.checkTransaction(v,p,{signed:r.signed}),version=uint(v.version,U64);
      need(version>0n&&version<=BigInt(h.version),'APTOS_TRANSACTION_VERSION_INVALID');
      need(uint(v.timestamp,BigInt(Number.MAX_SAFE_INTEGER)*1000n)/1000000n<BigInt(p.expirationTimestampSecs),'APTOS_RECEIPT_TIME_INVALID');
      return {...result,version:String(version),hash:v.hash};
    };
    const tx=await this.rest.agree(n,`transactions/by_hash/${r.signed.requestId}`,{notFound:true},project);
    if(tx===null||tx.pending)return {received:false,reason:tx?.pending?'pending-not-executed':'transaction-not-observed-reservation-retained'};
    need(canonical(await this.rest.agree(n,`transactions/by_version/${tx.version}`,undefined,project))===canonical(tx),'APTOS_VERSION_HASH_MISMATCH');
    const block=await this.rest.agree(n,`blocks/by_version/${tx.version}?with_transactions=false`,undefined,v=>this.block(v));
    need(block.height>=n.checkpoint.height&&BigInt(block.firstVersion)<=BigInt(tx.version)&&BigInt(block.lastVersion)>=BigInt(tx.version),'APTOS_RECEIPT_BLOCK_MISMATCH');
    const v=BigInt(tx.version),prior=String(v-1n);
    const beforeFrom=await this.account(n,p.from,prior,{signer:true}),afterFrom=await this.account(n,p.from,tx.version,{signer:true});
    const beforeTo=await this.account(n,p.to,prior),afterTo=await this.account(n,p.to,tx.version);
    const fee=BigInt(tx.gasUsed)*BigInt(p.gasUnitPrice),amount=tx.success?BigInt(p.amountAtomic):0n;
    need(beforeFrom.sequence===p.sequence&&BigInt(afterFrom.sequence)===BigInt(p.sequence)+1n,'APTOS_RECEIPT_SEQUENCE_MISMATCH');
    need(BigInt(beforeFrom.balanceAtomic)-BigInt(afterFrom.balanceAtomic)===amount+fee&&BigInt(afterTo.balanceAtomic)-BigInt(beforeTo.balanceAtomic)===amount,'APTOS_BALANCE_DELTA_MISMATCH');
    await this.stable(n,h);
    const confirmations=h.height-block.height+1,enough=confirmations>=n.minConfirmations;
    return {received:enough&&tx.success,reason:enough?(tx.success?'RPC-payment-observed':'RPC-execution-failed'):'awaiting-confirmations',failed:enough&&!tx.success,ledger:block.height,ledgerHash:block.hash,version:tx.version,feeAtomic:String(fee),transferObserved:tx.success,balanceDeltaVerified:true,confirmations,requiredConfirmations:n.minConfirmations};
  }
}
