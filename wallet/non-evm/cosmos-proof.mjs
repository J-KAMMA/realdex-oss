/** CometBFT transaction inclusion only. This does NOT verify header votes or app state. */
import {createHash} from 'node:crypto';
import {need,shape} from '../lib/guard.mjs';
import {cosmosInt,cosmosHash} from './cosmos-network.mjs';
export const cosmosSha256=b=>createHash('sha256').update(b).digest();
const leaf=b=>cosmosSha256(Buffer.concat([Buffer.from([0]),b]));
const inner=(a,b)=>cosmosSha256(Buffer.concat([Buffer.from([1]),a,b]));
function b64(s,size){need(typeof s==='string'&&s.length<=32768,'COSMOS_PROOF_BYTES');const b=Buffer.from(s,'base64');need(b.toString('base64')===s&&(size===undefined||b.length===size),'COSMOS_PROOF_BYTES');return b;}
function split(n){let k=1;while(k*2<n)k*=2;return k;}
export function verifyCosmosInclusion(raw, proof, expectedRoot, expectedIndex) {
  need(Buffer.isBuffer(raw)&&raw.length>0&&raw.length<=16384,'COSMOS_TX_BYTES_INVALID');
  shape(proof,['root_hash','data','proof']);shape(proof.proof,['total','index','leaf_hash','aunts']);
  const p=proof.proof,total=cosmosInt(p.total,1000000),index=cosmosInt(p.index,1000000);
  need(total>0&&index<total&&index===expectedIndex&&Array.isArray(p.aunts)&&p.aunts.length<=20,'COSMOS_PROOF_POSITION_INVALID');
  need(b64(proof.data).equals(raw),'COSMOS_PROOF_TRANSACTION_MISMATCH');
  // CometBFT hashes each transaction before placing it in the simple Merkle tree.
  const ownLeaf=leaf(cosmosSha256(raw)); need(b64(p.leaf_hash,32).equals(ownLeaf),'COSMOS_PROOF_LEAF_MISMATCH');
  const aunts=p.aunts.map(s=>b64(s,32));
  function root(i,n,pos) {
    if(n===1){need(i===0&&pos===-1,'COSMOS_PROOF_LENGTH_INVALID');return ownLeaf;}
    need(pos>=0,'COSMOS_PROOF_LENGTH_INVALID');const k=split(n);
    return i<k?inner(root(i,k,pos-1),aunts[pos]):inner(aunts[pos],root(i-k,n-k,pos-1));
  }
  const computed=root(index,total,aunts.length-1).toString('hex').toUpperCase();
  need(computed===cosmosHash(proof.root_hash)&&computed===cosmosHash(expectedRoot),'COSMOS_PROOF_ROOT_MISMATCH');
  return {inclusionVerified:true,total,index,rootHash:computed};
}
