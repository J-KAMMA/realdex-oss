/** Intent and persisted-record bindings shared by the two local account chains. */
import {need,shape,uint,canonical,text} from '../lib/guard.mjs';
import {normalizePublicAccount} from '../lib/keys.mjs';
import {stellarAddress,decodeStellarAddress} from '../codec/strkey.mjs';
import {fingerprint} from './solana-codec.mjs';
import {validateAccountNetwork,accountNetworkFingerprint,decimalAtomic,onlineOperation,ACCOUNT_ASSURANCE,hash,int} from './account-network.mjs';
export function accountUserPayment(family,account,raw){
  const stellar=family==='stellar';need(['stellar','aptos'].includes(family)&&account.family===family&&account.kind==='local','ACCOUNT_LOCAL_SIGNER_REQUIRED');
  const required=stellar?['requestKey','to','amountAtomic','feeAtomic']:['requestKey','to','amountAtomic','maxGasAmount','gasUnitPrice'];
  shape(raw,required,stellar?['memo']:[]);
  need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
  const to=stellar?stellarAddress(decodeStellarAddress(raw.to)):normalizePublicAccount('aptos',raw.to);
  need(to!==account.address&&!/^0x0{64}$/.test(to),'ACCOUNT_RECIPIENT_INVALID');
  const amountAtomic=String(uint(raw.amountAtomic,stellar?(1n<<63n)-1n:(1n<<64n)-1n));need(BigInt(amountAtomic)>0n,'ACCOUNT_AMOUNT_INVALID');
  if(stellar){
    const feeAtomic=String(uint(raw.feeAtomic,10000000n));need(BigInt(feeAtomic)>=100n,'STELLAR_FEE_INVALID');
    const memo=raw.memo??'';need(typeof memo==='string'&&Buffer.byteLength(memo)<=28&&!/[\u0000-\u001f\u007f]/.test(memo),'STELLAR_MEMO_INVALID');
    if(memo)text(memo,28);
    return {requestKey:raw.requestKey,to,amountAtomic,feeAtomic,memo};
  }
  const maxGasAmount=String(uint(raw.maxGasAmount,2000000n)),gasUnitPrice=String(uint(raw.gasUnitPrice,100000n));
  need(BigInt(maxGasAmount)>0n&&BigInt(gasUnitPrice)>0n,'APTOS_GAS_INVALID');
  return {requestKey:raw.requestKey,to,amountAtomic,maxGasAmount,gasUnitPrice};
}
export function normalizeAccountUser(n,a,raw){
  n=validateAccountNetwork(n);
  if(Object.hasOwn(raw,'amount')){
    const {amount,...rest}=raw;need(!Object.hasOwn(rest,'amountAtomic'),'ACCOUNT_AMOUNT_AMBIGUOUS');
    raw={...rest,amountAtomic:decimalAtomic(amount,n.family==='stellar'?7:8)};
  }
  const p=accountUserPayment(n.family,a,raw);
  const fee=n.family==='stellar'?BigInt(p.feeAtomic):BigInt(p.maxGasAmount)*BigInt(p.gasUnitPrice);
  need(BigInt(p.amountAtomic)<=BigInt(n.maxTransferAtomic)&&fee<=BigInt(n.maxFeeAtomic),'ACCOUNT_POLICY_EXCEEDED');
  return p;
}
export const accountPaymentHash=(family,accountId,from,networkId,networkFingerprint,p)=>fingerprint({family,accountId,from,networkId,networkFingerprint,payment:p});
export function validateOnlineAccountMeta(record,account){
  const s=record.summary,f=record.family;
  need(['stellar','aptos'].includes(f)&&s.operation===onlineOperation(f),'ACCOUNT_ONLINE_RECORD_REQUIRED');
  need(typeof s.submissionEnabled==='boolean'&&s.onChainStateVerified===false&&s.rpcStateChecked===true&&s.finalityProven===false&&s.assurance===ACCOUNT_ASSURANCE,'ACCOUNT_ASSURANCE_INVALID');
  need(/^[0-9a-f]{64}$/.test(s.networkFingerprint),'ACCOUNT_NETWORK_FINGERPRINT_INVALID');
  shape(s.checkpoint,['height','hash']);need(int(s.checkpoint.height,2147483647)>=1,'ACCOUNT_CHECKPOINT_REQUIRED');hash(s.checkpoint.hash,f==='aptos');
  const u=accountUserPayment(f,account,s.userPayment);
  need(canonical(u)===canonical(s.userPayment)&&u.requestKey===record.requestKey&&u.to===s.recipient&&u.amountAtomic===s.amountAtomic,'ACCOUNT_USER_PAYMENT_MISMATCH');
  const t=s.transfer;
  need(t.to===u.to&&t.amountAtomic===u.amountAtomic&&(f==='stellar'?t.feeAtomic===u.feeAtomic&&t.memo===u.memo:t.maxGasAmount===u.maxGasAmount&&t.gasUnitPrice===u.gasUnitPrice),'ACCOUNT_TRANSFER_BINDING_MISMATCH');
  need(record.paymentHash===accountPaymentHash(f,account.id,account.address,s.networkId,s.networkFingerprint,u),'ACCOUNT_PAYMENT_HASH_MISMATCH');
  need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(record.state),'ACCOUNT_STATE_INVALID');
  if(record.report!==undefined){
    const r=record.report;
    shape(r,['observedAt','received','reason','assurance','finalityProven'],['ledger','ledgerHash','version','feeAtomic','transferObserved','balanceDeltaVerified','confirmations','requiredConfirmations']);
    need(Number.isSafeInteger(r.observedAt)&&r.observedAt>=0&&typeof r.received==='boolean'&&typeof r.reason==='string'&&/^[A-Za-z0-9 _:-]{1,128}$/.test(r.reason)&&r.assurance===ACCOUNT_ASSURANCE&&r.finalityProven===false,'ACCOUNT_REPORT_INVALID');
    if(r.received)need(record.state==='reported-confirmed'&&r.transferObserved===true&&uint(r.feeAtomic)<=uint(s.feeAtomic)&&int(r.confirmations)>=int(r.requiredConfirmations)&&r.requiredConfirmations>=1,'ACCOUNT_REPORT_INVALID');
    if(record.state==='reported-confirmed'){
      need(r.received===true&&int(r.ledger,2147483647)>=s.checkpoint.height,'ACCOUNT_REPORT_INVALID');hash(r.ledgerHash,f==='aptos');
      if(f==='aptos')need(uint(r.version)>0n&&r.balanceDeltaVerified===true,'ACCOUNT_REPORT_INVALID');
      else need(r.balanceDeltaVerified===false,'ACCOUNT_REPORT_INVALID');
    }
    if(record.state==='reported-reverted')need(r.received===false,'ACCOUNT_REPORT_INVALID');
    if(r.balanceDeltaVerified!==undefined)need(typeof r.balanceDeltaVerified==='boolean'&&(f==='aptos'||r.balanceDeltaVerified===false),'ACCOUNT_REPORT_INVALID');
  }else need(record.state==='signed','ACCOUNT_REPORT_REQUIRED');
}
