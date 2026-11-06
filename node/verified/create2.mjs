import {need,integer,exact} from '../shared/protocol-core.mjs';
import {keccak256,address,fromHex} from './keccak.mjs';

/** EIP-1014 deterministic address calculator ONLY. Does not authenticate supplied
 * creation code, prove a historical deployment, query an RPC or grant execution.
 * This helper's init-code cap is 49152 bytes; chain capability remains separate.
 * Reference: https://eips.ethereum.org/EIPS/eip-1014 */
export function deriveCreate2Address(factory,salt,initCode) {
  factory=address(factory,true);
  need(typeof salt==='string' && /^0x[0-9a-fA-F]{64}$/.test(salt),'CREATE2_SALT_INVALID');
  need(typeof initCode==='string' && fromHex(initCode).length<=49152,'CREATE2_INITCODE_INVALID');
  return '0x'+keccak256('0xff'+factory.slice(2)+salt.slice(2)+keccak256(initCode).slice(2)).slice(-40);
}
/** LocalSwapFactory v1 uses packed token0/token1/uint256(fee) for the salt and
 * ABI-encoded constructor arguments. Only a caller-owned independently compiled
 * Pool creation artifact may be supplied. Peers must never choose this artifact.
 * The current observer intentionally DOES NOT promote this calculation to proof.
 */
export function deriveLocalPoolAddress(input) {
  exact(input,['chainId','factory','tokenA','tokenB','feeBps','poolCreationCode'],'POOL_DERIVATION_INVALID');
  need(typeof input.chainId==='string' && /^eip155:[1-9][0-9]{0,19}$/.test(input.chainId),'CHAIN_ID_INVALID');
  const factory=address(input.factory),tokens=[address(input.tokenA),address(input.tokenB)].sort();need(tokens[0]!==tokens[1],'TOKEN_PAIR_INVALID');
  integer(input.feeBps,1,100,'FEE_TIERS_INVALID');
  need(typeof input.poolCreationCode==='string' && fromHex(input.poolCreationCode).length>0 && fromHex(input.poolCreationCode).length+96<=49152,'POOL_CREATION_CODE_INVALID');
  const feeWord=BigInt(input.feeBps).toString(16).padStart(64,'0');
  const salt=keccak256('0x'+tokens[0].slice(2)+tokens[1].slice(2)+feeWord);
  const initCode=input.poolCreationCode+tokens[0].slice(2).padStart(64,'0')+tokens[1].slice(2).padStart(64,'0')+feeWord;
  return Object.freeze({schema:'realdex.create2-derivation.v1',chainId:input.chainId,factory,token0:tokens[0],token1:tokens[1],feeBps:input.feeBps,
    expectedPool:deriveCreate2Address(factory,salt,initCode),salt,initCodeHash:keccak256(initCode),
    creationCodeAuthenticated:false,deploymentProven:false,executable:false});
}
