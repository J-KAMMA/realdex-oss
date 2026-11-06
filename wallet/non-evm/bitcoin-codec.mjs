/** Read-only bounded transaction/header parsing; never signs arbitrary scripts. */
import {need,hex} from '../lib/guard.mjs';
import {hash256} from './bitcoin-offline.mjs';
import {bitcoinHash} from './bitcoin-network.mjs';
const reverseHash=b=>Buffer.from(hash256(b)).reverse().toString('hex');
export function parseBitcoinTransaction(encoded){
  const b=hex(encoded,undefined,false);need(b.length>=10&&b.length<=65536,'BITCOIN_TX_SIZE');let p=0;
  const take=n=>{need(Number.isSafeInteger(n)&&n>=0&&p+n<=b.length,'BITCOIN_TX_TRUNCATED');const r=b.subarray(p,p+n);p+=n;return r;};
  const count=(max=10000)=>{const tag=take(1)[0];let n=tag;if(tag===253){n=take(2).readUInt16LE();need(n>=253,'BITCOIN_COMPACT_NONCANONICAL');}else if(tag===254){n=take(4).readUInt32LE();need(n>65535,'BITCOIN_COMPACT_NONCANONICAL');}else need(tag!==255,'BITCOIN_TX_VECTOR_LIMIT');need(n<=max,'BITCOIN_TX_VECTOR_LIMIT');return n;};
  const version=take(4);let witness=false;
  if(b[p]===0){take(1);need(take(1)[0]===1,'BITCOIN_WITNESS_FLAG');witness=true;}
  const start=p,ni=count();need(ni>0,'BITCOIN_TX_NO_INPUTS');const inputs=[];
  for(let i=0;i<ni;i++){const txid=Buffer.from(take(32)).reverse().toString('hex'),vout=take(4).readUInt32LE(),script=take(count()),sequence=take(4).readUInt32LE();inputs.push({txid,vout,scriptHex:script.toString('hex'),sequence});}
  const no=count();need(no>0,'BITCOIN_TX_NO_OUTPUTS');const outputs=[];let sum=0n;
  for(let i=0;i<no;i++){const value=take(8).readBigUInt64LE();sum+=value;need(sum<=2100000000000000n,'BITCOIN_TX_MONEY_RANGE');outputs.push({amountAtomic:String(value),scriptHex:take(count()).toString('hex')});}
  const end=p;let items=0;
  if(witness)for(let i=0;i<ni;i++){const n=count(1000);items+=n;for(let j=0;j<n;j++)take(count());}
  need(!witness||items>0,'BITCOIN_SUPERFLUOUS_WITNESS');const locktime=take(4);need(p===b.length,'BITCOIN_TX_TRAILING_BYTES');
  const stripped=Buffer.concat([version,b.subarray(start,end),locktime]);return {txid:reverseHash(stripped),wtxid:reverseHash(b),vsize:Math.ceil((stripped.length*3+b.length)/4),inputs,outputs};
}
export function verifyBitcoinBlockMembership(headerHex,blockHash,txids,txid){
  bitcoinHash(blockHash);bitcoinHash(txid);const header=hex(headerHex,80,false);need(reverseHash(header)===blockHash,'BITCOIN_HEADER_HASH_MISMATCH');
  need(Array.isArray(txids)&&txids.length>=1&&txids.length<=20000&&txids.filter(x=>x===txid).length===1,'BITCOIN_TX_NOT_IN_BLOCK');
  let layer=txids.map(x=>Buffer.from(bitcoinHash(x),'hex').reverse());need(new Set(txids).size===txids.length,'BITCOIN_DUPLICATE_BLOCK_TX');
  while(layer.length>1){const next=[];for(let i=0;i<layer.length;i+=2){const left=layer[i],right=layer[i+1]??left;need(!layer[i+1]||!left.equals(right),'BITCOIN_MUTATED_MERKLE_TREE');next.push(hash256(Buffer.concat([left,right])));}layer=next;}
  need(layer[0].equals(header.subarray(36,68)),'BITCOIN_MERKLE_ROOT_MISMATCH');return {headerHashVerified:true,transactionMerkleInclusionVerified:true,consensusVerified:false};
}
