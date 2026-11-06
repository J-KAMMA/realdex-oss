/** Cosmos/IBC RPC adapter for bounded relay work. Proofs are checked by destination ibc-go. */
import {need,canonical,uint} from '../wallet/lib/guard.mjs';
import {IbcRpc,IbcAdapter,eventMap} from '../wallet/bridge/ibc-network.mjs';
import {fields,one,ptext,only,singleMessage,decodeRelay} from '../wallet/bridge/ibc-wire.mjs';
import {packetCommitment,parseAck} from '../wallet/bridge/ibc-codec.mjs';
import {routeAssets,IBC_TYPES} from '../wallet/bridge/ibc-config.mjs';
import {cosmosInt,cosmosHash} from '../wallet/non-evm/cosmos-network.mjs';
import {sha256} from '../wallet/lib/keys.mjs';
import {fieldBytes as b} from '../wallet/codec/protobuf.mjs';
import {normalizeSearchPage,IBC_SEARCH_MAX_PAGES} from '../wallet/bridge/ibc-discovery.mjs';
import {validatePacketForRoute,feeStatus} from './policy.mjs';
import {encodeLightHeader,makeBody,transactionParts} from './codec.mjs';
const equal=(x,y,code)=>need(canonical(x)===canonical(y),code);
export class RelayRpc extends IbcRpc {
  async extra(n,index,method,params){
    need(['commit','validators','abci_query'].includes(method),'RELAY_RPC_METHOD');
    if(method==='abci_query')need(params.path==='/store/ibc/key'&&params.prove===true&&/^[a-f0-9]{1,1024}$/.test(params.data),'RELAY_QUERY_KEY');
    else need(/^[1-9][0-9]{0,15}$/.test(params.height),'RELAY_RPC_HEIGHT');
    const v=await this.request(this.endpoint(n,index).rpcUrl,{method:'POST',body:{jsonrpc:'2.0',id:1,method,params}});
    need(v?.jsonrpc==='2.0'&&v.id==='1'&&v.result!==undefined&&v.error===undefined,'RELAY_RPC_ERROR');return v.result;
  }
  async existsTx(n,index,hash){
    const v=await this.request(this.endpoint(n,index).rpcUrl,{method:'POST',body:{jsonrpc:'2.0',id:1,method:'tx',params:{hash:Buffer.from(hash,'hex').toString('base64'),prove:true}}});
    need(v?.jsonrpc==='2.0'&&v.id==='1','RELAY_RPC_ERROR');
    if(v.error){need(String(v.error.code)==='-32603'&&/not found/i.test(String(v.error.data??v.error.message)),'RELAY_TX_QUERY_ERROR');return false;}
    need(v.result?.hash&&cosmosHash(v.result.hash)===hash,'RELAY_TX_QUERY_BINDING');return true;
  }
}
export class RelayAdapter {
  constructor({rpc=new RelayRpc(),now=Date.now}={}){this.rpc=rpc;this.ibc=new IbcAdapter(rpc,now);this.now=now;}
  async proof(n,key,height){
    need(/^(commitments|receipts|acks)\/ports\/transfer\/channels\/channel-[0-9]+\/sequences\/[0-9]+$/.test(key),'RELAY_STORE_PATH');
    const r=await this.rpc.agree(n,i=>this.rpc.extra(n,i,'abci_query',{path:'/store/ibc/key',data:Buffer.from(key).toString('hex'),height:String(height),prove:true}),v=>v.response);
    need(String(r.code)==='0'&&String(r.height)===String(height)&&r.proofOps?.ops?.length===2,'RELAY_PROOF_RESPONSE');
    const ops=r.proofOps.ops.map((o,i)=>{need(o.type===(i===0?'ics23:iavl':'ics23:simple')&&typeof o.data==='string','RELAY_PROOF_TYPE');const d=Buffer.from(o.data,'base64');need(d.toString('base64')===o.data&&d.length>0&&d.length<=6000,'RELAY_PROOF_SIZE');return b(1,d);});
    const value=r.value??'';need(typeof value==='string'&&Buffer.from(value,'base64').toString('base64')===value,'RELAY_PROOF_VALUE');
    return {proofBase64:Buffer.concat(ops).toString('base64'),proofHeight:{revision_number:n.chainId.split('-').at(-1),revision_height:String(height+1)},value};
  }
  async source(route,hash){
    const tx=await this.ibc.included(route.source.network,hash);need(tx.evidence.executionCode==='0','RELAY_SOURCE_FAILED');
    const message=singleMessage(tx.raw);need(message.type===IBC_TYPES.transfer,'RELAY_SOURCE_NOT_TRANSFER');
    const m=fields(message.value);only(m,[1,2,3,4,5,6,7,8]);const coin=fields(one(m,3));only(coin,[1,2]);
    need(ptext(m,1)==='transfer'&&ptext(m,2)===route.source.channel&&ptext(coin,1)===routeAssets(route).sourceDenom&&!ptext(m,8,true),'RELAY_SOURCE_ROUTE_OR_MEMO');
    const timeout=fields(one(m,6,2,true));need(one(timeout,1,0,true)===0n&&one(timeout,2,0,true)===0n,'RELAY_TIMESTAMP_ONLY');
    const events=tx.result.events?.filter(e=>e.type==='send_packet');need(events?.length===1,'RELAY_SOURCE_PACKET_COUNT');const ev=eventMap(events[0]);
    need(ev.packet_timeout_height==='0-0'&&typeof ev.packet_data_hex==='string'&&/^(?:[a-f0-9]{2}){1,2048}$/i.test(ev.packet_data_hex),'RELAY_PACKET_DATA');
    const packet={sequence:ev.packet_sequence,source_port:ev.packet_src_port,source_channel:ev.packet_src_channel,destination_port:ev.packet_dst_port,destination_channel:ev.packet_dst_channel,data:Buffer.from(ev.packet_data_hex,'hex').toString('base64'),timeout_height:{revision_number:'0',revision_height:'0'},timeout_timestamp:ev.packet_timeout_timestamp};
    const data=validatePacketForRoute(packet,route);
    need(data.sender===ptext(m,4)&&data.receiver===ptext(m,5)&&data.amount===ptext(coin,2)&&packet.timeout_timestamp===String(one(m,7,0)),'RELAY_PACKET_TRANSFER_BINDING');
    return {packet,evidence:tx.evidence};
  }
  async acknowledgement(route,packet,head){
    const n=route.destination.network,range={minHeight:n.checkpoint.height,maxHeight:head.height};let total=null;const hashes=[];let count=0;
    for(let page=1;page<=IBC_SEARCH_MAX_PAGES;page++){
      const p=await this.rpc.agree(n,i=>this.rpc.searchPackets(n,i,packet,'receive',{...range,page}),v=>normalizeSearchPage(v,{...range,page}));
      if(total===null)total=p.total;else need(total===p.total,'RELAY_INDEX_CHANGED');
      count+=p.candidates.length;for(const x of p.candidates)if(x.code===0)hashes.push(x.hash);
      if(count===total)break;
    }
    need(count===total&&hashes.length===1,'RELAY_ACK_DISCOVERY');
    const tx=await this.ibc.included(n,hashes[0]),relay=decodeRelay(tx.raw,'receive');
    need(tx.evidence.executionCode==='0'&&relay.type===IBC_TYPES.receive,'RELAY_ACK_RECEIVE');equal(relay.packet,packet,'RELAY_ACK_PACKET');
    const events=tx.result.events?.filter(e=>e.type==='write_acknowledgement');need(events?.length===1,'RELAY_ACK_COUNT');const ev=eventMap(events[0]);
    need(ev.packet_sequence===packet.sequence&&ev.packet_src_channel===packet.source_channel&&ev.packet_dst_channel===packet.destination_channel&&typeof ev.packet_ack_hex==='string'&&/^(?:[a-f0-9]{2}){1,2048}$/i.test(ev.packet_ack_hex),'RELAY_ACK_EVENT');
    const ack=Buffer.from(ev.packet_ack_hex,'hex').toString('base64');parseAck(ack);return ack;
  }
  async updateHeader(host,other,clientId,proofHeight,hostHeight){
    const state=await this.rpc.agree(host,i=>this.rpc.read(host,i,`ibc/core/client/v1/client_states/${clientId}`,hostHeight));
    const cl=state.client_state;need(cl?.chain_id===other.chainId&&cl['@type']==='/ibc.lightclients.tendermint.v1.ClientState','RELAY_CLIENT_ID');
    const trusted=cosmosInt(cl.latest_height.revision_height);need(trusted<=proofHeight,'RELAY_PROOF_BEHIND_CLIENT');
    if(trusted===proofHeight)return null;
    const [c,v,tv,th]=await Promise.all([
      this.rpc.agree(other,i=>this.rpc.extra(other,i,'commit',{height:String(proofHeight)})),
      this.rpc.agree(other,i=>this.rpc.extra(other,i,'validators',{height:String(proofHeight),per_page:'100'})),
      this.rpc.agree(other,i=>this.rpc.extra(other,i,'validators',{height:String(trusted+1),per_page:'100'})),
      this.rpc.agree(other,i=>this.rpc.comet(other,i,'block',{height:String(trusted+1)}))]);
    need(v.validators?.length===Number(v.total)&&tv.validators?.length===Number(tv.total)&&v.validators.length<=100&&tv.validators.length<=100,'RELAY_VALIDATOR_PAGINATION_UNSUPPORTED');
    need(c.signed_header?.header?.chain_id===other.chainId&&String(c.signed_header.header.height)===String(proofHeight),'RELAY_LIGHT_HEADER_NETWORK');
    return encodeLightHeader(c.signed_header,v.validators,tv.validators,trusted,other.chainId.split('-').at(-1),th.block.header.proposer_address).toString('base64');
  }
  async plan(data,job){
    const route=data.policy.routes.find(r=>r.id===job.routeId);need(route,'RELAY_ROUTE_NOT_ALLOWED');
    const heads=await this.ibc.lane(route),source=await this.source(route,job.sourceTxHash),p=source.packet;
    if(job.packet)equal(job.packet,p,'RELAY_SOURCE_PACKET_CHANGED');
    const sh=heads.sourceHead.height-1,dh=heads.destinationHead.height-1;
    need(sh>=source.evidence.height&&sh>=route.source.network.checkpoint.height&&dh>=route.destination.network.checkpoint.height,'RELAY_STATE_NOT_MATURE');
    const src=await this.proof(route.source.network,`commitments/ports/transfer/channels/${p.source_channel}/sequences/${p.sequence}`,sh);
    if(!src.value)return {packet:p,settled:true,assurance:'RPC observation; not independent finality'};
    need(src.value===packetCommitment(p),'RELAY_PACKET_COMMITMENT');
    const receipt=await this.proof(route.destination.network,`receipts/ports/transfer/channels/${p.destination_channel}/sequences/${p.sequence}`,dh);
    let kind,proof,acknowledgement=null;
    if(receipt.value){
      need(receipt.value==='AQ==','RELAY_RECEIPT_VALUE');kind='acknowledge';proof=await this.proof(route.destination.network,`acks/ports/transfer/channels/${p.destination_channel}/sequences/${p.sequence}`,dh);
      acknowledgement=await this.acknowledgement(route,p,heads.destinationHead);
      need(proof.value===sha256(Buffer.from(acknowledgement,'base64')).toString('base64'),'RELAY_ACK_COMMITMENT');
    }else if(BigInt(heads.destinationHead.time)*1000000n>=BigInt(p.timeout_timestamp)){kind='timeout';proof=receipt;}
    else{kind='receive';proof=src;}
    const side=kind==='receive'?route.destination:route.source,other=kind==='receive'?route.source:route.destination,n=side.network;
    const hostHead=kind==='receive'?heads.destinationHead:heads.sourceHead,key=data.keys.find(k=>k.networkId===n.id),f=feeStatus(data,n.id);
    need(key,'RELAY_KEY_NOT_FOUND');const account=await this.ibc.account(n,key.address,hostHead.height);
    need(!account.publicKey||account.publicKey===key.publicKeyHex,'RELAY_KEY_CHANGED');
    const updateHeaderBase64=await this.updateHeader(n,other.network,side.client,Number(proof.proofHeight.revision_height),hostHead.height);
    const timeoutHeight=String(hostHead.height+Math.min(n.timeoutBlocks,100));
    const draft={kind,networkId:n.id,chainId:n.chainId,accountNumber:account.accountNumber,sequence:account.sequence,timeoutHeight,feeAtomic:f.feeAtomic,feeDenom:n.feeDenom,gasLimit:f.gasLimit,
      bodyBase64:makeBody({kind,packet:p,...proof,acknowledgement,clientId:side.client,updateHeaderBase64,signer:key.address},timeoutHeight)};
    await this.revalidate(data,job,draft);return {packet:p,settled:false,draft};
  }
  async revalidate(data,job,action){
    const r=data.policy.routes.find(r=>r.id===job.routeId),n=(action.kind==='receive'?r.destination:r.source).network,key=data.keys.find(k=>k.networkId===n.id);
    const heads=await this.ibc.lane(r),head=action.kind==='receive'?heads.destinationHead:heads.sourceHead,account=await this.ibc.account(n,key.address,head.height);
    need(account.accountNumber===action.accountNumber&&account.sequence===action.sequence&&(!account.publicKey||account.publicKey===key.publicKeyHex),'RELAY_SEQUENCE_CHANGED');
    need(head.height<Number(action.timeoutHeight),'RELAY_TX_EXPIRED');const balance=BigInt(await this.ibc.spendable(n,key.address,n.feeDenom,head.height));need(balance>=BigInt(action.feeAtomic),'RELAY_FEE_BALANCE');
    const parts=transactionParts(action,key.publicKeyHex),zero=Buffer.concat([b(1,parts.body),b(2,parts.auth),b(3,Buffer.alloc(64))]).toString('base64');
    const gas=await this.rpc.agree(n,i=>this.rpc.rest(n,i,'cosmos/tx/v1beta1/simulate',{height:head.height,body:{tx_bytes:zero}}),v=>String(uint(v.gas_info?.gas_used)));
    need(BigInt(gas)>0n&&BigInt(gas)<=BigInt(action.gasLimit),'RELAY_GAS_LIMIT');
    equal(await this.ibc.block(n,head.height),head,'RELAY_HOST_BLOCK_CHANGED');
  }
  async receipt(data,action){
    const r=data.policy.routes.find(r=>r.id===data.jobs.find(j=>j.id===action.jobId)?.routeId),n=(action.kind==='receive'?r.destination:r.source).network;
    const found=await this.rpc.agree(n,i=>this.rpc.existsTx(n,i,action.txHash));if(!found)return null;
    const tx=await this.ibc.included(n,action.txHash,Buffer.from(action.txRawBase64,'base64'));
    return {height:tx.evidence.height,blockHash:tx.evidence.blockHash,code:tx.evidence.executionCode,inclusionVerified:true};
  }
  async submit(data,action){
    const r=data.policy.routes.find(r=>r.id===data.jobs.find(j=>j.id===action.jobId)?.routeId),n=(action.kind==='receive'?r.destination:r.source).network;
    need(n.broadcastEnabled,'RELAY_NETWORK_BROADCAST_DISABLED');
    const v=await this.rpc.rest(n,0,'cosmos/tx/v1beta1/txs',{body:{tx_bytes:action.txRawBase64,mode:'BROADCAST_MODE_SYNC'}});
    need(v.tx_response&&cosmosHash(v.tx_response.txhash)===action.txHash&&String(v.tx_response.code)==='0','RELAY_SUBMIT_UNCERTAIN');
  }
}
