import {check,keys,uint,text,freeze,endpointConfigs,makeClock,boundedSignal} from './guard.mjs';
import {hashHex,safeNumber,millis,isoMillis,canonical,hexUint,toHex} from '../chains/core.mjs';
import {validateExtendedProfile} from './registry.mjs';
import {readProtocol} from './protocol.mjs';
import {canisterPrincipal,principalBytes} from '../icp/principal.mjs';
const h=x=>String(uint(x)),hash=x=>hashHex(x,false),eq=(a,b)=>canonical(a)===canonical(b);
const block=(height,digest,time,extra={})=>({height:h(height),hash:hash(digest),timestampMs:time,...extra});
const sec=x=>uint(x)===0n?null:millis(x,'seconds');
function moneroOk(r){check(r?.status==='OK'&&r.untrusted===false,'MONERO_RESPONSE_UNTRUSTED');return r;}
function utxoInfo(r){check(r&&typeof r.chain==='string','UTXO_INFO_INVALID');if(Object.hasOwn(r,'initialblockdownload'))check(r.initialblockdownload===false,'RPC_SYNCING');
 uint(r.blocks);hash(r.bestblockhash);if(Object.hasOwn(r,'headers'))check(uint(r.headers)>=uint(r.blocks),'UTXO_HEAD_INCONSISTENT');return r;}
function ledgerTarget(raw){keys(raw,['canister','networkFormat']);const canister=canisterPrincipal(raw.canister);
 check(['principal','hex'].includes(raw.networkFormat),'ROSETTA_NETWORK_FORMAT_INVALID');
 const bytes=principalBytes(canister),network=raw.networkFormat==='principal'?canister:Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
 return {canister,networkIdentifier:{blockchain:'Internet Computer',network}};}
function reader(profile,endpoint,{ledger,identityAnchor,...options}){
 const io=readProtocol(profile.family,endpoint,options);let target=profile.family==='icp'?ledgerTarget(ledger):null;
 const networkBody=target?{network_identifier:target.networkIdentifier}:null;
 const status=async()=>{const r=await io.rosetta('/network/status',networkBody);check(r?.sync_status?.synced!==false,'RPC_SYNCING');return r;};
 const monoHeader=async height=>{const r=moneroOk(await io.rpc('get_block_header_by_height',{height:safeNumber(height)})),b=r.block_header;
  check(b&&b.orphan_status===false,'MONERO_ORPHAN_BLOCK');return block(b.height,b.hash,sec(b.timestamp),{parentHash:hash(b.prev_hash)});};
 const evmBlock=async height=>{const b=await io.rpc('eth_getBlockByNumber',[height==='latest'?height:toHex(height),false]);
  check(b,'BLOCK_MISSING');return block(hexUint(b.number),hashHex(b.hash).slice(2),sec(hexUint(b.timestamp)),{parentHash:hashHex(b.parentHash).slice(2)});};
 const cometBlock=async height=>{const r=await io.rpc('block',{height:h(height)}),b=r?.block?.header;check(b,'BLOCK_MISSING');
  check(b.chain_id===profile.networkIdentity,'BLOCK_NETWORK_MISMATCH');return block(b.height,r.block_id?.hash,isoMillis(b.time),{});};
 const impl={
  async identity(){
   if(profile.family==='monero'){const [info,g]=await Promise.all([io.rpc('get_info',{}),monoHeader(0)]);moneroOk(info);
    check(info.synchronized===true&&info.offline===false&&info.busy_syncing===false,'RPC_SYNCING');check(g.height==='0','GENESIS_INVALID');return {network:text(info.nettype),genesisHash:g.hash};}
   if(profile.family==='utxo-core'){const [info,g]=await Promise.all([io.rpc('getblockchaininfo'),io.rpc('getblockhash',[0])]);utxoInfo(info);return {network:info.chain,genesisHash:hash(g)};}
   if(profile.family==='evm'){const [id,sync,g]=await Promise.all([io.rpc('eth_chainId'),io.rpc('eth_syncing'),evmBlock(0)]);check(sync===false,'RPC_SYNCING');check(g.height==='0','GENESIS_INVALID');return {network:String(hexUint(id)),genesisHash:g.hash};}
   if(profile.family==='cometbft'){const s=await io.rpc('status');check(s?.sync_info?.catching_up===false,'RPC_SYNCING');const b=await cometBlock(identityAnchor.height);check(b.height===h(identityAnchor.height),'ANCHOR_HEIGHT_MISMATCH');return {network:text(s.node_info?.network),genesisHash:b.hash,checkpointHeight:b.height};}
   const list=await io.rosetta('/network/list',{});check(Array.isArray(list?.network_identifiers)&&list.network_identifiers.length<=128,'ROSETTA_NETWORK_LIST_INVALID');
   check(list.network_identifiers.filter(n=>eq(n,target.networkIdentifier)).length===1,'ROSETTA_LEDGER_NOT_FOUND');const s=await status(),g=s.genesis_block_identifier;
   check(g&&h(g.index)==='0','ROSETTA_GENESIS_INVALID');return {network:target.networkIdentifier.network,genesisHash:hash(g.hash),ledger:target.canister};
  },
  async tip(){
   if(profile.family==='monero'){const i=moneroOk(await io.rpc('get_info',{}));check(i.synchronized===true&&i.offline===false&&i.busy_syncing===false,'RPC_SYNCING');check(uint(i.height)>0n,'CHAIN_EMPTY');
    const b=await monoHeader(uint(i.height)-1n);check(b.hash===hash(i.top_block_hash),'MONERO_TIP_MISMATCH');return b;}
   if(profile.family==='utxo-core'){const i=utxoInfo(await io.rpc('getblockchaininfo'));return {height:h(i.blocks),hash:hash(i.bestblockhash),timestampMs:null};}
   if(profile.family==='evm')return evmBlock('latest');
   if(profile.family==='cometbft'){const s=await io.rpc('status');check(s?.sync_info?.catching_up===false,'RPC_SYNCING');return block(s.sync_info.latest_block_height,s.sync_info.latest_block_hash,isoMillis(s.sync_info.latest_block_time));}
   const s=await status();return block(s.current_block_identifier?.index,s.current_block_identifier?.hash,millis(s.current_block_timestamp));
  },
  async at(height){
   const wanted=h(height);let b;
   if(profile.family==='monero')b=await monoHeader(wanted);
   else if(profile.family==='utxo-core'){const digest=hash(await io.rpc('getblockhash',[safeNumber(wanted)])),r=await io.rpc('getblockheader',[digest,true]);
    check(r&&uint(r.confirmations)>0n,'UTXO_ORPHAN_BLOCK');check(hash(r.hash)===digest,'UTXO_BLOCK_HASH_MISMATCH');
    // ChainLock is reported only. No BLS/LLMQ verification is implied.
    b=block(r.height,digest,sec(r.time),{parentHash:hash(r.previousblockhash??'0'.repeat(64))});}
   else if(profile.family==='evm')b=await evmBlock(wanted);
   else if(profile.family==='cometbft')b=await cometBlock(wanted);
   else {const r=await io.rosetta('/block',{...networkBody,block_identifier:{index:safeNumber(wanted)}}),v=r?.block;check(v,'ROSETTA_BLOCK_MISSING');
    b=block(v.block_identifier?.index,v.block_identifier?.hash,millis(v.timestamp),{parentHash:hash(v.parent_block_identifier?.hash)});}
   check(b.height===wanted,'BLOCK_HEIGHT_MISMATCH');return b;
  }
 };
 return impl;
}
/** Read one network (one *ledger*, not a fictitious global ICP block chain).
 * No network effect other than the exact read methods in protocol.mjs.
 * Every configured endpoint must agree; no majority fail-open fallback. */
export async function observeExtended({profile,endpoints,access={},genesisPin,identityAnchor,ledger,policy={},signal,fetchImpl,now=Date.now}){
 const p=validateExtendedProfile(profile);keys(policy,[],['confirmationDepth','maxHeadGap','maxBlockAgeMs','ttlMs']);
 const defaults={confirmationDepth:p.family==='utxo-core'?6:p.family==='monero'?10:1,maxHeadGap:64,maxBlockAgeMs:7200000,ttlMs:30000},rules={...defaults,...policy};
 for(const [k,v]of Object.entries(rules))check(Number.isSafeInteger(v)&&v>=(k==='maxHeadGap'?0:1),'POLICY_INVALID');
 check(rules.confirmationDepth<=128&&rules.maxHeadGap<=1024&&rules.maxBlockAgeMs<=86400000&&rules.ttlMs<=60000,'POLICY_INVALID');
 const configs=endpointConfigs(endpoints,access);let pin;
 if(p.family==='cometbft'){keys(identityAnchor,['height','hash']);uint(identityAnchor.height);pin=hash(identityAnchor.hash);}
 else {check(identityAnchor===undefined,'ANCHOR_UNEXPECTED');check((genesisPin??p.genesisHash)!=null,'GENESIS_PIN_REQUIRED');pin=hash(genesisPin??p.genesisHash);}
 if(p.genesisHash!==null)check(p.genesisHash===pin,'PROFILE_PIN_CONFLICT');
 if(p.family==='icp')ledgerTarget(ledger);else check(ledger===undefined,'LEDGER_UNEXPECTED');
 const joined=boundedSignal(signal,60000),clock=makeClock(now,joined,rules.ttlMs);clock();
 const rs=configs.map(c=>reader(p,c.url,{ledger,identityAnchor,access,headers:c.headers,signal:joined,fetchImpl}));
 const ids=await Promise.all(rs.map(r=>r.identity()));clock();check(ids.every(i=>eq(i,ids[0])),'RPC_IDENTITY_DISAGREEMENT');const id=ids[0];
 check(id.genesisHash===pin,'IDENTITY_PIN_MISMATCH');if(p.family!=='icp')check(id.network===p.networkIdentity,'NETWORK_IDENTITY_MISMATCH');
 const tips=await Promise.all(rs.map(r=>r.tip()));clock();const heights=tips.map(t=>uint(t.height)),low=heights.reduce((a,b)=>a<b?a:b),high=heights.reduce((a,b)=>a>b?a:b);
 check(high-low<=BigInt(rules.maxHeadGap),'RPC_HEAD_GAP');check(low>=BigInt(rules.confirmationDepth-1),'INSUFFICIENT_CONFIRMATIONS');const height=low-BigInt(rules.confirmationDepth-1);
 const anchors=await Promise.all(rs.map(r=>r.at(height)));clock();const anchor=anchors[0];check(anchors.every(a=>eq(a,anchor)),'RPC_ANCHOR_DISAGREEMENT');
 const againIds=await Promise.all(rs.map(r=>r.identity()));clock();check(againIds.every(i=>eq(i,id)),'RPC_IDENTITY_CHANGED');
 const again=await Promise.all(rs.map(r=>r.at(height)));const observedAt=clock();check(again.every(a=>eq(a,anchor)),'ANCHOR_CHANGED');
 // ICP ledger blocks are transfer records. An idle ledger is not necessarily an
 // unhealthy ICP network; never manufacture an ICP block-time freshness proof.
 const ledgerScoped=p.family==='icp';
 for(const b of [...tips,anchor])if(b.timestampMs!==null){check(b.timestampMs<=observedAt+2000,'BLOCK_IN_FUTURE');if(!ledgerScoped)check(observedAt-b.timestampMs<rules.maxBlockAgeMs,'BLOCK_STALE');}
 let expiresAt=observedAt+rules.ttlMs;if(!ledgerScoped&&anchor.timestampMs!==null)expiresAt=Math.min(expiresAt,anchor.timestampMs+rules.maxBlockAgeMs);
 return freeze({schema:'realdex.extended-observation.v1',networkId:p.id,protocol:p.family,scope:ledgerScoped?'ledger-canister':'chain',identity:id,anchor,
  readerCount:rs.length,confirmationDepth:rules.confirmationDepth,observedAt,expiresAt,
  assurance:{rpcAgreement:rs.length>=2,identityAnchorMatched:true,independentOperatorsVerified:false,consensusProofVerified:false,
   blockExecutionVerified:false,certifiedLedgerState:false,icpSubnetIdentityVerified:false,sourceFreshnessEstablished:!ledgerScoped&&anchor.timestampMs!==null},
  privacy:{model:p.privacyModel,endpointTopologyIncluded:false,privateBalancesRead:false,viewingKeysRead:false,spendingKeysRead:false,anonymityGuaranteed:false,peerPublicationAllowed:false},
  executable:false,notes:['RPC observations and local pins are not cryptographic consensus proofs.',
   ...(ledgerScoped?['The anchor is for this ledger only; an old last-transfer timestamp is not an ICP network liveness failure.']:[]),
   ...(p.restricted?['Permissioning is not confidentiality. RealDEX does not configure or certify network access control.']:[])]});
}
