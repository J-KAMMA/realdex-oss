/** Regtest-only, self-owned native SegWit P2WPKH. SIGHASH_ALL; no arbitrary scripts/PSBT. */
import {randomUUID,createHash} from 'node:crypto';
import {need,shape,uint,hex,canonical,freeze} from '../lib/guard.mjs';
import {keyInfo,sha256,signDigest} from '../lib/keys.mjs';
import {decodeWitnessAddress,witnessAddress} from '../codec/bech32.mjs';
import {fingerprint} from './solana-codec.mjs';
import * as secp from '../vendor/noble-secp256k1.mjs';
export const BITCOIN_MAX_MONEY=21000000n*100000000n;
const MAX_INPUTS=16,VERSION=2,SEQUENCE=0xffffffff,LOCKTIME=0;
export const hash256=b=>sha256(sha256(b));
const hash160=b=>createHash('ripemd160').update(sha256(b)).digest();
const u32=n=>{need(Number.isInteger(n)&&n>=0&&n<=0xffffffff,'BTC_UINT32');const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;};
const u64=n=>{need(typeof n==='bigint'&&n>=0n&&n<=BITCOIN_MAX_MONEY,'BTC_MONEY_RANGE');const b=Buffer.alloc(8);b.writeBigUInt64LE(n);return b;};
export function compactSize(n){need(Number.isSafeInteger(n)&&n>=0&&n<=65535,'BTC_VECTOR_LIMIT');if(n<253)return Buffer.from([n]);const b=Buffer.alloc(3);b[0]=253;b.writeUInt16LE(n,1);return b;}
const vector=b=>Buffer.concat([compactSize(b.length),b]);
const prevout=i=>Buffer.concat([Buffer.from(hex(i.txid,32,false)).reverse(),u32(i.vout)]);
const output=o=>Buffer.concat([u64(BigInt(o.amountAtomic)),vector(hex(o.scriptHex,undefined,false))]);
/** BIP143 digest helper is generic for published vector comparison; owner signer below is restrictive. */
export function bip143Digest(tx,index,scriptCode,value){
  need(Number.isInteger(index)&&index>=0&&index<tx.inputs.length,'BTC_INPUT_INDEX');const i=tx.inputs[index];
  return hash256(Buffer.concat([u32(tx.version),hash256(Buffer.concat(tx.inputs.map(prevout))),hash256(Buffer.concat(tx.inputs.map(x=>u32(x.sequence)))),prevout(i),vector(scriptCode),u64(BigInt(value)),u32(i.sequence),hash256(Buffer.concat(tx.outputs.map(output))),u32(tx.locktime),u32(1)]));
}
const scriptForAddress=a=>Buffer.concat([Buffer.from([0,20]),decodeWitnessAddress(a,'bcrt')]);
const derInteger=n=>{let h=n.toString(16);if(h.length%2)h='0'+h;let b=Buffer.from(h,'hex');if(b[0]&128)b=Buffer.concat([Buffer.from([0]),b]);return Buffer.concat([Buffer.from([2,b.length]),b]);};
export function signatureDER(r,s){const b=Buffer.concat([derInteger(r),derInteger(s)]);return Buffer.concat([Buffer.from([0x30,b.length]),b]);}
function compactFromDER(b){
  need(b.length>=8&&b.length<=72&&b[0]===0x30&&b[1]===b.length-2,'BTC_DER_INVALID');let pos=2;const parts=[];
  for(let n=0;n<2;n++){need(b[pos++]===2,'BTC_DER_INVALID');const len=b[pos++];need(len>=1&&len<=33&&pos+len<=b.length,'BTC_DER_INVALID');const v=b.subarray(pos,pos+len);pos+=len;need(!(v[0]&128)&&!(len>1&&v[0]===0&&!(v[1]&128)),'BTC_DER_NONCANONICAL');const x=BigInt('0x'+v.toString('hex'));need(x>0n&&x<secp.CURVE.n,'BTC_SIGNATURE_RANGE');parts.push(x);}
  need(pos===b.length&&parts[1]<=secp.CURVE.n/2n,'BTC_SIGNATURE_HIGH_S');return Buffer.concat(parts.map(n=>Buffer.from(n.toString(16).padStart(64,'0'),'hex')));
}
function serialize(tx,witnesses){
  const inputs=Buffer.concat(tx.inputs.map(i=>Buffer.concat([prevout(i),Buffer.from([0]),u32(i.sequence)]))),outputs=Buffer.concat(tx.outputs.map(output));
  return Buffer.concat([u32(tx.version),...(witnesses?[Buffer.from([0,1])]:[]),compactSize(tx.inputs.length),inputs,compactSize(tx.outputs.length),outputs,...(witnesses?[Buffer.concat(witnesses.map(w=>Buffer.concat([compactSize(w.length),...w.map(vector)])))]:[]),u32(tx.locktime)]);
}
export function normalizeBitcoinPayment(a,r){
  shape(r,['requestKey','networkId','to','amountAtomic','feeAtomic','maxFeeRateSatVb','utxos','acknowledgeUnverifiedState']);
  need(a.family==='bitcoin'&&a.kind==='local','BITCOIN_LOCAL_ACCOUNT_REQUIRED');need(r.networkId==='bitcoin:regtest','BITCOIN_REGTEST_ONLY');
  need(typeof r.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey),'PAYMENT_KEY_INVALID');need(r.acknowledgeUnverifiedState===true,'UNVERIFIED_STATE_ACK_REQUIRED');
  const to=witnessAddress('bcrt',decodeWitnessAddress(r.to,'bcrt'));need(to!==a.address,'SELF_TRANSFER_FORBIDDEN');
  const amount=uint(r.amountAtomic,BITCOIN_MAX_MONEY),fee=uint(r.feeAtomic,1000000n),maxRate=uint(r.maxFeeRateSatVb,10000n);need(amount>=330n&&fee>0n&&maxRate>0n,'BITCOIN_AMOUNT_OR_FEE_INVALID');
  need(Array.isArray(r.utxos)&&r.utxos.length>=1&&r.utxos.length<=MAX_INPUTS,'BITCOIN_UTXO_LIMIT');
  const owned=scriptForAddress(a.address).toString('hex'),utxos=r.utxos.map(i=>{shape(i,['txid','vout','amountAtomic','scriptHex']);hex(i.txid,32,false);need(/^[0-9a-f]{64}$/.test(i.txid)&&!/^0{64}$/.test(i.txid),'BITCOIN_TXID_INVALID');u32(i.vout);need(i.scriptHex===owned,'BITCOIN_UTXO_NOT_OWNED');const value=uint(i.amountAtomic,BITCOIN_MAX_MONEY);need(value>0n,'BITCOIN_ZERO_UTXO');return {...i,amountAtomic:String(value)};}).sort((a,b)=>a.txid.localeCompare(b.txid)||a.vout-b.vout);
  need(new Set(utxos.map(i=>i.txid+':'+i.vout)).size===utxos.length,'BITCOIN_DUPLICATE_OUTPOINT');
  const total=utxos.reduce((s,i)=>s+BigInt(i.amountAtomic),0n);need(total<=BITCOIN_MAX_MONEY&&total>=amount+fee,'BITCOIN_INSUFFICIENT_INPUT');
  const change=total-amount-fee;need(change===0n||change>=330n,'BITCOIN_CHANGE_BELOW_POLICY_MINIMUM');
  const p={family:'bitcoin',networkId:r.networkId,accountId:a.id,from:a.address,to,amountAtomic:String(amount),feeAtomic:String(fee),maxFeeRateSatVb:String(maxRate),utxos,changeAtomic:String(change),changeAddress:a.address,version:VERSION,sequence:SEQUENCE,locktime:LOCKTIME};
  const tx=bitcoinTransaction(p);const base=serialize(tx).length;
  // Lower bound on vsize prevents cap overflow for any canonical DER length, without signing first.
  const minimumVsize=Math.ceil((base*4+2+utxos.length*(1+1+9+1+33))/4);
  need(fee<=maxRate*BigInt(minimumVsize),'BITCOIN_FEE_RATE_CAP');
  return {...p,requestKey:r.requestKey,paymentHash:fingerprint(p)};
}
export function bitcoinTransaction(p){return {version:VERSION,inputs:p.utxos.map(i=>({...i,sequence:SEQUENCE})),outputs:[{amountAtomic:p.amountAtomic,scriptHex:scriptForAddress(p.to).toString('hex')},...(BigInt(p.changeAtomic)>0n?[{amountAtomic:p.changeAtomic,scriptHex:scriptForAddress(p.from).toString('hex')}]:[])],locktime:LOCKTIME};}
export function prepareBitcoinOffline(a,r,now=Date.now()){
  const payment=normalizeBitcoinPayment(a,r),expiresAt=now+60000;
  const intent={family:'bitcoin',accountId:a.id,networkId:payment.networkId,payment,createdAt:now,expiresAt,salt:randomUUID(),summary:{family:'bitcoin',operation:'bitcoin-p2wpkh-offline',networkId:payment.networkId,from:a.address,recipient:payment.to,amountAtomic:payment.amountAtomic,asset:'BTC-regtest',decimals:8,feeAtomic:payment.feeAtomic,feeAsset:'BTC-regtest',totalDebitAtomic:String(BigInt(payment.amountAtomic)+BigInt(payment.feeAtomic)),transfer:payment,outpoints:payment.utxos.map(i=>i.txid+':'+i.vout),requestKey:payment.requestKey,paymentHash:payment.paymentHash,submissionEnabled:false,onChainStateVerified:false,expiresAt}};
  intent.id=fingerprint(intent);return freeze(intent);
}
export function signBitcoinPayment(secret,p){
  const info=keyInfo('bitcoin',secret);need(info.address===p.from,'BITCOIN_SIGNER_MISMATCH');const pub=Buffer.from(info.publicKeyHex,'hex');const code=Buffer.concat([Buffer.from('76a914','hex'),hash160(pub),Buffer.from('88ac','hex')]);const tx=bitcoinTransaction(p);
  const witnesses=tx.inputs.map((i,n)=>{const d=bip143Digest(tx,n,code,i.amountAtomic),sig=signDigest(secret,d);return [Buffer.concat([signatureDER(sig.r,sig.s),Buffer.from([1])]),pub];});
  const raw=serialize(tx,witnesses),stripped=serialize(tx),vsize=Math.ceil((stripped.length*3+raw.length)/4);
  need(BigInt(p.feeAtomic)<=BigInt(p.maxFeeRateSatVb)*BigInt(vsize),'BITCOIN_FEE_RATE_CAP');
  return {format:'bitcoin-regtest-p2wpkh-sighash-all',rawTransactionHex:raw.toString('hex'),requestId:Buffer.from(hash256(stripped)).reverse().toString('hex'),wtxid:Buffer.from(hash256(raw)).reverse().toString('hex'),publicKeyHex:pub.toString('hex'),vsize,sighashType:1,networkNotBoundByChainId:true};
}
/** Validate supplied bytes against the reviewed transaction, not an untrusted RPC decode. */
export function verifyBitcoinSigned(s,summary){
  shape(s,['format','rawTransactionHex','requestId','wtxid','publicKeyHex','vsize','sighashType','networkNotBoundByChainId']);
  need(s.format==='bitcoin-regtest-p2wpkh-sighash-all'&&s.sighashType===1&&s.networkNotBoundByChainId===true&&/^(02|03)[0-9a-f]{64}$/.test(s.publicKeyHex),'BITCOIN_SIGNATURE_FORMAT');
  const pub=Buffer.from(s.publicKeyHex,'hex'),p=summary.transfer,tx=bitcoinTransaction(p),stripped=serialize(tx),raw=hex(s.rawTransactionHex,undefined,false);
  need(raw.length<=10000&&witnessAddress('bcrt',hash160(pub))===summary.from,'BITCOIN_SIGNER_MISMATCH');
  const noWitnessTail=stripped.subarray(0,-4); // compare version + all inputs/outputs, including counts
  need(raw.subarray(0,4).equals(noWitnessTail.subarray(0,4))&&raw[4]===0&&raw[5]===1&&raw.subarray(6,6+noWitnessTail.length-4).equals(noWitnessTail.subarray(4)),'BITCOIN_TRANSACTION_CHANGED');
  let pos=noWitnessTail.length+2;const witnesses=[],code=Buffer.concat([Buffer.from('76a914','hex'),hash160(pub),Buffer.from('88ac','hex')]);
  for(let i=0;i<tx.inputs.length;i++){
    need(raw[pos++]===2,'BITCOIN_WITNESS_INVALID');const len=raw[pos++];need(len>=9&&len<=73&&pos+len+34<=raw.length,'BITCOIN_WITNESS_INVALID');const sig=raw.subarray(pos,pos+len);pos+=len;
    need(sig.at(-1)===1&&raw[pos++]===33,'BITCOIN_SIGHASH_UNSUPPORTED');const pk=raw.subarray(pos,pos+33);pos+=33;need(pk.equals(pub),'BITCOIN_WITNESS_KEY_MISMATCH');
    need(secp.verify(compactFromDER(sig.subarray(0,-1)),bip143Digest(tx,i,code,tx.inputs[i].amountAtomic),pub,{lowS:true}),'BITCOIN_SIGNATURE_INVALID');witnesses.push([sig,pk]);
  }
  need(pos+4===raw.length&&raw.subarray(pos).equals(u32(LOCKTIME))&&serialize(tx,witnesses).equals(raw),'BITCOIN_TRAILING_OR_CHANGED_BYTES');
  const vsize=Math.ceil((stripped.length*3+raw.length)/4);
  need(s.requestId===Buffer.from(hash256(stripped)).reverse().toString('hex')&&s.wtxid===Buffer.from(hash256(raw)).reverse().toString('hex')&&s.vsize===vsize&&BigInt(p.feeAtomic)<=BigInt(p.maxFeeRateSatVb)*BigInt(vsize),'BITCOIN_TXID_OR_FEE_MISMATCH');return true;
}
export async function signBitcoinOffline(vault,intent,{now=Date.now,authorize=()=>{}}={}){
  const {id,...rest}=intent;need(fingerprint(rest)===id&&now()>=intent.createdAt&&now()<intent.expiresAt,'BITCOIN_INTENT_INVALID_OR_EXPIRED');
  return vault.signNonEvmAndRecord(intent,secret=>{authorize();need(now()<intent.expiresAt,'BITCOIN_INTENT_EXPIRED');return signBitcoinPayment(secret,intent.payment);});
}
