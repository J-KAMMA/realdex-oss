import {check,object,uint,text,canonical,freeze,safeError,safeEndpoint} from './core.mjs';
import {validateProfile,capabilities} from './registry.mjs';
import {createChainReader} from './adapters.mjs';
const DEFAULTS={maxHeadGap:64,ttlMs:30000,maxAgeMs:600000,confirmationDepth:1,totalTimeoutMs:60000};
function policyFor(p,raw){object(raw,'POLICY_INVALID');check(Object.keys(raw).every(k=>Object.hasOwn(DEFAULTS,k)),'POLICY_INVALID');
 const policy={...DEFAULTS,confirmationDepth:['evm','tezos'].includes(p.family)?2:p.family==='bitcoin'?6:1,maxAgeMs:p.family==='bitcoin'?7200000:600000,...raw};
 for(const [k,v]of Object.entries(policy))check(Number.isSafeInteger(v)&&v>= (k==='maxHeadGap'?0:1),'POLICY_INVALID');
 check(policy.maxHeadGap<=1024&&policy.ttlMs<=60000&&policy.maxAgeMs<=86400000&&policy.confirmationDepth<=128&&policy.totalTimeoutMs<=120000,'POLICY_INVALID');return policy;}
function same(values,code){const first=canonical(values[0]);check(values.every(v=>canonical(v)===first),code);return values[0];}
/** A one-shot, bounded, multi-RPC observation, never an execution authorization.
 * No majority vote: every configured reader must agree on the same anchor. */
export async function observeChain({profile,endpoints,genesisPin,policy={},signal,fetchImpl=globalThis.fetch,now=Date.now}) {
 const p=validateProfile(profile),rules=policyFor(p,policy);
 check(p.status!=='deprecated','CHAIN_DEPRECATED');
 check(Array.isArray(endpoints)&&endpoints.length>=2&&endpoints.length<=4,'TWO_TO_FOUR_ENDPOINTS_REQUIRED');
 const config=endpoints.map(e=>typeof e==='string'?{url:e}:structuredClone(object(e,'ENDPOINT_CONFIG_INVALID')));
 config.forEach(c=>check(Object.keys(c).every(k=>['url','headers'].includes(k)),'ENDPOINT_CONFIG_INVALID'));
 const origins=config.map(e=>safeEndpoint(e.url).origin);check(new Set(origins).size===origins.length,'DISTINCT_RPC_ORIGINS_REQUIRED');
 const pin=genesisPin??p.genesisHash;if(pin!==null)text(pin,128);
 check(!p.genesisHash||!genesisPin||p.genesisHash===genesisPin,'PROFILE_PIN_CONFLICT');
 check(!capabilities(p).identityPinRequired||pin!==null,'GENESIS_PIN_REQUIRED');
 const joined=signal?AbortSignal.any([signal,AbortSignal.timeout(rules.totalTimeoutMs)]):AbortSignal.timeout(rules.totalTimeoutMs);
 let last=0;const clock=()=>{joined.throwIfAborted();const t=now();check(Number.isSafeInteger(t)&&t>0&&t<=Number.MAX_SAFE_INTEGER-rules.ttlMs,'CLOCK_INVALID');check(t>=last,'CLOCK_MOVED_BACKWARDS');last=t;return t;};clock();
 const readers=config.map(c=>createChainReader(p,c.url,{headers:c.headers,signal:joined,fetchImpl}));
 const identities=await Promise.all(readers.map(r=>r.identity()));clock();const id=same(identities,'RPC_IDENTITY_DISAGREEMENT');
 if(p.rpcIdentity!==null&&!['solana'].includes(p.family))check(id.network===p.rpcIdentity,'NETWORK_IDENTITY_MISMATCH');
 if(pin!==null)check(id.genesisHash===pin,'GENESIS_PIN_MISMATCH');
 const heads=await Promise.all(readers.map(r=>r.tip()));clock();const heights=heads.map(h=>uint(h.height));
 const low=heights.reduce((a,b)=>a<b?a:b),high=heights.reduce((a,b)=>a>b?a:b);check(high-low<=BigInt(rules.maxHeadGap),'RPC_HEAD_GAP');
 check(low>=BigInt(rules.confirmationDepth-1),'INSUFFICIENT_CONFIRMATIONS');const h=low-BigInt(rules.confirmationDepth-1);
 const first=await Promise.all(readers.map(r=>r.at(h)));clock();const anchor=same(first,'RPC_ANCHOR_DISAGREEMENT');
 check(uint(anchor.height)===h,'HEIGHT_MISMATCH');
 if(anchor.extra?.network)check(anchor.extra.network===id.network,'BLOCK_NETWORK_MISMATCH');
 if(anchor.extra?.genesisHash)check(anchor.extra.genesisHash===id.genesisHash,'BLOCK_GENESIS_MISMATCH');
 // Recheck both identity and anchor. This detects ordinary reorgs/server switches,
 // not colluding providers or malicious block execution.
 const againIds=await Promise.all(readers.map(r=>r.identity()));clock();check(againIds.every(i=>canonical(i)===canonical(id)),'RPC_IDENTITY_CHANGED');
 const again=await Promise.all(readers.map(r=>r.at(h)));const observedAt=clock();check(again.every(b=>canonical(b)===canonical(anchor)),'ANCHOR_CHANGED');
 for(const b of [...heads,anchor])if(b.timestampMs!==null&&b.timestampMs!==undefined){check(Number.isSafeInteger(b.timestampMs)&&b.timestampMs>0,'TIME_INVALID');check(b.timestampMs<=observedAt+2000&&observedAt-b.timestampMs<rules.maxAgeMs,'BLOCK_STALE_OR_FUTURE');}
 const expiresAt=Math.min(observedAt+rules.ttlMs,anchor.timestampMs===null?Number.MAX_SAFE_INTEGER:anchor.timestampMs+rules.maxAgeMs);
 return freeze({schema:'realdex.multichain-observation.v1',chainId:p.id,family:p.family,identity:id,anchor,
  rpcOrigins:origins,heads:heads.map(x=>x.height),confirmationDepth:rules.confirmationDepth,observedAt,expiresAt,
  assurance:{rpcAgreement:true,genesisPinned:pin!==null,freshnessEstablished:anchor.timestampMs!==null,
   independentOperatorsVerified:false,blockExecutionVerified:false,consensusProofVerified:false},
  executable:false,walletSigning:false,notes:['RPC agreement is not a consensus proof.','No balances, pools, quotes, token safety, bridge execution or transaction authorization are implied.',...(anchor.timestampMs===null?['Block freshness was not established.']:[])]});
}
/** Explicit local job list only. No peer-provided endpoint traversal. */
export async function observeMany(jobs,{concurrency=2,signal,fetchImpl,now}={}) {
 check(Array.isArray(jobs)&&jobs.length>=1&&jobs.length<=256,'JOB_LIMIT');check(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=4,'CONCURRENCY_INVALID');
 const snapshots=structuredClone(jobs),results=Array(jobs.length);let next=0;
 async function worker(){for(;;){const i=next++;if(i>=snapshots.length)return;const j=snapshots[i];try{signal?.throwIfAborted();results[i]={ok:true,result:await observeChain({...j,signal,fetchImpl,now})};}catch(e){results[i]={ok:false,chainId:typeof j.profile?.id==='string'&&/^[a-z0-9:._-]{1,120}$/i.test(j.profile.id)?j.profile.id:null,code:safeError(e)};}}}
 await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},worker));return freeze(results);
}
