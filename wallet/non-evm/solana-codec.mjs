/** Strict native-SOL transfer decoding. No arbitrary instruction signing. */
import {createPublicKey, verify} from 'node:crypto';
import {need, canonical} from '../lib/guard.mjs';
import {base58Decode, base58Encode, sha256} from '../lib/keys.mjs';
import {solanaTransferMessage} from '../lib/transactions.mjs';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const fingerprint = value => sha256(Buffer.from(canonical(value))).toString('hex');
export function canonicalBase64(s, max = 1232) {
  need(typeof s === 'string' && s.length <= Math.ceil(max / 3) * 4 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s), 'BASE64_INVALID');
  const b = Buffer.from(s, 'base64');
  need(b.toString('base64') === s && b.length <= max, 'BASE64_INVALID');
  return b;
}
export function parseSignedSolanaTransfer(encoded) {
  const raw = canonicalBase64(encoded);
  need(raw.length === 215 && raw[0] === 1, 'SOLANA_NATIVE_FORMAT_REQUIRED');
  const signature = raw.subarray(1, 65), message = raw.subarray(65);
  const from = base58Encode(message.subarray(4, 36));
  const to = base58Encode(message.subarray(36, 68));
  const recentBlockhash = base58Encode(message.subarray(100, 132));
  const lamports = String(message.readBigUInt64LE(142));
  const transfer = {from, to, lamports, recentBlockhash};
  need(solanaTransferMessage(transfer).equals(message), 'SOLANA_NONCANONICAL_TRANSFER');
  const pub = createPublicKey({key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), base58Decode(from, 32)]), format: 'der', type: 'spki'});
  need(verify(null, message, pub, signature), 'SOLANA_SIGNATURE_INVALID');
  return {transfer, signature: base58Encode(signature), transactionBase64: encoded, messageHex: message.toString('hex'), messageHash: sha256(message).toString('hex')};
}
export function unsignedSolanaTransfer(transfer) {
  const message = solanaTransferMessage(transfer);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString('base64');
}
