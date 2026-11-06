/** Bounded event-index discovery. A search result is a hint, NEVER settlement evidence. */
import {need,shape,uint} from '../lib/guard.mjs';
import {sha256} from '../lib/keys.mjs';
import {cosmosInt,cosmosHash} from '../non-evm/cosmos-network.mjs';
import {canonicalBase64} from '../non-evm/solana-codec.mjs';
import {validatePacket} from './ibc-codec.mjs';

export const IBC_SEARCH_PAGE_SIZE = 20;
export const IBC_SEARCH_MAX_PAGES = 4;
const EVENT = Object.freeze({receive:'recv_packet',acknowledge:'acknowledge_packet',timeout:'timeout_packet'});
const U64 = (1n << 64n) - 1n;

/** The caller supplies an identity, not a query string or RPC URL. */
export function packetSearchParams(packet,kind,{minHeight,maxHeight,page=1}={}) {
  need(Object.hasOwn(EVENT,kind),'IBC_SEARCH_KIND');
  need(packet?.source_port==='transfer'&&packet.destination_port==='transfer','IBC_SEARCH_PORT');
  for(const key of ['source_channel','destination_channel'])
    need(typeof packet[key]==='string'&&/^channel-(0|[1-9][0-9]{0,18})$/.test(packet[key]),'IBC_SEARCH_CHANNEL');
  need(uint(packet.sequence,U64)>0n,'IBC_SEARCH_SEQUENCE');
  minHeight=cosmosInt(minHeight);maxHeight=cosmosInt(maxHeight);page=cosmosInt(page);
  need(minHeight>0&&maxHeight>=minHeight&&page>=1&&page<=IBC_SEARCH_MAX_PAGES,'IBC_SEARCH_RANGE');
  const event=EVENT[kind];
  const fields={packet_src_port:packet.source_port,packet_src_channel:packet.source_channel,
    packet_dst_port:packet.destination_port,packet_dst_channel:packet.destination_channel,packet_sequence:packet.sequence};
  const query=Object.entries(fields).map(([k,v])=>`${event}.${k} = '${v}'`).join(' AND ')
    +` AND tx.height >= ${minHeight} AND tx.height <= ${maxHeight}`;
  return {query,prove:true,page:String(page),per_page:String(IBC_SEARCH_PAGE_SIZE),order_by:'asc'};
}

export function normalizeSearchPage(result,{minHeight,maxHeight,page}) {
  shape(result,['txs','total_count']);
  const total=cosmosInt(result.total_count);
  need(total<=IBC_SEARCH_PAGE_SIZE*IBC_SEARCH_MAX_PAGES,'IBC_SEARCH_LIMIT');
  const txs=result.txs===null&&total===0?[]:result.txs;
  need(Array.isArray(txs),'IBC_SEARCH_RESULT_INVALID');
  const expected=Math.max(0,Math.min(IBC_SEARCH_PAGE_SIZE,total-(page-1)*IBC_SEARCH_PAGE_SIZE));
  need(txs.length===expected,'IBC_SEARCH_PAGE_INCOMPLETE');
  const candidates=txs.map(tx=>{
    need(tx&&tx.tx_result&&Object.hasOwn(tx.tx_result,'code'),'IBC_SEARCH_EXECUTION_MISSING');
    const height=cosmosInt(tx.height),index=cosmosInt(tx.index),code=cosmosInt(tx.tx_result.code,0xffffffff);
    need(height>=minHeight&&height<=maxHeight,'IBC_SEARCH_HEIGHT_MISMATCH');
    const raw=canonicalBase64(tx.tx,16384),hash=cosmosHash(tx.hash);
    need(sha256(raw).toString('hex').toUpperCase()===hash,'IBC_SEARCH_HASH_MISMATCH');
    return {hash,height,index,code};
  });
  need(new Set(candidates.map(c=>c.hash)).size===candidates.length,'IBC_SEARCH_DUPLICATE');
  for(let i=1;i<candidates.length;i++)
    need(candidates[i].height>candidates[i-1].height||(candidates[i].height===candidates[i-1].height&&candidates[i].index>candidates[i-1].index),'IBC_SEARCH_ORDER');
  return {total,candidates};
}

async function findOne(rpc,network,packet,kind,head,authorize) {
  let total=null,last=null;const hashes=new Set(),successes=[];
  const range={minHeight:network.checkpoint.height,maxHeight:head.height};
  for(let page=1;page<=IBC_SEARCH_MAX_PAGES;page++) {
    authorize();
    const result=await rpc.agree(network,i=>rpc.searchPackets(network,i,packet,kind,{...range,page}),
      v=>normalizeSearchPage(v,{...range,page}));
    authorize();
    if(total===null)total=result.total;else need(total===result.total,'IBC_SEARCH_SNAPSHOT_CHANGED');
    for(const item of result.candidates) {
      need(!hashes.has(item.hash),'IBC_SEARCH_DUPLICATE');hashes.add(item.hash);
      if(last)need(item.height>last.height||(item.height===last.height&&item.index>last.index),'IBC_SEARCH_ORDER');
      last=item;
      if(item.code===0)successes.push(item.hash);
    }
    if(hashes.size===total)break;
  }
  need(hashes.size===total,'IBC_SEARCH_PAGE_INCOMPLETE');
  // Multiple candidates are not resolved by selecting whichever RPC returned first.
  need(successes.length<=1,'IBC_SEARCH_AMBIGUOUS');
  return successes[0]??null;
}

/** Index agreement is still unauthenticated. The engine validates each hinted transaction. */
export async function discoverIbcEvidence(adapter,route,record,source,{authorize=()=>{}}={}) {
  const packet=source.packet;validatePacket(packet,record.summary);authorize();
  const destinationHead=await adapter.head(route.destination.network);authorize();
  const destination=await findOne(adapter.rpc,route.destination.network,packet,'receive',destinationHead,authorize);
  const ack=await findOne(adapter.rpc,route.source.network,packet,'acknowledge',source.head,authorize);
  const timeout=await findOne(adapter.rpc,route.source.network,packet,'timeout',source.head,authorize);
  need(!(ack&&timeout),'IBC_SEARCH_SETTLEMENT_CONFLICT');
  const refs={...(destination?{destinationTxHash:destination}:{}),...(ack||timeout?{settlementTxHash:ack??timeout}:{})};
  const old=record.report?.evidenceRefs??{};
  for(const [k,v] of Object.entries(refs))need(!old[k]||old[k]===v,'IBC_DISCOVERED_REFERENCE_CONFLICT');
  // Re-read the snapshot boundaries. A moving tip is allowed, changing pinned blocks are not.
  const endSource=await adapter.block(route.source.network,source.head.height);authorize();
  const endDestination=await adapter.block(route.destination.network,destinationHead.height);authorize();
  need(endSource.hash===source.head.hash&&endDestination.hash===destinationHead.hash,'IBC_SEARCH_SNAPSHOT_CHANGED');
  // Stored references remain useful when an index omits a known transaction. They are rechecked.
  return {...old,...refs};
}
