/** Single-source, single-payment XLM transaction. No arbitrary XDR signing, account merge or multisig. */
import {randomUUID,createPublicKey,verify} from 'node:crypto';
import {need,shape,uint,text,freeze,canonical} from '../lib/guard.mjs';
import {keyInfo,signEd25519,sha256} from '../lib/keys.mjs';
import {stellarAddress,decodeStellarAddress} from '../codec/strkey.mjs';
import {fingerprint,canonicalBase64} from './solana-codec.mjs';
export const STELLAR_LOCAL_PASSPHRASE='Standalone Network ; February 2017';
const I64=(1n<<63n)-1n;
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(n));return b;};
const variable=b=>Buffer.concat([u32(b.length),b,Buffer.alloc((4-b.length%4)%4)]);
const account=a=>Buffer.concat([u32(0),decodeStellarAddress(a)]);
export function stellarTransaction(p){
  const memo=p.memo?Buffer.concat([u32(1),variable(Buffer.from(p.memo,'utf8'))]):u32(0);
  const payment=Buffer.concat([u32(0),u32(1),account(p.to),u32(0),u64(p.amountAtomic)]);
  const tx=Buffer.concat([account(p.from),u32(Number(p.feeAtomic)),u64(p.sequence),u32(1),u64(0n),u64(p.maxTime),memo,u32(1),payment,u32(0)]);
  const networkHash=sha256(Buffer.from(p.networkPassphrase,'utf8')),digest=sha256(Buffer.concat([networkHash,u32(2),tx]));
  return {tx,networkHash,digest};
}
export function normalizeStellarPayment(a,r){
  shape(r,['requestKey','networkPassphrase','to','amountAtomic','feeAtomic','sequence','maxTime','acknowledgeUnverifiedState'],['memo']);
  need(a.family==='stellar'&&a.kind==='local','STELLAR_LOCAL_ACCOUNT_REQUIRED');need(r.networkPassphrase===STELLAR_LOCAL_PASSPHRASE,'STELLAR_STANDALONE_ONLY');
  need(typeof r.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey),'PAYMENT_KEY_INVALID');need(r.acknowledgeUnverifiedState===true,'UNVERIFIED_STATE_ACK_REQUIRED');
  const to=stellarAddress(decodeStellarAddress(r.to));need(to!==a.address,'SELF_TRANSFER_FORBIDDEN');const amount=uint(r.amountAtomic,I64),fee=uint(r.feeAtomic,10000000n),sequence=uint(r.sequence,I64),maxTime=uint(r.maxTime,I64);
  need(amount>0n&&fee>=100n&&amount+fee<=I64&&sequence>0n&&maxTime>0n,'STELLAR_AMOUNT_FEE_SEQUENCE_TIME');const memo=r.memo??'';if(memo)text(memo,28);need(Buffer.byteLength(memo)<=28,'STELLAR_MEMO_BYTES_LIMIT');
  const p={family:'stellar',networkId:'stellar:standalone',accountId:a.id,from:a.address,networkPassphrase:r.networkPassphrase,to,amountAtomic:String(amount),feeAtomic:String(fee),sequence:String(sequence),maxTime:String(maxTime),memo};return {...p,requestKey:r.requestKey,paymentHash:fingerprint(p)};
}
export function prepareStellarOffline(a,r,now=Date.now()){
  const p=normalizeStellarPayment(a,r);need(BigInt(p.maxTime)>BigInt(Math.floor(now/1000))&&BigInt(p.maxTime)<=BigInt(Math.floor(now/1000)+300),'STELLAR_TIME_BOUNDS_REQUIRED');
  const expiresAt=Math.min(now+60000,Number(p.maxTime)*1000),intent={family:'stellar',accountId:a.id,networkId:p.networkId,payment:p,createdAt:now,expiresAt,salt:randomUUID(),summary:{family:'stellar',operation:'stellar-native-payment-offline',networkId:p.networkId,from:a.address,recipient:p.to,asset:'XLM-standalone',decimals:7,amountAtomic:p.amountAtomic,feeAtomic:p.feeAtomic,feeAsset:'XLM-standalone',totalDebitAtomic:String(BigInt(p.amountAtomic)+BigInt(p.feeAtomic)),sequenceKey:canonical(['stellar',p.networkId,p.from,p.sequence]),transfer:p,requestKey:p.requestKey,paymentHash:p.paymentHash,submissionEnabled:false,onChainStateVerified:false,expiresAt}};intent.id=fingerprint(intent);return freeze(intent);
}
export function signStellarPayment(secret,p){const info=keyInfo('stellar',secret);need(info.address===p.from,'STELLAR_SIGNER_MISMATCH');const t=stellarTransaction(p),signature=signEd25519(secret,t.digest),pub=Buffer.from(info.publicKeyHex,'hex'),envelope=Buffer.concat([u32(2),t.tx,u32(1),pub.subarray(-4),variable(signature)]);return {format:'stellar-v1-native-payment',signature:signature.toString('base64'),publicKeyHex:info.publicKeyHex,envelopeXdrBase64:envelope.toString('base64'),requestId:t.digest.toString('hex'),networkHash:t.networkHash.toString('hex')};}
export function verifyStellarSigned(s,summary){shape(s,['format','signature','publicKeyHex','envelopeXdrBase64','requestId','networkHash']);need(s.format==='stellar-v1-native-payment'&&/^[0-9a-f]{64}$/.test(s.publicKeyHex),'STELLAR_SIGNATURE_FORMAT');const pub=Buffer.from(s.publicKeyHex,'hex'),sig=canonicalBase64(s.signature,64),t=stellarTransaction(summary.transfer);need(sig.length===64&&stellarAddress(pub)===summary.from,'STELLAR_SIGNER_MISMATCH');const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub]),format:'der',type:'spki'});const envelope=Buffer.concat([u32(2),t.tx,u32(1),pub.subarray(-4),variable(sig)]);need(s.envelopeXdrBase64===envelope.toString('base64')&&s.requestId===t.digest.toString('hex')&&s.networkHash===t.networkHash.toString('hex')&&verify(null,t.digest,key,sig),'STELLAR_SIGNATURE_INVALID');return true;}
export async function signStellarOffline(vault,i,{now=Date.now,authorize=()=>{}}={}){const {id,...rest}=i;need(fingerprint(rest)===id&&now()>=i.createdAt&&now()<i.expiresAt,'STELLAR_INTENT_INVALID_OR_EXPIRED');return vault.signNonEvmAndRecord(i,secret=>{authorize();need(now()<i.expiresAt,'STELLAR_INTENT_EXPIRED');return signStellarPayment(secret,i.payment);});}
