/** Standard Cosmos SDK SIGN_MODE_DIRECT + exactly one bank MsgSend. Offline/local profiles only. */
import {createHash,randomUUID} from 'node:crypto';
import {need,shape,uint,text,freeze,canonical} from '../lib/guard.mjs';
import {keyInfo,sha256,signDigest} from '../lib/keys.mjs';
import {accountAddress,decodeAccountAddress} from '../codec/bech32.mjs';
import {fieldBytes as bytes,fieldText as str,fieldUint as num,anyMessage} from '../codec/protobuf.mjs';
import {fingerprint,canonicalBase64} from './solana-codec.mjs';
import * as secp from '../vendor/noble-secp256k1.mjs';
const U64=(1n<<64n)-1n;
const hash160=b=>createHash('ripemd160').update(sha256(b)).digest();
export const cosmosAddress=(publicKeyHex,hrp='cosmos')=>accountAddress(hrp,hash160(Buffer.from(publicKeyHex,'hex')));
export function cosmosTransaction(p,publicKeyHex){
  need(/^(02|03)[0-9a-f]{64}$/.test(publicKeyHex),'COSMOS_COMPRESSED_KEY_REQUIRED');const pub=Buffer.from(publicKeyHex,'hex');secp.ProjectivePoint.fromHex(pub);
  need(cosmosAddress(publicKeyHex,p.hrp)===p.networkFrom,'COSMOS_SIGNER_MISMATCH');
  const coin=(denom,amount)=>Buffer.concat([str(1,denom),str(2,amount)]);
  const msg=Buffer.concat([str(1,p.networkFrom),str(2,p.to),bytes(3,coin(p.denom,p.amountAtomic))]);
  const body=Buffer.concat([bytes(1,anyMessage('/cosmos.bank.v1beta1.MsgSend',msg)),...(p.memo?[str(2,p.memo)]:[]),num(3,BigInt(p.timeoutHeight))]);
  const single=num(1,1n),mode=bytes(1,single);
  const signer=Buffer.concat([bytes(1,anyMessage('/cosmos.crypto.secp256k1.PubKey',bytes(1,pub))),bytes(2,mode),num(3,BigInt(p.sequence))]);
  const fee=Buffer.concat([bytes(1,coin(p.feeDenom,p.feeAtomic)),num(2,BigInt(p.gasLimit))]);
  const auth=Buffer.concat([bytes(1,signer),bytes(2,fee)]);
  const signDoc=Buffer.concat([bytes(1,body),bytes(2,auth),str(3,p.chainId),num(4,BigInt(p.accountNumber))]);
  return {body,auth,signDoc,digest:sha256(signDoc)};
}
export function normalizeCosmosPayment(a,r){
  shape(r,['requestKey','chainId','hrp','to','denom','amountAtomic','feeDenom','feeAtomic','gasLimit','accountNumber','sequence','timeoutHeight','acknowledgeUnverifiedState'],['memo']);
  need(a.family==='cosmos'&&a.kind==='local','COSMOS_LOCAL_ACCOUNT_REQUIRED');
  need(typeof r.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey),'PAYMENT_KEY_INVALID');
  need(/^realdex-local-[a-z0-9-]{1,32}$/.test(r.chainId),'COSMOS_LOCAL_CHAIN_ID_REQUIRED');
  need(/^[a-z][a-z0-9]{1,15}$/.test(r.hrp),'COSMOS_PREFIX_INVALID');need(r.acknowledgeUnverifiedState===true,'UNVERIFIED_STATE_ACK_REQUIRED');
  const networkFrom=accountAddress(r.hrp,decodeAccountAddress(a.address,'cosmos')),to=accountAddress(r.hrp,decodeAccountAddress(r.to,r.hrp));need(to!==networkFrom,'SELF_TRANSFER_FORBIDDEN');
  for(const d of [r.denom,r.feeDenom])need(typeof d==='string'&&/^[a-zA-Z][a-zA-Z0-9/:._-]{2,127}$/.test(d),'COSMOS_DENOM_INVALID');
  const amount=uint(r.amountAtomic),fee=uint(r.feeAtomic);need(amount>0n&&fee>0n,'COSMOS_AMOUNT_OR_FEE_ZERO');
  const gas=uint(r.gasLimit,10000000n);need(gas>0n,'COSMOS_GAS_LIMIT_INVALID');
  const accountNumber=String(uint(r.accountNumber,U64)),sequence=String(uint(r.sequence,U64)),timeoutHeight=String(uint(r.timeoutHeight,U64));need(BigInt(timeoutHeight)>0n,'COSMOS_TIMEOUT_REQUIRED');
  const memo=r.memo??'';if(memo)text(memo,128);need(Buffer.byteLength(memo)<=128,'COSMOS_MEMO_LIMIT');
  const p={family:'cosmos',networkId:'cosmos:'+r.chainId,chainId:r.chainId,hrp:r.hrp,accountId:a.id,from:a.address,networkFrom,to,denom:r.denom,amountAtomic:String(amount),feeDenom:r.feeDenom,feeAtomic:String(fee),gasLimit:String(gas),accountNumber,sequence,timeoutHeight,memo};
  return {...p,requestKey:r.requestKey,paymentHash:fingerprint(p)};
}
export function prepareCosmosOffline(a,r,now=Date.now()){
  const p=normalizeCosmosPayment(a,r),createdAt=now,expiresAt=now+60000;
  const intent={family:'cosmos',accountId:a.id,networkId:p.networkId,payment:p,createdAt,expiresAt,salt:randomUUID(),summary:{family:'cosmos',operation:'cosmos-bank-send-offline',networkId:p.networkId,from:a.address,networkFrom:p.networkFrom,recipient:p.to,amountAtomic:p.amountAtomic,asset:p.denom,feeAtomic:p.feeAtomic,feeAsset:p.feeDenom,transfer:p,sequenceKey:canonical([p.chainId,p.from,p.accountNumber,p.sequence]),requestKey:p.requestKey,paymentHash:p.paymentHash,submissionEnabled:false,onChainStateVerified:false,expiresAt}};
  intent.id=fingerprint(intent);return freeze(intent);
}
export function signCosmosPayment(secret,p){
  const info=keyInfo('cosmos',secret);need(info.address===p.from,'COSMOS_SIGNER_MISMATCH');const tx=cosmosTransaction(p,info.publicKeyHex),signature=Buffer.from(signDigest(secret,tx.digest).toCompactRawBytes());
  const raw=Buffer.concat([bytes(1,tx.body),bytes(2,tx.auth),bytes(3,signature)]);
  return {format:'cosmos-sdk-direct-bank-send',signature:signature.toString('base64'),publicKeyHex:info.publicKeyHex,signDocHex:tx.signDoc.toString('hex'),txRawBase64:raw.toString('base64'),requestId:sha256(raw).toString('hex').toUpperCase(),networkChainIdInSignDoc:p.chainId};
}
export function verifyCosmosSigned(s,summary){
  shape(s,['format','signature','publicKeyHex','signDocHex','txRawBase64','requestId','networkChainIdInSignDoc']);need(s.format==='cosmos-sdk-direct-bank-send','COSMOS_FORMAT_INVALID');
  const p=summary.transfer,tx=cosmosTransaction(p,s.publicKeyHex),signature=canonicalBase64(s.signature,64);need(signature.length===64&&s.networkChainIdInSignDoc===p.chainId&&cosmosAddress(s.publicKeyHex)===summary.from,'COSMOS_SIGNATURE_BINDING');
  const raw=Buffer.concat([bytes(1,tx.body),bytes(2,tx.auth),bytes(3,signature)]);
  need(s.signDocHex===tx.signDoc.toString('hex')&&s.txRawBase64===raw.toString('base64')&&s.requestId===sha256(raw).toString('hex').toUpperCase()&&secp.verify(signature,tx.digest,Buffer.from(s.publicKeyHex,'hex'),{lowS:true}),'COSMOS_SIGNATURE_INVALID');return true;
}
export async function signCosmosOffline(vault,intent,{now=Date.now,authorize=()=>{}}={}){
  const {id,...rest}=intent;need(fingerprint(rest)===id&&now()>=intent.createdAt&&now()<intent.expiresAt,'COSMOS_INTENT_INVALID_OR_EXPIRED');
  return vault.signNonEvmAndRecord(intent,secret=>{authorize();need(now()<intent.expiresAt,'COSMOS_INTENT_EXPIRED');return signCosmosPayment(secret,intent.payment);});
}
