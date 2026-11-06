/** Initial-auth-key Ed25519 accounts; fixed 0x1::aptos_account::transfer on local chain ID 4. */
import {randomUUID,createHash,createPublicKey,verify} from 'node:crypto';
import {need,shape,uint,freeze,canonical} from '../lib/guard.mjs';
import {keyInfo,normalizePublicAccount,signEd25519} from '../lib/keys.mjs';
import {fingerprint,canonicalBase64} from './solana-codec.mjs';
const U64=(1n<<64n)-1n;
export const sha3=b=>createHash('sha3-256').update(b).digest();
const le64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;};
const blob=b=>{need(b.length<128,'APTOS_BCS_VECTOR_LIMIT');return Buffer.concat([Buffer.from([b.length]),b]);};
const address=a=>Buffer.from(normalizePublicAccount('aptos',a).slice(2),'hex');
export function aptosTransaction(p){
  const moduleAddress=Buffer.concat([Buffer.alloc(31),Buffer.from([1])]);
  const payload=Buffer.concat([Buffer.from([2]),moduleAddress,blob(Buffer.from('aptos_account')),blob(Buffer.from('transfer')),Buffer.from([0,2]),blob(address(p.to)),blob(le64(p.amountAtomic))]);
  const raw=Buffer.concat([address(p.from),le64(p.sequence),payload,le64(p.maxGasAmount),le64(p.gasUnitPrice),le64(p.expirationTimestampSecs),Buffer.from([p.chainId])]);
  return {raw,signingMessage:Buffer.concat([sha3(Buffer.from('APTOS::RawTransaction')),raw])};
}
export function normalizeAptosPayment(a,r){
  shape(r,['requestKey','chainId','to','amountAtomic','sequence','maxGasAmount','gasUnitPrice','expirationTimestampSecs','acknowledgeUnverifiedState']);
  need(a.family==='aptos'&&a.kind==='local','APTOS_LOCAL_ACCOUNT_REQUIRED');need(r.chainId===4,'APTOS_LOCAL_CHAIN_FOUR_ONLY');
  need(typeof r.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey),'PAYMENT_KEY_INVALID');need(r.acknowledgeUnverifiedState===true,'UNVERIFIED_STATE_ACK_REQUIRED');
  const to=normalizePublicAccount('aptos',r.to);need(to!==a.address&&!/^0x0{64}$/.test(to),'APTOS_RECIPIENT_INVALID');
  const amount=uint(r.amountAtomic,U64),sequence=uint(r.sequence,U64),gas=uint(r.maxGasAmount,2000000n),price=uint(r.gasUnitPrice,100000n),expiry=uint(r.expirationTimestampSecs,U64);need(amount>0n&&gas>0n&&price>0n&&expiry>0n,'APTOS_AMOUNT_OR_FEE_INVALID');need(amount+gas*price<=U64,'APTOS_TOTAL_OVERFLOW');
  const p={family:'aptos',networkId:'aptos:local-4',accountId:a.id,from:a.address,to,chainId:4,amountAtomic:String(amount),sequence:String(sequence),maxGasAmount:String(gas),gasUnitPrice:String(price),expirationTimestampSecs:String(expiry)};return {...p,requestKey:r.requestKey,paymentHash:fingerprint(p)};
}
export function prepareAptosOffline(a,r,now=Date.now()){
  const p=normalizeAptosPayment(a,r);need(BigInt(p.expirationTimestampSecs)>BigInt(Math.floor(now/1000))&&BigInt(p.expirationTimestampSecs)<=BigInt(Math.floor(now/1000)+300),'APTOS_EXPIRATION_REQUIRED');const expiresAt=Math.min(now+60000,Number(p.expirationTimestampSecs)*1000),fee=BigInt(p.maxGasAmount)*BigInt(p.gasUnitPrice);
  const i={family:'aptos',accountId:a.id,networkId:p.networkId,payment:p,createdAt:now,expiresAt,salt:randomUUID(),summary:{family:'aptos',operation:'aptos-native-transfer-offline',networkId:p.networkId,from:a.address,recipient:p.to,asset:'APT-local',decimals:8,amountAtomic:p.amountAtomic,feeAtomic:String(fee),feeAsset:'APT-local',feeIsMaximum:true,totalDebitAtomic:String(BigInt(p.amountAtomic)+fee),sequenceKey:canonical(['aptos',p.chainId,p.from,p.sequence]),transfer:p,requestKey:p.requestKey,paymentHash:p.paymentHash,submissionEnabled:false,onChainStateVerified:false,expiresAt}};i.id=fingerprint(i);return freeze(i);
}
export function signAptosPayment(secret,p){const info=keyInfo('aptos',secret);need(info.address===p.from,'APTOS_SIGNER_MISMATCH');const t=aptosTransaction(p),sig=signEd25519(secret,t.signingMessage),pub=Buffer.from(info.publicKeyHex,'hex'),signed=Buffer.concat([t.raw,Buffer.from([0]),blob(pub),blob(sig)]);return {format:'aptos-ed25519-native-transfer',signature:sig.toString('base64'),publicKeyHex:info.publicKeyHex,rawTransactionHex:t.raw.toString('hex'),signedTransactionHex:signed.toString('hex'),requestId:'0x'+sha3(Buffer.concat([sha3(Buffer.from('APTOS::Transaction')),Buffer.from([0]),signed])).toString('hex')};}
export function verifyAptosSigned(s,summary){shape(s,['format','signature','publicKeyHex','rawTransactionHex','signedTransactionHex','requestId']);need(s.format==='aptos-ed25519-native-transfer'&&/^[0-9a-f]{64}$/.test(s.publicKeyHex),'APTOS_SIGNATURE_FORMAT');const pub=Buffer.from(s.publicKeyHex,'hex'),sig=canonicalBase64(s.signature,64),t=aptosTransaction(summary.transfer);need(sig.length===64&&'0x'+sha3(Buffer.concat([pub,Buffer.from([0])])).toString('hex')===summary.from,'APTOS_AUTH_KEY_MISMATCH');const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),pub]),format:'der',type:'spki'}),signed=Buffer.concat([t.raw,Buffer.from([0]),blob(pub),blob(sig)]);need(s.rawTransactionHex===t.raw.toString('hex')&&s.signedTransactionHex===signed.toString('hex')&&s.requestId==='0x'+sha3(Buffer.concat([sha3(Buffer.from('APTOS::Transaction')),Buffer.from([0]),signed])).toString('hex')&&verify(null,t.signingMessage,key,sig),'APTOS_SIGNATURE_INVALID');return true;}
export async function signAptosOffline(vault,i,{now=Date.now,authorize=()=>{}}={}){const {id,...rest}=i;need(fingerprint(rest)===id&&now()>=i.createdAt&&now()<i.expiresAt,'APTOS_INTENT_INVALID_OR_EXPIRED');return vault.signNonEvmAndRecord(i,secret=>{authorize();need(now()<i.expiresAt,'APTOS_INTENT_EXPIRED');return signAptosPayment(secret,i.payment);});}
