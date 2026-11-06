import {need,shape,uint,canonical} from '../lib/guard.mjs';
import {decodeAccountAddress,accountAddress} from '../codec/bech32.mjs';
import {fingerprint} from './solana-codec.mjs';
import {decimalAtomic} from './account-network.mjs';
import {validateCosmosNetwork,cosmosNetworkFingerprint,COSMOS_ASSURANCE,COSMOS_ONLINE_OPERATION,cosmosInt,cosmosHash} from './cosmos-network.mjs';
export function cosmosUserPayment(a,raw,n=null) {
  need(a.family==='cosmos'&&a.kind==='local','COSMOS_LOCAL_ACCOUNT_REQUIRED');
  if(n&&Object.hasOwn(raw,'amount')){const {amount,...rest}=raw;need(!Object.hasOwn(rest,'amountAtomic'),'COSMOS_AMOUNT_AMBIGUOUS');raw={...rest,amountAtomic:decimalAtomic(amount,n.decimals)};}
  shape(raw,['requestKey','to','amountAtomic','feeAtomic','gasLimit'],['memo']);
  need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
  const hrp=n?.hrp??raw.to.split('1')[0];
  const to=accountAddress(hrp,decodeAccountAddress(raw.to,hrp));
  need(!decodeAccountAddress(to,hrp).equals(decodeAccountAddress(a.address,'cosmos')),'SELF_TRANSFER_FORBIDDEN');
  const amountAtomic=String(uint(raw.amountAtomic)),feeAtomic=String(uint(raw.feeAtomic)),gasLimit=String(uint(raw.gasLimit,10000000n));
  need(BigInt(amountAtomic)>0n&&BigInt(feeAtomic)>0n&&BigInt(gasLimit)>0n,'COSMOS_AMOUNT_OR_FEE_ZERO');
  const memo=raw.memo??'';need(typeof memo==='string'&&Buffer.byteLength(memo)<=128&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(memo),'COSMOS_MEMO_INVALID');
  if(n)need(BigInt(amountAtomic)<=BigInt(n.maxTransferAtomic)&&BigInt(feeAtomic)<=BigInt(n.maxFeeAtomic)&&BigInt(gasLimit)<=BigInt(n.maxGasLimit),'COSMOS_POLICY_EXCEEDED');
  return {requestKey:raw.requestKey,to,amountAtomic,feeAtomic,gasLimit,memo};
}
export const cosmosPaymentHash=(a,n,u)=>fingerprint({family:'cosmos',accountId:a.id,from:a.address,networkId:n.id,networkFingerprint:cosmosNetworkFingerprint(n),payment:u});
export function validateCosmosOnlineRecord(r,a) {
  const s=r.summary,t=s.transfer;
  need(s.operation===COSMOS_ONLINE_OPERATION&&typeof s.submissionEnabled==='boolean','COSMOS_ONLINE_RECORD_REQUIRED');
  need(s.rpcStateChecked===true&&s.onChainStateVerified===false&&s.finalityProven===false&&s.assurance===COSMOS_ASSURANCE,'COSMOS_ASSURANCE_INVALID');
  const n=validateCosmosNetwork(s.cosmosNetwork);
  need(n.id===s.networkId&&n.chainId===t.chainId&&n.hrp===t.hrp&&n.denom===t.denom&&n.feeDenom===t.feeDenom&&n.decimals===s.decimals&&n.feeDecimals===s.feeDecimals&&n.symbol===s.assetSymbol,'COSMOS_NETWORK_BINDING');
  need(s.networkFingerprint===cosmosNetworkFingerprint(n)&&n.broadcastEnabled===s.submissionEnabled&&canonical(n.checkpoint)===canonical(s.checkpoint),'COSMOS_NETWORK_FINGERPRINT_MISMATCH');
  const u=cosmosUserPayment(a,s.userPayment,n);
  need(canonical(u)===canonical(s.userPayment)&&u.requestKey===r.requestKey&&cosmosPaymentHash(a,n,u)===r.paymentHash,'COSMOS_USER_PAYMENT_MISMATCH');
  for(const k of ['to','amountAtomic','feeAtomic','gasLimit','memo','requestKey'])need(t[k]===u[k],'COSMOS_TRANSFER_BINDING_MISMATCH');
  need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(r.state),'COSMOS_RECORD_STATE');
  if(r.report!==undefined){
    const v=r.report;shape(v,['observedAt','received','reason','assurance','finalityProven'],['height','blockHash','feeAtomic','gasUsed','code','inclusionVerified','headerHashVerified','stateProofVerified','balanceDeltaVerified','transferObserved','confirmations','requiredConfirmations']);
    need(Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&typeof v.received==='boolean'&&typeof v.reason==='string'&&/^[A-Za-z0-9 _:-]{1,128}$/.test(v.reason)&&v.assurance===COSMOS_ASSURANCE&&v.finalityProven===false,'COSMOS_REPORT_INVALID');
    for(const k of ['headerHashVerified','stateProofVerified','balanceDeltaVerified'])if(v[k]!==undefined)need(v[k]===false,'COSMOS_REPORT_INVALID');
    if(['reported-confirmed','reported-reverted'].includes(r.state)){
      need(v.inclusionVerified===true&&v.headerHashVerified===false&&v.stateProofVerified===false&&v.balanceDeltaVerified===false&&cosmosInt(v.height)>=n.checkpoint.height&&v.feeAtomic===t.feeAtomic&&cosmosInt(v.confirmations)>=n.minConfirmations&&v.requiredConfirmations===n.minConfirmations,'COSMOS_REPORT_INVALID');cosmosHash(v.blockHash);need(uint(v.gasUsed)<=uint(t.gasLimit),'COSMOS_REPORT_INVALID');
      need(r.state==='reported-confirmed'?v.received&&v.code===0&&v.transferObserved===true:!v.received&&cosmosInt(v.code)>0,'COSMOS_REPORT_INVALID');
    }else need(!v.received,'COSMOS_REPORT_INVALID');
  }else need(r.state==='signed','COSMOS_REPORT_REQUIRED');
}
