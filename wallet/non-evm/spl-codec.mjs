/** Classic SPL Token only: a single TransferChecked, no extensions or arbitrary instructions. */
import {createPublicKey, verify} from 'node:crypto';
import {need, shape, uint} from '../lib/guard.mjs';
import {base58Decode, base58Encode, keyInfo, signEd25519, sha256} from '../lib/keys.mjs';
import {canonicalBase64} from './solana-codec.mjs';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';
const U64 = (1n << 64n) - 1n;
export function splTransferMessage(t) {
  shape(t, ['from','source','destination','mint','amountAtomic','decimals','recentBlockhash']);
  const keys=[t.from,t.source,t.destination,t.mint,TOKEN_PROGRAM];
  need(new Set(keys).size===keys.length && t.mint!==NATIVE_MINT,'SPL_ACCOUNT_ALIAS_OR_NATIVE_MINT');
  need(Number.isInteger(t.decimals)&&t.decimals>=0&&t.decimals<=18,'SPL_DECIMALS_UNSUPPORTED');
  const amount=uint(t.amountAtomic,U64); need(amount>0n,'SPL_AMOUNT_ZERO');
  const data=Buffer.alloc(10);data[0]=12;data.writeBigUInt64LE(amount,1);data[9]=t.decimals;
  return Buffer.concat([Buffer.from([1,0,2,5]),...keys.map(k=>base58Decode(k,32)),base58Decode(t.recentBlockhash,32),Buffer.from([1,4,4,1,3,2,0,10]),data]);
}
export const unsignedSplTransfer=t=>Buffer.concat([Buffer.from([1]),Buffer.alloc(64),splTransferMessage(t)]).toString('base64');
export function signSplTransfer(secret,t) {
  need(keyInfo('solana',secret).address===t.from,'SIGNER_ADDRESS_MISMATCH');
  const message=splTransferMessage(t),signature=signEd25519(secret,message);
  return {format:'solana-legacy-spl-transfer-checked',signature:base58Encode(signature),transactionBase64:Buffer.concat([Buffer.from([1]),signature,message]).toString('base64'),messageHex:message.toString('hex'),networkNotBoundByChainId:true};
}
export function parseSignedSplTransfer(encoded) {
  const raw=canonicalBase64(encoded);need(raw.length===279 && raw[0]===1,'SPL_TRANSFER_FORMAT_REQUIRED');
  const signature=raw.subarray(1,65),m=raw.subarray(65);
  const key=i=>base58Encode(m.subarray(4+32*i,36+32*i));
  const transfer={from:key(0),source:key(1),destination:key(2),mint:key(3),recentBlockhash:base58Encode(m.subarray(164,196)),amountAtomic:String(m.readBigUInt64LE(205)),decimals:m[213]};
  need(splTransferMessage(transfer).equals(m),'SPL_NONCANONICAL_TRANSFER');
  const pub=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),base58Decode(transfer.from,32)]),format:'der',type:'spki'});
  need(verify(null,m,pub,signature),'SOLANA_SIGNATURE_INVALID');
  return {transfer,signature:base58Encode(signature),messageHex:m.toString('hex'),messageHash:sha256(m).toString('hex')};
}
function dataOf(a,len) {
  need(a&&a.owner===TOKEN_PROGRAM&&a.executable===false&&Array.isArray(a.data)&&a.data.length===2&&a.data[1]==='base64','SPL_PROGRAM_OWNER_INVALID');
  const b=canonicalBase64(a.data[0],1024);need(b.length===len,'SPL_EXTENSIONS_OR_LAYOUT_UNSUPPORTED');return b;
}
function option(b,offset,kind='key') {
  const tag=b.readUInt32LE(offset);need(tag===0||tag===1,'SPL_OPTION_INVALID');
  return tag===0?null:kind==='key'?base58Encode(b.subarray(offset+4,offset+36)):String(b.readBigUInt64LE(offset+4));
}
export function decodeSplMint(a) {
  const b=dataOf(a,82);need(b[45]===1,'SPL_MINT_NOT_INITIALIZED');need(b[44]<=18,'SPL_DECIMALS_UNSUPPORTED');
  return {decimals:b[44],supply:String(b.readBigUInt64LE(36)),mintAuthority:option(b,0),freezeAuthority:option(b,46)};
}
export function decodeSplAccount(a) {
  const b=dataOf(a,165);need(b[108]===1,'SPL_ACCOUNT_FROZEN_OR_UNINITIALIZED');
  const out={mint:base58Encode(b.subarray(0,32)),owner:base58Encode(b.subarray(32,64)),amountAtomic:String(b.readBigUInt64LE(64)),delegate:option(b,72),nativeReserve:option(b,109,'u64'),delegatedAmount:String(b.readBigUInt64LE(121)),closeAuthority:option(b,129)};
  need(out.nativeReserve===null&&out.mint!==NATIVE_MINT,'SPL_WRAPPED_SOL_UNSUPPORTED');
  // Conservative first implementation: refuse accounts with delegated spending/closure rights.
  need(out.delegate===null&&out.delegatedAmount==='0'&&out.closeAuthority===null,'SPL_EXTERNAL_AUTHORITY_UNSUPPORTED');
  return out;
}
