/** Explicit local-only relay policy. Never accepts arbitrary transactions or wallet identities. */
import {need,shape,uint,canonical,freeze} from '../wallet/lib/guard.mjs';
import {validateIbcRoutes,ibcRouteFingerprint,routeAssets} from '../wallet/bridge/ibc-config.mjs';
import {sha256} from '../wallet/lib/keys.mjs';
import {decodeAccountAddress} from '../wallet/codec/bech32.mjs';
import {parseExactJson} from '../node/extended/json.mjs';
export const POLICY_SCHEMA='realdex.ibc-relay-policy.v1';
export const hashObject=v=>sha256(Buffer.from(canonical(v))).toString('hex');
export const networkKey=n=>hashObject({chainId:n.chainId,checkpoint:n.checkpoint});
export function relayNetworks(policy){const m=new Map();for(const r of policy.routes)for(const s of [r.source,r.destination])m.set(s.network.id,s.network);return [...m.values()];}
export function validatePolicy(p){
  shape(p,['schema','mode','routes','fees','maxJobs','intervalMs','expiresAt']);
  need(p.schema===POLICY_SCHEMA&&p.mode==='local-development','RELAY_LOCAL_POLICY_REQUIRED');
  const routes=validateIbcRoutes(p.routes);need(routes.length>0&&routes.length<=4,'RELAY_ROUTE_LIMIT');
  const networks=relayNetworks({routes});need(networks.length<=4,'RELAY_NETWORK_LIMIT');
  need(Array.isArray(p.fees)&&p.fees.length===networks.length,'RELAY_FEE_POLICIES_REQUIRED');
  const seen=new Set();const fees=p.fees.map(f=>{
    shape(f,['networkId','feeAtomic','gasLimit','maxTotalFeeAtomic','maxTransactions']);
    const n=networks.find(n=>n.id===f.networkId);need(n&&!seen.has(n.id),'RELAY_FEE_NETWORK');seen.add(n.id);
    const fee=uint(f.feeAtomic),gas=uint(f.gasLimit),cap=uint(f.maxTotalFeeAtomic);
    need(fee>0n&&fee<=uint(n.maxFeeAtomic)&&gas>0n&&gas<=uint(n.maxGasLimit)&&cap>=fee&&cap<=1000000000000n,'RELAY_FEE_POLICY');
    need(Number.isSafeInteger(f.maxTransactions)&&f.maxTransactions>=1&&f.maxTransactions<=256,'RELAY_TX_LIMIT');
    return {...f,feeAtomic:String(fee),gasLimit:String(gas),maxTotalFeeAtomic:String(cap)};
  });
  need(Number.isSafeInteger(p.maxJobs)&&p.maxJobs>=1&&p.maxJobs<=32,'RELAY_JOB_LIMIT');
  need(Number.isSafeInteger(p.intervalMs)&&p.intervalMs>=1000&&p.intervalMs<=300000,'RELAY_INTERVAL');
  need(Number.isSafeInteger(p.expiresAt)&&p.expiresAt>0,'RELAY_EXPIRY');
  return freeze({...p,routes,fees});
}
export function validatePacketForRoute(p,r){
  shape(p,['sequence','source_port','source_channel','destination_port','destination_channel','data','timeout_height','timeout_timestamp']);
  need(uint(p.sequence,(1n<<64n)-1n)>0n,'RELAY_PACKET_SEQUENCE');
  need(p.source_port==='transfer'&&p.destination_port==='transfer'&&p.source_channel===r.source.channel&&p.destination_channel===r.destination.channel,'RELAY_PACKET_ROUTE');
  shape(p.timeout_height,['revision_number','revision_height']);
  need(p.timeout_height.revision_number==='0'&&p.timeout_height.revision_height==='0'&&uint(p.timeout_timestamp,(1n<<64n)-1n)>0n,'RELAY_TIMESTAMP_ONLY');
  need(typeof p.data==='string'&&p.data.length<=4096,'RELAY_PACKET_SIZE');
  const raw=Buffer.from(p.data,'base64');need(raw.toString('base64')===p.data,'RELAY_PACKET_BASE64');
  const data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:3072,maxNodes:16,maxDepth:2});
  shape(data,['denom','amount','sender','receiver'],['memo']);
  const literal=JSON.parse(raw.toString('utf8'));need(['denom','amount','sender','receiver'].every(k=>typeof literal[k]==='string'),'RELAY_PACKET_STRING_FIELDS');
  need(data.denom===routeAssets(r).packetDenom&&uint(data.amount,(1n<<128n)-1n)>0n&&uint(data.amount)<=uint(r.maxTransferAtomic),'RELAY_PACKET_ASSET_OR_CAP');
  need(!data.memo,'RELAY_MEMO_HOOKS_FORBIDDEN');
  decodeAccountAddress(data.sender,r.source.network.hrp);decodeAccountAddress(data.receiver,r.destination.network.hrp);
  return data;
}
export function jobId(route,sourceTxHash){need(typeof sourceTxHash==='string'&&/^[A-F0-9]{64}$/.test(sourceTxHash),'RELAY_TX_HASH');return hashObject({route:ibcRouteFingerprint(route),sourceTxHash});}
export function feeStatus(data,networkId){
  const f=data.policy.fees.find(f=>f.networkId===networkId);need(f,'RELAY_FEE_NETWORK');
  const actions=data.actions.filter(a=>a.networkId===networkId);
  const used=actions.reduce((v,a)=>v+BigInt(a.feeAtomic),0n);
  return {...f,signedTransactions:actions.length,reservedFeeAtomic:String(used),remainingFeeAtomic:String(BigInt(f.maxTotalFeeAtomic)-used)};
}
