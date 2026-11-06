import {simulateIbc} from './ibc-simulation.mjs';
import {packetSearchParams} from './ibc-discovery.mjs';
/** Strict local Cosmos RPC extension for ICS-20. Agreement is not an independent state proof. */
import {need,uint,canonical,shape} from '../lib/guard.mjs';
import {CosmosRpc,cosmosInt,cosmosHash} from '../non-evm/cosmos-network.mjs';
import {CosmosAdapter} from '../non-evm/cosmos-online.mjs';
import {verifyCosmosInclusion} from '../non-evm/cosmos-proof.mjs';
import {decodeAccountAddress} from '../codec/bech32.mjs';
import {sha256} from '../lib/keys.mjs';
import {canonicalBase64} from '../non-evm/solana-codec.mjs';
import {ibcDenom,validateIbcRoute,routeAssets,IBC_TYPES} from './ibc-config.mjs';
import {ibcFrom,ibcTransaction,ibcRaw,validatePacket,parseAck} from './ibc-codec.mjs';
import {fields,one,ptext,only,decodeRelay} from './ibc-wire.mjs';
const match=(a,b,code)=>need(canonical(a)===canonical(b),code);
export class IbcRpc extends CosmosRpc {
 async searchPackets(n,index,packet,kind,range){
  const endpoint=this.endpoint(n,index),params=packetSearchParams(packet,kind,range);
  const v=await this.request(endpoint.rpcUrl,{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tx_search',params}});
  need(v?.jsonrpc==='2.0'&&v.id==='1'&&v.result!==undefined&&v.error===undefined,'IBC_INDEX_UNAVAILABLE');
  return v.result;
 }
 async read(n,index,relative,height){
  need(typeof relative==='string'&&!relative.includes('..')&&!relative.includes('#')&&!relative.includes('://')&&!relative.startsWith('/'),'IBC_RPC_PATH');
  const e=this.endpoint(n,index),u=new URL(relative,e.restUrl),p=u.pathname;
  const balance=/^\/cosmos\/bank\/v1beta1\/(balances|spendable_balances)\/[a-z0-9]{3,90}\/by_denom$/.test(p);
  if(balance){need([...u.searchParams.keys()].length===1&&u.searchParams.has('denom'),'IBC_RPC_QUERY');ibcDenom(u.searchParams.get('denom'));}
  else need(!u.search&&(/^\/ibc\/core\/channel\/v1\/channels\/channel-[0-9]+\/ports\/transfer$/.test(p)||/^\/ibc\/core\/channel\/v1\/channels\/channel-[0-9]+\/ports\/transfer\/packet_acks\/[0-9]+$/.test(p)||/^\/ibc\/core\/connection\/v1\/connections\/connection-[0-9]+$/.test(p)||/^\/ibc\/core\/client\/v1\/(client_states|client_status)\/07-tendermint-[0-9]+$/.test(p)||/^\/ibc\/apps\/transfer\/v1\/denoms\/[A-F0-9]{64}$/.test(p)),'IBC_RPC_PATH');
  need(cosmosInt(height)>0,'IBC_QUERY_HEIGHT_REQUIRED');return this.request(u.href,{height});
 }
}
export function eventMap(event){need(event&&Array.isArray(event.attributes)&&event.attributes.length<=64,'IBC_EVENT_INVALID');const out=Object.create(null);for(const a of event.attributes){need(typeof a.key==='string'&&typeof a.value==='string'&&a.key.length<=80&&a.value.length<=8192&&!Object.hasOwn(out,a.key),'IBC_EVENT_DUPLICATE_OR_INVALID');out[a.key]=a.value;}return out;}
function packetEvent(result,type,summary,expectedIndex=0){const ev=result.events?.filter(e=>e.type===type);need(ev?.length===1,'IBC_PACKET_EVENT_COUNT');const v=eventMap(ev[0]);need(v.msg_index===undefined||v.msg_index===String(expectedIndex),'IBC_EVENT_INDEX');need(typeof v.packet_data_hex==='string'&&/^(?:[a-f0-9]{2}){1,2048}$/i.test(v.packet_data_hex),'IBC_PACKET_DATA');need(v.packet_timeout_height==='0-0','IBC_PACKET_TIMEOUT_MISMATCH');return validatePacket({sequence:v.packet_sequence,source_port:v.packet_src_port,source_channel:v.packet_src_channel,destination_port:v.packet_dst_port,destination_channel:v.packet_dst_channel,data:Buffer.from(v.packet_data_hex,'hex').toString('base64'),timeout_height:{revision_number:'0',revision_height:'0'},timeout_timestamp:v.packet_timeout_timestamp},summary);}
function feeForSigner(relay,target,denom){if(relay.signer!==target)return 0n;const auth=fields(relay.auth);only(auth,[1,2]);const fee=fields(one(auth,2));only(fee,[1,2,3,4]);need(ptext(fee,3,true)===''&&ptext(fee,4,true)==='','IBC_RELAY_FEE_DELEGATION_UNSUPPORTED');const coin=fields(one(fee,1));only(coin,[1,2]);return ptext(coin,1)===denom?uint(ptext(coin,2)):0n;}
export class IbcAdapter extends CosmosAdapter {
 constructor(rpc=new IbcRpc(),now=Date.now){super(rpc,now);}
 async amount(n,address,denom,height,spendable=false){decodeAccountAddress(address,n.hrp);ibcDenom(denom);return this.rpc.agree(n,i=>this.rpc.read(n,i,`cosmos/bank/v1beta1/${spendable?'spendable_balances':'balances'}/${address}/by_denom?denom=${encodeURIComponent(denom)}`,height),v=>{need(v?.balance?.denom===denom,'IBC_BALANCE_DENOM');return String(uint(v.balance.amount));});}
 async lane(route){
  const r=validateIbcRoute(route),s=r.source,d=r.destination,[sourceHead,destinationHead]=await Promise.all([this.head(s.network),this.head(d.network)]);
  for(const [side,other,head,otherHead] of [[s,d,sourceHead,destinationHead],[d,s,destinationHead,sourceHead]]){
   const n=side.network,read=p=>this.rpc.agree(n,i=>this.rpc.read(n,i,p,head.height));
   const [channel,connection,client,status]=await Promise.all([read(`ibc/core/channel/v1/channels/${side.channel}/ports/transfer`),read(`ibc/core/connection/v1/connections/${side.connection}`),read(`ibc/core/client/v1/client_states/${side.client}`),read(`ibc/core/client/v1/client_status/${side.client}`)]);
   const ch=channel?.channel,co=connection?.connection,cl=client?.client_state;
   need(ch?.state==='STATE_OPEN'&&ch.ordering==='ORDER_UNORDERED'&&ch.version==='ics20-1'&&canonical(ch.connection_hops)===canonical([side.connection])&&ch.counterparty?.port_id==='transfer'&&ch.counterparty.channel_id===other.channel,'IBC_CHANNEL_BINDING');
   need(co?.state==='STATE_OPEN'&&co.client_id===side.client&&co.counterparty?.client_id===other.client&&co.counterparty.connection_id===other.connection&&co.counterparty.prefix?.key_prefix==='aWJj'&&co.delay_period==='0','IBC_CONNECTION_BINDING');
   need(cl?.['@type']==='/ibc.lightclients.tendermint.v1.ClientState'&&cl.chain_id===other.network.chainId&&cl.frozen_height?.revision_number==='0'&&cl.frozen_height.revision_height==='0'&&status?.status==='Active','IBC_CLIENT_NOT_ACTIVE_OR_WRONG_CHAIN');
   need(cl.latest_height?.revision_number===other.network.chainId.split('-').at(-1)&&cosmosInt(cl.latest_height.revision_height)>0&&cosmosInt(cl.latest_height.revision_height)<=otherHead.height,'IBC_CLIENT_HEIGHT_INVALID');
  }
  const assets=routeAssets(r);
  if(assets.mode==='voucher-to-origin'){
   const v=await this.rpc.agree(s.network,i=>this.rpc.read(s.network,i,'ibc/apps/transfer/v1/denoms/'+assets.sourceDenom.slice(4),sourceHead.height));
   need(v?.denom?.base===r.asset.baseDenom&&canonical(v.denom.trace)===canonical([{port_id:'transfer',channel_id:s.channel}]),'IBC_VOUCHER_TRACE_MISMATCH');
  }
  return {sourceHead,destinationHead};
 }
 async inspect(route,a,u,p=null){
  const r=validateIbcRoute(route),n=r.source.network,assets=routeAssets(r),heads=await this.lane(r),from=ibcFrom(a,r);
  const account=await this.account(n,from,heads.sourceHead.height);need(!account.publicKey||account.publicKey===a.publicKeyHex,'IBC_ACCOUNT_KEY_CHANGED');
  const balance=await this.amount(n,from,assets.sourceDenom,heads.sourceHead.height,true),fees=assets.sourceDenom===n.feeDenom?balance:await this.amount(n,from,n.feeDenom,heads.sourceHead.height,true);
  need(BigInt(balance)>=BigInt(u.amountAtomic)+(assets.sourceDenom===n.feeDenom?BigInt(u.feeAtomic):0n)&&BigInt(fees)>=BigInt(u.feeAtomic),'IBC_BALANCE_INSUFFICIENT');
  if(p){need(p.accountNumber===account.accountNumber&&p.sequence===account.sequence,'IBC_SEQUENCE_CHANGED');need(BigInt(p.timeoutHeight)>BigInt(heads.sourceHead.height),'IBC_SOURCE_TX_EXPIRED');need(BigInt(p.timeoutTimestamp)>BigInt(Math.max(this.now(),heads.destinationHead.time)+5000)*1000000n,'IBC_PACKET_DEADLINE_TOO_CLOSE');
   const tx=ibcTransaction(p,a.publicKeyHex),unsigned=ibcRaw(tx,Buffer.alloc(64)).toString('base64');
   await simulateIbc(this.rpc,n,unsigned,heads.sourceHead.height,u.gasLimit);
  }
  match(await this.block(n,heads.sourceHead.height),heads.sourceHead,'IBC_SOURCE_CHANGED');match(await this.block(r.destination.network,heads.destinationHead.height),heads.destinationHead,'IBC_DESTINATION_CHANGED');
  return {...heads,account,balanceAtomic:balance,feeBalanceAtomic:fees,sourceDenom:assets.sourceDenom,destinationDenom:assets.destinationDenom};
 }
 async submit(r,record){const n=r.source.network;const v=await this.rpc.rest(n,0,'cosmos/tx/v1beta1/txs',{body:{tx_bytes:record.signed.txRawBase64,mode:'BROADCAST_MODE_SYNC'}});need(v.tx_response?.txhash===record.signed.requestId&&cosmosInt(v.tx_response.code,0xffffffff)===0,'IBC_SUBMIT_NOT_ACCEPTED');}
 async included(n,hash,expectedRaw){
  need(typeof hash==='string'&&/^[A-F0-9]{64}$/.test(hash),'IBC_EVIDENCE_HASH');const head=await this.head(n);
  const data=await this.rpc.agree(n,i=>this.rpc.comet(n,i,'tx',{hash:Buffer.from(hash,'hex').toString('base64'),prove:true}));
  need(data.tx_result&&Object.hasOwn(data.tx_result,'code'),'IBC_EXECUTION_CODE_MISSING');
  const raw=canonicalBase64(data.tx,16384);need(sha256(raw).toString('hex').toUpperCase()===hash&&cosmosHash(data.hash)===hash&&(!expectedRaw||raw.equals(expectedRaw)),'IBC_RECEIPT_TRANSACTION_MISMATCH');
  const height=cosmosInt(data.height),index=cosmosInt(data.index);need(height>=n.checkpoint.height&&height<=head.height,'IBC_RECEIPT_HEIGHT');
  const block=await this.block(n,height);verifyCosmosInclusion(raw,data.proof,block.dataHash,index);const confirmations=head.height-height+1;
  need(confirmations>=n.minConfirmations,'IBC_CONFIRMATIONS_PENDING');const executionCode=String(cosmosInt(data.tx_result.code,0xffffffff));
  return {raw,result:data.tx_result,head,evidence:{transactionHash:hash,height,blockHash:block.hash,confirmations,requiredConfirmations:n.minConfirmations,inclusionVerified:true,executionCode,eventDataAuthenticated:false}};
 }
 async source(r,record){const tx=await this.included(r.source.network,record.signed.requestId,Buffer.from(record.signed.txRawBase64,'base64'));if(tx.evidence.executionCode!=='0')return {...tx,packet:null};const packet=packetEvent(tx.result,'send_packet',record.summary);return {...tx,packet};}
 async destination(r,record,packet,hash){
  const tx=await this.included(r.destination.network,hash),relay=decodeRelay(tx.raw,'receive');need(tx.evidence.executionCode==='0'&&relay.type===IBC_TYPES.receive,'IBC_RECEIVE_TRANSACTION_INVALID');match(relay.packet,packet,'IBC_RECEIVE_PACKET_MISMATCH');match(packetEvent(tx.result,'recv_packet',record.summary,relay.messageIndex),packet,'IBC_RECEIVE_EVENT_MISMATCH');
  const es=tx.result.events.filter(e=>e.type==='write_acknowledgement');need(es.length===1,'IBC_ACK_EVENT_COUNT');const ev=eventMap(es[0]);need(typeof ev.packet_ack_hex==='string'&&/^(?:[a-f0-9]{2}){1,2048}$/i.test(ev.packet_ack_hex),'IBC_ACK_BYTES');const ack=Buffer.from(ev.packet_ack_hex,'hex').toString('base64'),outcome=parseAck(ack);
  match(packetEvent(tx.result,'write_acknowledgement',record.summary,relay.messageIndex),packet,'IBC_ACK_PACKET_MISMATCH');
  const state=await this.rpc.agree(r.destination.network,i=>this.rpc.read(r.destination.network,i,`ibc/core/channel/v1/channels/${packet.destination_channel}/ports/transfer/packet_acks/${packet.sequence}`,tx.evidence.height));need(state.acknowledgement===sha256(Buffer.from(ack,'base64')).toString('base64'),'IBC_ACK_COMMITMENT_MISMATCH');
  if(outcome.success){const denom=routeAssets(r).destinationDenom,h=tx.evidence.height;need(h>1,'IBC_BALANCE_HISTORY_REQUIRED');const before=BigInt(await this.amount(r.destination.network,record.summary.recipient,denom,h-1)),after=BigInt(await this.amount(r.destination.network,record.summary.recipient,denom,h));need(after-before+feeForSigner(relay,record.summary.recipient,denom)===BigInt(record.summary.amountAtomic),'IBC_DESTINATION_BALANCE_DELTA');}
  return {...tx,acknowledgement:ack,outcome};
 }
 async settlement(r,record,packet,hash,destination){
  const tx=await this.included(r.source.network,hash);need(tx.evidence.executionCode==='0','IBC_SETTLEMENT_EXECUTION_FAILED');
  let relay,refunded=false;
  try{relay=decodeRelay(tx.raw,'acknowledge');need(relay.type===IBC_TYPES.acknowledge,'IBC_NOT_ACK');}
  catch{relay=decodeRelay(tx.raw,'timeout');need(relay.type===IBC_TYPES.timeout,'IBC_SETTLEMENT_KIND_UNSUPPORTED');}
  match(relay.packet,packet,'IBC_SETTLEMENT_PACKET_MISMATCH');
  const kind=relay.type===IBC_TYPES.timeout?'timeout':'acknowledge',es=tx.result.events.filter(e=>e.type===kind+'_packet');need(es.length===1,'IBC_SETTLEMENT_EVENT_COUNT');const ev=eventMap(es[0]);for(const [k,v] of Object.entries({packet_sequence:packet.sequence,packet_src_port:packet.source_port,packet_src_channel:packet.source_channel,packet_dst_port:packet.destination_port,packet_dst_channel:packet.destination_channel,packet_timeout_height:'0-0',packet_timeout_timestamp:packet.timeout_timestamp}))need(ev[k]===v,'IBC_SETTLEMENT_EVENT_BINDING');
  if(kind==='acknowledge'){need(destination,'IBC_DESTINATION_RECEIPT_REQUIRED');need(relay.acknowledgement===destination.acknowledgement,'IBC_ACK_CONFLICT');refunded=!parseAck(relay.acknowledgement).success;}else refunded=true;
  if(refunded){const denom=routeAssets(r).sourceDenom,from=record.summary.networkFrom,h=tx.evidence.height;need(h>1,'IBC_BALANCE_HISTORY_REQUIRED');const before=BigInt(await this.amount(r.source.network,from,denom,h-1)),after=BigInt(await this.amount(r.source.network,from,denom,h));need(after-before+feeForSigner(relay,from,denom)===BigInt(record.summary.amountAtomic),'IBC_REFUND_BALANCE_DELTA');}
  return {...tx,refunded,kind};
 }
}
