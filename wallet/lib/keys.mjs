import {stellarAddress,decodeStellarAddress} from '../codec/strkey.mjs';
import {accountAddress,decodeAccountAddress,witnessAddress,decodeWitnessAddress} from '../codec/bech32.mjs';
import {createECDH, createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as edSign, verify as edVerify} from 'node:crypto';
import * as secp from '../vendor/noble-secp256k1.mjs';
import {keccak256, address} from '../../node/verified/keccak.mjs';
import {principalText, principalBytes} from '../../node/icp/principal.mjs';
import {hex, need, text, hex0} from './guard.mjs';
secp.etc.hmacSha256Sync = (key, ...messages) => { const h = createHmac('sha256', key); messages.forEach(m => h.update(m)); return h.digest(); };
export const sha256 = b => createHash('sha256').update(b).digest();
export const SUPPORTED_KEY_FAMILIES = Object.freeze(['evm', 'solana', 'icp', 'bitcoin', 'cosmos', 'stellar', 'aptos']);
const ED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes) {
  const b = Buffer.from(bytes); let n = b.length ? BigInt('0x' + b.toString('hex')) : 0n, s = '';
  while (n) { s = BASE58[Number(n % 58n)] + s; n /= 58n; }
  for (const v of b) { if (v) break; s = '1' + s; } return s;
}
export function base58Decode(s, size) {
  need(typeof s === 'string' && s.length >= 1 && s.length <= 128, 'BASE58_INVALID');
  let n = 0n; for (const c of s) { const i = BASE58.indexOf(c); need(i >= 0, 'BASE58_INVALID'); n = n * 58n + BigInt(i); }
  let h = n.toString(16); if (h.length % 2) h = '0' + h;
  const b = Buffer.concat([Buffer.alloc(s.match(/^1*/)[0].length), n ? Buffer.from(h, 'hex') : Buffer.alloc(0)]);
  need(base58Encode(b) === s && (size === undefined || b.length === size), 'BASE58_LENGTH_INVALID'); return b;
}
export function edKey(seed) { need(Buffer.isBuffer(seed) && seed.length === 32, 'SEED_LENGTH_INVALID'); return createPrivateKey({key:Buffer.concat([ED_PREFIX, seed]), format:'der', type:'pkcs8'}); }
export function keyInfo(family, secret) {
  need(SUPPORTED_KEY_FAMILIES.includes(family), 'KEY_FAMILY_UNSUPPORTED'); need(Buffer.isBuffer(secret) && secret.length === 32, 'KEY_LENGTH_INVALID');
  if (['evm','bitcoin','cosmos'].includes(family)) {
    need(secp.utils.isValidPrivateKey(secret), 'PRIVATE_KEY_INVALID');
    if(family!=='evm'){const e=createECDH('secp256k1');e.setPrivateKey(secret);const publicKey=e.getPublicKey(undefined,'compressed');const hash=createHash('ripemd160').update(sha256(publicKey)).digest();return {family,address:family==='bitcoin'?witnessAddress('bcrt',hash):accountAddress('cosmos',hash),publicKeyHex:publicKey.toString('hex'),keyFormat:'secp256k1-raw-32'};}
    // Public derivation uses Node/OpenSSL independently of the signing library.
    const e = createECDH('secp256k1'); e.setPrivateKey(secret); const publicKey = e.getPublicKey(undefined, 'uncompressed');
    return {family, address:address('0x'+keccak256(publicKey.subarray(1)).slice(-40)), publicKeyHex:publicKey.toString('hex'), keyFormat:'secp256k1-raw-32'};
  }
  const key = edKey(secret), der = createPublicKey(key).export({format:'der', type:'spki'}), pub = der.subarray(-32);
  if(family==='stellar')return {family,address:stellarAddress(pub),publicKeyHex:pub.toString('hex'),keyFormat:'ed25519-seed-32'};
  if(family==='aptos')return {family,address:'0x'+createHash('sha3-256').update(Buffer.concat([pub,Buffer.from([0])])).digest('hex'),publicKeyHex:pub.toString('hex'),keyFormat:'ed25519-seed-32'};
  return {family, address:family === 'solana' ? base58Encode(pub) : principalText(Buffer.concat([createHash('sha224').update(der).digest(), Buffer.from([2])])), publicKeyHex:pub.toString('hex'), keyFormat:'ed25519-seed-32'};
}
export function generateSecret(family) {
  need(SUPPORTED_KEY_FAMILIES.includes(family), 'KEY_FAMILY_UNSUPPORTED');
  for (;;) { const secret = randomBytes(32); if (!['evm','bitcoin','cosmos'].includes(family) || secp.utils.isValidPrivateKey(secret)) return secret; secret.fill(0); }
}
export function normalizePublicAccount(family, value) {
  if (family === 'evm') return address(value);
  if (family === 'bitcoin')return witnessAddress('bcrt',decodeWitnessAddress(value,'bcrt'));
  if (family === 'cosmos')return accountAddress('cosmos',decodeAccountAddress(value,'cosmos'));
  if (family === 'solana') return base58Encode(base58Decode(value,32));
  if (family === 'stellar')return stellarAddress(decodeStellarAddress(value));
  if (family === 'aptos'){need(typeof value==='string'&&/^0x[0-9a-f]{64}$/.test(value),'APTOS_FULL_ADDRESS_REQUIRED');return value;}
  if (family === 'icp') return principalText(principalBytes(value));
  throw Error('ADDRESS_FAMILY_UNSUPPORTED');
}
export function signDigest(secret, digest, {extraEntropy = true} = {}) {
  need(Buffer.isBuffer(digest) && digest.length === 32, 'DIGEST_LENGTH_INVALID');
  const signature = secp.sign(digest, secret, {lowS:true, extraEntropy});
  need(signature.recovery < 2, 'RECOVERY_ID_UNSUPPORTED');
  const pub = secp.getPublicKey(secret); need(secp.verify(signature, digest, pub), 'SIGNATURE_SELF_CHECK_FAILED');
  need(Buffer.from(signature.recoverPublicKey(digest).toRawBytes()).equals(Buffer.from(pub)), 'RECOVERY_SELF_CHECK_FAILED');
  return signature;
}
export function signEd25519(seed, bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= 131072, 'MESSAGE_SIZE_INVALID');
  const key = edKey(seed), signature = edSign(null, bytes, key);
  need(edVerify(null, bytes, createPublicKey(key), signature), 'SIGNATURE_SELF_CHECK_FAILED'); return signature;
}
export function importSecret(family, value) {
  const b = hex(value,32,false); try { keyInfo(family,b); return b; } catch (e) { b.fill(0); throw e; }
}
/** Recover only canonical low-S signatures; public-key recovery is not authorization. */
export function recoverDigest(digest,compact,recovery) {
  need(Buffer.isBuffer(digest)&&digest.length===32&&Buffer.isBuffer(compact)&&compact.length===64&&[0,1].includes(recovery),'SIGNATURE_ENCODING_INVALID');
  const signature=secp.Signature.fromCompact(compact).addRecoveryBit(recovery);need(!signature.hasHighS(),'NONCANONICAL_SIGNATURE');
  const point=signature.recoverPublicKey(digest),pub=Buffer.from(point.toRawBytes(false));need(secp.verify(signature,digest,pub),'SIGNATURE_VERIFICATION_FAILED');
  return {publicKeyHex:pub.toString('hex'),address:address('0x'+keccak256(pub.subarray(1)).slice(-40))};
}
