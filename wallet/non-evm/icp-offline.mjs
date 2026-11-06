/** Offline ICRC-1 intent creation. Never posts a call or claims certified execution. */
import {randomBytes, randomUUID, createPublicKey, createHash, verify} from 'node:crypto';
import {need, shape, text, uint, hex, canonical, freeze} from '../lib/guard.mjs';
import {sha256} from '../lib/keys.mjs';
import {encodeIcrcTransfer, icRequestId, signIcrcTransfer} from '../lib/transactions.mjs';
import {principalBytes, principalText, canisterPrincipal, icrcAccount} from '../../node/icp/principal.mjs';
import {decodeCbor, encodeCbor} from '../../node/icp/cbor.mjs';
import {canonicalBase64, fingerprint} from './solana-codec.mjs';
const U64=(1n<<64n)-1n;
export function prepareIcpOffline(account, raw, now=Date.now()) {
  shape(raw,['requestKey','networkId','ledger','to','amountAtomic','feeAtomic'],['fromSubaccount','memoHex']);
  need(account.family==='icp'&&account.kind==='local','ICP_LOCAL_ACCOUNT_REQUIRED');
  need(/^icp:local-[a-z0-9-]{1,40}$/.test(raw.networkId),'ICP_OFFLINE_LOCAL_PROFILE_ONLY');
  need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
  const ledger=canisterPrincipal(raw.ledger), to=icrcAccount(raw.to), fromSubaccount=(raw.fromSubaccount??'0'.repeat(64)).toLowerCase();hex(fromSubaccount,32,false);
  need(to.owner!=='2vxsx-fae'&&principalBytes(to.owner).length>0,'ICP_RECIPIENT_INVALID');
  need(to.owner!==account.address||to.subaccount!==fromSubaccount,'ICP_SELF_TRANSFER_FORBIDDEN');
  const amountAtomic=String(uint(raw.amountAtomic)),feeAtomic=String(uint(raw.feeAtomic));need(BigInt(amountAtomic)>0n,'ZERO_TRANSFER');
  const memoHex=(raw.memoHex??randomBytes(32).toString('hex')).toLowerCase();hex(memoHex,32,false);
  const transfer={fromSubaccount,to:{owner:to.owner,subaccount:to.subaccount},amountAtomic,feeAtomic,memoHex,createdAtTimeNs:String(BigInt(now)*1000000n)};
  const payment={family:'icp',networkId:raw.networkId,accountId:account.id,from:account.address,ledger,to:transfer.to,fromSubaccount,amountAtomic,feeAtomic,requestedMemoHex:raw.memoHex?.toLowerCase()??null};
  const paymentHash=fingerprint(payment),createdAt=now,expiresAt=now+60000;
  const summary={family:'icp',operation:'icrc1-offline-envelope',networkId:raw.networkId,ledger,from:account.address,recipient:to.owner,subaccount:to.subaccount,amountAtomic,feeAtomic,totalDebitAtomic:String(BigInt(amountAtomic)+BigInt(feeAtomic)),transfer,requestKey:raw.requestKey,paymentHash,expiresAt,ingressExpiryNs:String(BigInt(now+120000)*1000000n),nonceHex:randomBytes(32).toString('hex'),requestedMemoHex:payment.requestedMemoHex,certifiedResponseVerifierImplemented:false,submissionEnabled:false,metadataAssurance:'manually-specified-atomic-amount-and-fee-not-certified'};
  const intent={family:'icp',accountId:account.id,networkId:raw.networkId,payment:{...payment,requestKey:raw.requestKey,paymentHash},summary,createdAt,expiresAt,salt:randomUUID()};
  return freeze({...intent,id:fingerprint(intent)});
}
export function signIcpOffline(vault,intent,{now=Date.now,authorize=()=>{}}={}) {
  const {id,...content}=intent;need(fingerprint(content)===id,'ICP_INTENT_CHANGED');
  return vault.signNonEvmAndRecord(intent,secret=>{
    authorize();need(now()>=intent.createdAt&&now()<intent.expiresAt,'ICP_INTENT_EXPIRED');
    return signIcrcTransfer(secret,{ledger:intent.summary.ledger,transfer:intent.summary.transfer,ingressExpiryNs:intent.summary.ingressExpiryNs,nonceHex:intent.summary.nonceHex});
  });
}
export function verifyIcpEnvelope(signed,summary) {
  shape(signed,['format','sender','requestId','envelopeBase64','certifiedResponseVerifierImplemented']);
  need(signed.format==='icrc1-transfer-call-envelope'&&signed.certifiedResponseVerifierImplemented===false,'ICP_ENVELOPE_FORMAT');
  const bytes=canonicalBase64(signed.envelopeBase64,16384), envelope=decodeCbor(bytes);
  shape(envelope,['content','sender_pubkey','sender_sig']);
  const c=envelope.content;shape(c,['request_type','canister_id','method_name','arg','sender','ingress_expiry','nonce']);
  need(c.request_type==='call'&&c.method_name==='icrc1_transfer','ICP_METHOD_FORBIDDEN');
  need(Buffer.from(c.canister_id).equals(Buffer.from(principalBytes(canisterPrincipal(summary.ledger))))&&Buffer.from(c.arg).equals(encodeIcrcTransfer(summary.transfer)),'ICP_CALL_BINDING_MISMATCH');
  need(c.ingress_expiry===uint(summary.ingressExpiryNs,U64)&&Buffer.from(c.nonce).equals(hex(summary.nonceHex,32,false)),'ICP_LIFETIME_BINDING_MISMATCH');
  const der=Buffer.from(envelope.sender_pubkey);
  need(der.length===44&&der.subarray(0,12).equals(Buffer.from('302a300506032b6570032100','hex')),'ICP_ED25519_REQUIRED');
  const principal=principalText(Buffer.concat([createHash('sha224').update(der).digest(),Buffer.from([2])]));
  need(principal===summary.from&&signed.sender===principal&&Buffer.from(c.sender).equals(Buffer.from(principalBytes(principal))),'ICP_SENDER_BINDING_MISMATCH');
  const requestId=icRequestId(c);need(requestId.toString('hex')===signed.requestId,'ICP_REQUEST_ID_MISMATCH');
  need(verify(null,Buffer.concat([Buffer.from([10]),Buffer.from('ic-request'),requestId]),createPublicKey({key:der,format:'der',type:'spki'}),envelope.sender_sig),'ICP_SIGNATURE_INVALID');
  need(Buffer.from(encodeCbor(envelope)).equals(bytes),'ICP_ENVELOPE_NONCANONICAL');
  return {requestId:signed.requestId,sender:principal,submitted:false,certified:false};
}
