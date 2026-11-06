/** Local Injective chain-continuity checks, NOT a light client or state proof.
 * Uses existing encrypted journal anchors; no new key, network or Vault schema.
 * A missing/pruned anchor is a rejection, never a switch to a new chain.
 */
import {need,uint} from '../lib/guard.mjs';
import {injectiveReviewFromSummary} from './codec.mjs';
const U64=(1n<<64n)-1n;
const height=value=>{const n=uint(value,U64);need(n>0n,'INJECTIVE_CONTINUITY_HEIGHT');return n;};
const timePattern=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;

export function continuityBlock(raw,chainId){
 const a=raw?.block?.header,b=raw?.sdk_block?.header;
 need(a||b,'INJECTIVE_CONTINUITY_BLOCK');
 if(a&&b)need(a.chain_id===b.chain_id&&a.height===b.height&&a.time===b.time,'INJECTIVE_CONTINUITY_BLOCK');
 const h=a??b;
 need(h.chain_id===chainId&&chainId==='injective-888','INJECTIVE_CONTINUITY_CHAIN');height(h.height);
 let hash=raw.block_id?.hash;
 if(typeof hash==='string'&&/^[a-fA-F0-9]{64}$/.test(hash))hash=hash.toLowerCase();
 else{
  need(typeof hash==='string'&&Buffer.from(hash,'base64').length===32&&Buffer.from(hash,'base64').toString('base64')===hash,'INJECTIVE_CONTINUITY_BLOCK');
  hash=Buffer.from(hash,'base64').toString('hex');
 }
 need(hash!=='0'.repeat(64)&&typeof h.time==='string'&&timePattern.test(h.time),'INJECTIVE_CONTINUITY_BLOCK');
 const timeMs=Date.parse(h.time);
 need(Number.isSafeInteger(timeMs)&&timeMs>0&&new Date(timeMs).toISOString().slice(0,19)===h.time.slice(0,19),'INJECTIVE_CONTINUITY_BLOCK');
 return {height:h.height,hash,timeMs,chainId};
}
function anchorOf(review){
 const a=review?.anchor;
 need(a&&a.chainId===review.chainId&&typeof a.hash==='string'&&/^[a-f0-9]{64}$/.test(a.hash)&&a.hash!=='0'.repeat(64)&&Number.isSafeInteger(a.timeMs)&&a.timeMs>0,'INJECTIVE_CONTINUITY_ANCHOR');
 height(a.height);return {height:a.height,hash:a.hash,timeMs:a.timeMs,chainId:a.chainId};
}
function origin(review){
 let u;try{u=new URL(review.endpoint);}catch{throw Error('INJECTIVE_CONTINUITY_ENDPOINT');}
 need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'INJECTIVE_CONTINUITY_ENDPOINT');return u.origin;
}
/** Bound network reads to three distinct anchors: current, earliest, latest.
 * The caller validates local records; all matching records affect the height floor.
 * Caller MUST supply journal records already validated by Vault.injectiveRecords().
 */
export function continuityReferences(review,records,accountId){
 need(Array.isArray(records)&&records.length<=64&&typeof accountId==='string','INJECTIVE_CONTINUITY_HISTORY');
 const own=anchorOf(review),all=[own],expectedOrigin=origin(review),account=review.account;
 let floor=height(own.height);
 for(const r of records){
  if(r.accountId!==accountId)continue;
  const historical=injectiveReviewFromSummary(r.summary),a=anchorOf(historical),old=historical.account;
  need(historical.chainId===review.chainId&&origin(historical)===expectedOrigin,'INJECTIVE_CONTINUITY_ENDPOINT');
  need(old?.address===account?.address&&old?.accountNumber===account?.accountNumber&&old?.publicKeyHex===account?.publicKeyHex,'INJECTIVE_CONTINUITY_ACCOUNT');
  all.push(a);if(height(a.height)>floor)floor=height(a.height);
  if(r.report?.received===true){const h=height(r.report.height);if(h>floor)floor=h;}
  // INJ07 retirement evidence is also a retained checkpoint, not a release of history.
  if(r.retirement){
   const c=r.retirement.check,h=height(c.height);if(h>floor)floor=h;
   all.push({height:c.height,hash:c.blockHash,timeMs:c.blockTimeMs,chainId:review.chainId});
  }
 }
 // Reject contradictions in local history even when that height is not selected.
 const byHeight=new Map();
 for(const a of all){
  const prior=byHeight.get(a.height);
  need(!prior||(prior.hash===a.hash&&prior.timeMs===a.timeMs),'INJECTIVE_CONTINUITY_HISTORY_CONFLICT');
  byHeight.set(a.height,a);
 }
 const sorted=[...byHeight.values()].sort((a,b)=>height(a.height)<height(b.height)?-1:height(a.height)>height(b.height)?1:0);
 const selected=new Map([own,sorted[0],sorted.at(-1)].map(a=>[a.height,a]));
 return {anchors:[...selected.values()],heightFloor:String(floor)};
}
/** Checked immediately before signature/save/send, and around receipt observation.
 * All errors propagate without changing the journal. No retry, retirement or reset.
 */
export async function checkInjectiveContinuity(engine,review,records,accountId,{requiredHeight,guard=()=>{}}={}){
 guard();const refs=continuityReferences(review,records,accountId);
 let observedHeight=requiredHeight;
 if(observedHeight===undefined){
  const raw=await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/latest');guard();
  const latest=continuityBlock(raw,review.chainId),now=engine.now();
  need(Number.isSafeInteger(now)&&latest.timeMs<=now+2000&&now-latest.timeMs<=30000,'INJECTIVE_CONTINUITY_STALE');observedHeight=latest.height;
 }
 need(height(observedHeight)>=height(refs.heightFloor),'INJECTIVE_CONTINUITY_ROLLBACK');
 for(const a of refs.anchors){
  guard();const raw=await engine.request(review,'/cosmos/base/tendermint/v1beta1/blocks/'+a.height);guard();
  const actual=continuityBlock(raw,review.chainId);
  need(actual.height===a.height&&actual.hash===a.hash&&actual.timeMs===a.timeMs,'INJECTIVE_CONTINUITY_ANCHOR_CHANGED');
 }
 guard();return {observedHeight,anchorsChecked:refs.anchors.length,heightFloor:refs.heightFloor};
}
