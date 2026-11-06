import {need, shape, text, uint, freeze} from '../lib/guard.mjs';
import {base58Decode} from '../lib/keys.mjs';
import {TOKEN_PROGRAM,NATIVE_MINT} from './spl-codec.mjs';
import {fingerprint} from './solana-codec.mjs';
/** No public endpoints are enabled in this development profile. Local RPC is still a trust assumption. */
export function validateSolanaNetwork(raw) {
  shape(raw, ['id', 'name', 'family', 'cluster', 'genesisHash', 'rpcUrls', 'broadcastEnabled', 'maxFeeLamports', 'maxTransferLamports'],['splTokens']);
  need(raw.family === 'solana' && raw.cluster === 'localnet', 'SOLANA_LOCALNET_ONLY');
  need(typeof raw.id === 'string' && /^solana-local:[a-z0-9-]{1,40}$/.test(raw.id), 'SOLANA_NETWORK_ID_INVALID');
  text(raw.name); base58Decode(raw.genesisHash, 32);
  need(base58Decode(raw.genesisHash, 32).some(Boolean), 'SOLANA_GENESIS_PIN_REQUIRED');
  need(Array.isArray(raw.rpcUrls) && raw.rpcUrls.length >= 2 && raw.rpcUrls.length <= 4, 'TWO_TO_FOUR_RPC_REQUIRED');
  const rpcUrls = raw.rpcUrls.map(s => {
    text(s, 512); let u; try {u = new URL(s);} catch {throw Error('RPC_URL_INVALID');}
    need(u.protocol === 'http:' && u.hostname === '127.0.0.1' && !u.username && !u.password && !u.search && !u.hash, 'SOLANA_LOOPBACK_RPC_REQUIRED');
    return u.href;
  });
  need(new Set(rpcUrls).size === rpcUrls.length, 'DUPLICATE_RPC');
  const maxFeeLamports = String(uint(raw.maxFeeLamports, 1000000000n));
  const maxTransferLamports = String(uint(raw.maxTransferLamports, BigInt(Number.MAX_SAFE_INTEGER)));
  need(BigInt(maxFeeLamports) > 0n && BigInt(maxTransferLamports) > 0n && typeof raw.broadcastEnabled === 'boolean', 'SOLANA_CAP_INVALID');
  let extra={};
  if(raw.splTokens!==undefined){
    need(Array.isArray(raw.splTokens)&&raw.splTokens.length<=64,'SPL_TOKEN_LIMIT');
    const splTokens=raw.splTokens.map(t=>{shape(t,['mint','symbol','decimals','maxTransferAtomic']);base58Decode(t.mint,32);text(t.symbol,16);
      need(t.mint!==NATIVE_MINT&&t.mint!==TOKEN_PROGRAM,'SPL_MINT_INVALID');need(Number.isInteger(t.decimals)&&t.decimals>=0&&t.decimals<=18,'SPL_DECIMALS_UNSUPPORTED');
      const cap=uint(t.maxTransferAtomic,(1n<<64n)-1n);need(cap>0n,'SPL_CAP_INVALID');return {...t,maxTransferAtomic:String(cap)};});
    need(new Set(splTokens.map(t=>t.mint)).size===splTokens.length,'SPL_DUPLICATE_MINT');extra={splTokens};
  }
  return freeze({...raw, rpcUrls, maxFeeLamports, maxTransferLamports,...extra});
}
export const solanaNetworkFingerprint = n => fingerprint(validateSolanaNetwork(n));
export function safeRpcInteger(value) {
  need(Number.isSafeInteger(value) && value >= 0, 'SOLANA_RPC_INTEGER_UNSAFE'); return value;
}
