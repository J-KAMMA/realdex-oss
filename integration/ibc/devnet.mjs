import {ibcToolStatus} from './toolchain.mjs';
/** Disposable TWO-chain IBC devnet. Bootstrap and relay keys are test-only. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {keyInfo} from '../../wallet/lib/keys.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const enc=b=>Buffer.from(b,'hex').toString('base64');
export async function until(fn,timeout=20000){let last;for(const end=Date.now()+timeout;Date.now()<end;){try{const v=await fn();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,150));}throw last??Error('IBC_DEVNET_TIMEOUT');}
async function freePort(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
function tool(){
 const binary=process.env.REALDEX_IBC_SIMD_BINARY,loader=process.env.REALDEX_IBC_MUSL_LOADER;
 const status=ibcToolStatus(binary,loader);if(!status.available)throw Error(status.reason);
 if(sha(fs.readFileSync(binary))!=='a2670ead414260162947575f272d0a98e0cb16fd8cd1de171e5dcfaa5110627b'||sha(fs.readFileSync(loader))!=='2fb72c67f292827c8c4095067197af7880c234a3a4060136e1b5518d10de1eb9')throw Error('IBC_TEST_TOOL_HASH_MISMATCH');
 return {binary,loader,args:['--library-path',path.dirname(loader),binary]};
}
export async function startChain(label,logDirectory){
 const t=tool(),home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-ibc-'+label+'-')),chainId='realdex-local-bridge-'+label+'-1';
 const env={PATH:process.env.PATH??'',HOME:home,LANG:'C',GOMAXPROCS:'2'}; let child,fd;
 const run=(args)=>{const x=spawnSync(t.loader,[...t.args,...args,'--home',home],{env,encoding:'utf8',timeout:30000,maxBuffer:4<<20,shell:false});if(x.status!==0)throw Error('IBC_CLI: '+x.stderr.slice(-2500));return x.stdout;};
 const rpcPort=await freePort(),restPort=await freePort(),p2pPort=await freePort();
 const rpcUrl=`http://127.0.0.1:${rpcPort}/`,restUrl=`http://127.0.0.1:${restPort}/`;
 const get=async u=>{const r=await fetch(u,{signal:AbortSignal.timeout(6000)});const s=await r.text();if(!r.ok)throw Error('IBC_GET: '+s.slice(0,500));return JSON.parse(s);};
 const rpc=async(method,params={})=>{const r=await fetch(rpcUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(6000)});const j=await r.json();if(j.error)throw Error('IBC_RPC: '+JSON.stringify(j.error));return j.result;};
 const head=async()=>Number((await rpc('status')).sync_info.latest_block_height);
 const waitHeight=h=>until(async()=>await head()>=h);
 const transaction=hash=>rpc('tx',{hash:Buffer.from(hash,'hex').toString('base64'),prove:true});
 let serial=0;
 async function tx(messages,{gas='10000000',fees='50000stake',expectFailure=false}={}){
  const raw={body:{messages,memo:'RealDEX disposable IBC fixture',timeout_height:'0',extension_options:[],non_critical_extension_options:[]},auth_info:{signer_infos:[],fee:{amount:[{denom:'stake',amount:fees.replace('stake','')}],gas_limit:gas,payer:'',granter:''}},signatures:[]};
  const f=path.join(home,'tx-'+serial+++'.json'),signed=f+'.signed';fs.writeFileSync(f,JSON.stringify(raw));
  run(['tx','sign',f,'--from','relayer','--chain-id',chainId,'--keyring-backend','test','--node',rpcUrl,'--output-document',signed]);
  const output=JSON.parse(run(['tx','broadcast',signed,'--node',rpcUrl,'--output','json']));
  if(Number(output.code??0)!==0)throw Error('IBC_CHECKTX: '+JSON.stringify(output));
  const result=await until(async()=>{try{return await transaction(output.txhash);}catch{return false;}});
  if(Number(result.tx_result.code??0)!==0&&!expectFailure)throw Error('IBC_EXEC: '+JSON.stringify(result.tx_result));
  return result;
 }
 try{
  run(['init',label,'--chain-id',chainId]);
  const relay=JSON.parse(run(['keys','add','relayer','--keyring-backend','test','--output','json']));
  run(['genesis','add-genesis-account',relay.address,'1000000000000stake']);
  run(['genesis','gentx','relayer','100000000stake','--chain-id',chainId,'--keyring-backend','test']);run(['genesis','collect-gentxs']);
  for(let i=0x31;i<=0x40;i++)run(['genesis','add-genesis-account',keyInfo('cosmos',Buffer.alloc(32,i)).address,'1000000000stake']);
  const cfg=path.join(home,'config/config.toml');let s=fs.readFileSync(cfg,'utf8');s=s.replace('tcp://127.0.0.1:26657','tcp://127.0.0.1:'+rpcPort).replace('tcp://0.0.0.0:26656','tcp://127.0.0.1:'+p2pPort).replace('timeout_commit = "5s"','timeout_commit = "300ms"').replace('pex = true','pex = false').replace('pprof_laddr = "localhost:6060"','pprof_laddr = ""');fs.writeFileSync(cfg,s);
  const log=path.join(home,'runtime.log');fd=fs.openSync(log,'w',0o600);
  child=spawn(t.loader,[...t.args,'start','--home',home,'--api.enable','--api.address',`tcp://127.0.0.1:${restPort}`,'--grpc.enable=false','--minimum-gas-prices','0stake','--log_level','error'],{env,shell:false,stdio:['ignore',fd,fd]});
  await until(async()=>{if(child.exitCode!==null)throw Error('IBC_NODE_EXIT: '+fs.readFileSync(log,'utf8').slice(-2000));return await head()>=3;});
  const checkpoint={height:1,hash:(await rpc('block',{height:'1'})).block_id.hash};
  const close=async()=>{if(child&&child.exitCode===null){child.kill('SIGTERM');await until(()=>child.exitCode!==null||child.signalCode!==null,6000).catch(()=>child.kill('SIGKILL'));}if(fd!==undefined)fs.closeSync(fd);if(logDirectory){fs.mkdirSync(logDirectory,{recursive:true});fs.copyFileSync(log,path.join(logDirectory,label+'-node.log'));}fs.rmSync(home,{recursive:true,force:true});};
  return {home,label,chainId,revision:'1',rpcUrl,restUrl,relay:relay.address,checkpoint,run,rpc,get,head,waitHeight,transaction,tx,close,
   balance:async(address,denom='stake')=>BigInt((await get(restUrl+'cosmos/bank/v1beta1/balances/'+address+'/by_denom?denom='+encodeURIComponent(denom))).balance.amount),
   state:async(endpoint,height)=>{const r=await fetch(restUrl+endpoint,{headers:height?{'x-cosmos-block-height':String(height)}:{},signal:AbortSignal.timeout(6000)});const j=await r.json();if(!r.ok)throw Error('IBC_STATE: '+JSON.stringify(j));return j;}
  };
 }catch(e){if(child)child.kill('SIGTERM');if(fd!==undefined)fs.closeSync(fd);fs.rmSync(home,{recursive:true,force:true});throw e;}
}
const headerJson=h=>({...h,last_block_id:{...h.last_block_id,hash:enc(h.last_block_id.hash),part_set_header:{...h.last_block_id.parts,hash:enc(h.last_block_id.parts.hash)}},...Object.fromEntries(['last_commit_hash','data_hash','validators_hash','next_validators_hash','consensus_hash','app_hash','last_results_hash','evidence_hash','proposer_address'].map(k=>[k,enc(h[k])]))});
function validatorJson(v){return {address:enc(v.address),pub_key:{ed25519:v.pub_key.value},voting_power:v.voting_power,proposer_priority:v.proposer_priority};}
async function validators(c,height){const x=await c.rpc('validators',{height:String(height),per_page:'100'});if(x.total!=='1')throw Error('IBC_FIXTURE_ONE_VALIDATOR');const list=x.validators.map(validatorJson);return {validators:list,proposer:list[0],total_voting_power:list[0].voting_power};}
async function lightHeader(c,height,trusted){
 const x=await c.rpc('commit',{height:String(height)}),h=x.signed_header.header,commit=x.signed_header.commit;
 const header=headerJson(h);delete header.last_block_id.parts;
 return {'@type':'/ibc.lightclients.tendermint.v1.Header',signed_header:{header,commit:{...commit,block_id:{hash:enc(commit.block_id.hash),part_set_header:{total:commit.block_id.parts.total,hash:enc(commit.block_id.parts.hash)}},signatures:commit.signatures.map(s=>({...s,validator_address:enc(s.validator_address)}))}},validator_set:await validators(c,height),trusted_height:{revision_number:c.revision,revision_height:String(trusted)},trusted_validators:await validators(c,trusted+1)};
}
const spec=[{leaf_spec:{hash:'SHA256',prehash_key:'NO_HASH',prehash_value:'SHA256',length:'VAR_PROTO',prefix:'AA=='},inner_spec:{child_order:[0,1],child_size:33,min_prefix_length:4,max_prefix_length:12,empty_child:'',hash:'SHA256'},max_depth:0,min_depth:0,prehash_key_before_comparison:false},{leaf_spec:{hash:'SHA256',prehash_key:'NO_HASH',prehash_value:'SHA256',length:'VAR_PROTO',prefix:'AA=='},inner_spec:{child_order:[0,1],child_size:32,min_prefix_length:1,max_prefix_length:1,empty_child:'',hash:'SHA256'},max_depth:0,min_depth:0,prehash_key_before_comparison:false}];
export async function createClient(host,other){
 const height=await other.head(),h=(await other.rpc('block',{height:String(height)})).block.header;
 const msg={'@type':'/ibc.core.client.v1.MsgCreateClient',client_state:{'@type':'/ibc.lightclients.tendermint.v1.ClientState',chain_id:other.chainId,trust_level:{numerator:'1',denominator:'3'},trusting_period:'1209600s',unbonding_period:'1814400s',max_clock_drift:'10s',frozen_height:{revision_number:'0',revision_height:'0'},latest_height:{revision_number:other.revision,revision_height:String(height)},proof_specs:spec,upgrade_path:['upgrade','upgradedIBCState'],allow_update_after_expiry:false,allow_update_after_misbehaviour:false},consensus_state:{'@type':'/ibc.lightclients.tendermint.v1.ConsensusState',timestamp:h.time,root:{hash:enc(h.app_hash)},next_validators_hash:h.next_validators_hash},signer:host.relay};
 const r=await host.tx([msg]);return eventAttr(r,'create_client','client_id');
}
export function eventAttr(r,type,key){const es=r.tx_result.events.filter(e=>e.type===type);for(const e of es){const a=e.attributes.find(x=>x.key===key);if(a)return a.value;}throw Error('IBC_EVENT_MISSING '+type+' '+key);}
export async function updateClient(host,other,clientId,height){
 const state=await host.state('ibc/core/client/v1/client_states/'+clientId);const trusted=Number(state.client_state.latest_height.revision_height);
 await other.waitHeight(height+1);if(trusted>=height)return;
 return host.tx([{'@type':'/ibc.core.client.v1.MsgUpdateClient',client_id:clientId,client_message:await lightHeader(other,height,trusted),signer:host.relay}]);
}
function varint(n){const r=[];do{r.push((n&127)|(n>127?128:0));n=Math.floor(n/128);}while(n);return Buffer.from(r);}
export async function proof(c,key,height){
 const r=(await c.rpc('abci_query',{path:'/store/ibc/key',data:Buffer.from(key).toString('hex'),height:String(height),prove:true})).response;
 if(Number(r.code)!==0||!r.proofOps?.ops?.length)throw Error('IBC_PROOF_MISSING '+JSON.stringify(r));
 const p=Buffer.concat(r.proofOps.ops.map(o=>{const b=Buffer.from(o.data,'base64');return Buffer.concat([Buffer.from([10]),varint(b.length),b]);}));
 return {proof:p.toString('base64'),proof_height:{revision_number:c.revision,revision_height:String(height+1)},value:r.value};
}
const prefix={key_prefix:Buffer.from('ibc').toString('base64')};
const versions=[{identifier:'1',features:['ORDER_ORDERED','ORDER_UNORDERED']}];
export async function connect(a,b){
 const ca=await createClient(a,b),cb=await createClient(b,a);
 const init=await a.tx([{'@type':'/ibc.core.connection.v1.MsgConnectionOpenInit',client_id:ca,counterparty:{client_id:cb,connection_id:'',prefix},version:versions[0],delay_period:'0',signer:a.relay}]);
 const ac=eventAttr(init,'connection_open_init','connection_id');
 let h=await a.head();await a.waitHeight(h+1);const cs=(await a.state('ibc/core/client/v1/client_states/'+ca,h)).client_state;
 const pinit=await proof(a,'connections/'+ac,h),pc=await proof(a,'clients/'+ca+'/clientState',h),pcon=await proof(a,'clients/'+ca+'/consensusStates/'+cs.latest_height.revision_number+'-'+cs.latest_height.revision_height,h);
 await updateClient(b,a,cb,h+1);
 const tr=await b.tx([{'@type':'/ibc.core.connection.v1.MsgConnectionOpenTry',client_id:cb,previous_connection_id:'',client_state:cs,counterparty:{client_id:ca,connection_id:ac,prefix},delay_period:'0',counterparty_versions:versions,proof_height:pinit.proof_height,proof_init:pinit.proof,proof_client:pc.proof,proof_consensus:pcon.proof,consensus_height:cs.latest_height,signer:b.relay,host_consensus_state_proof:''}]);
 const bc=eventAttr(tr,'connection_open_try','connection_id');
 h=await b.head();await b.waitHeight(h+1);const csb=(await b.state('ibc/core/client/v1/client_states/'+cb,h)).client_state;
 const ptry=await proof(b,'connections/'+bc,h),pcb=await proof(b,'clients/'+cb+'/clientState',h),pconsb=await proof(b,'clients/'+cb+'/consensusStates/'+csb.latest_height.revision_number+'-'+csb.latest_height.revision_height,h);
 await updateClient(a,b,ca,h+1);
 await a.tx([{'@type':'/ibc.core.connection.v1.MsgConnectionOpenAck',connection_id:ac,counterparty_connection_id:bc,version:versions[0],client_state:csb,proof_height:ptry.proof_height,proof_try:ptry.proof,proof_client:pcb.proof,proof_consensus:pconsb.proof,consensus_height:csb.latest_height,signer:a.relay,host_consensus_state_proof:''}]);
 h=await a.head();await a.waitHeight(h+1);const pack=await proof(a,'connections/'+ac,h);await updateClient(b,a,cb,h+1);
 await b.tx([{'@type':'/ibc.core.connection.v1.MsgConnectionOpenConfirm',connection_id:bc,proof_ack:pack.proof,proof_height:pack.proof_height,signer:b.relay}]);
 const ci=await a.tx([{'@type':'/ibc.core.channel.v1.MsgChannelOpenInit',port_id:'transfer',channel:{state:'STATE_INIT',ordering:'ORDER_UNORDERED',counterparty:{port_id:'transfer',channel_id:''},connection_hops:[ac],version:'ics20-1'},signer:a.relay}]);
 const ach=eventAttr(ci,'channel_open_init','channel_id');
 h=await a.head();await a.waitHeight(h+1);const cpi=await proof(a,`channelEnds/ports/transfer/channels/${ach}`,h);await updateClient(b,a,cb,h+1);
 const ct=await b.tx([{'@type':'/ibc.core.channel.v1.MsgChannelOpenTry',port_id:'transfer',previous_channel_id:'',channel:{state:'STATE_TRYOPEN',ordering:'ORDER_UNORDERED',counterparty:{port_id:'transfer',channel_id:ach},connection_hops:[bc],version:'ics20-1'},counterparty_version:'ics20-1',proof_init:cpi.proof,proof_height:cpi.proof_height,signer:b.relay}]);
 const bch=eventAttr(ct,'channel_open_try','channel_id');
 h=await b.head();await b.waitHeight(h+1);const cpt=await proof(b,`channelEnds/ports/transfer/channels/${bch}`,h);await updateClient(a,b,ca,h+1);
 await a.tx([{'@type':'/ibc.core.channel.v1.MsgChannelOpenAck',port_id:'transfer',channel_id:ach,counterparty_channel_id:bch,counterparty_version:'ics20-1',proof_try:cpt.proof,proof_height:cpt.proof_height,signer:a.relay}]);
 h=await a.head();await a.waitHeight(h+1);const cpa=await proof(a,`channelEnds/ports/transfer/channels/${ach}`,h);await updateClient(b,a,cb,h+1);
 await b.tx([{'@type':'/ibc.core.channel.v1.MsgChannelOpenConfirm',port_id:'transfer',channel_id:bch,proof_ack:cpa.proof,proof_height:cpa.proof_height,signer:b.relay}]);
 return {aClient:ca,bClient:cb,aConnection:ac,bConnection:bc,aChannel:ach,bChannel:bch};
}

/** Test-only permissionless relayer. All proofs are checked by ibc-go on the receiving chain. */
export function sentPacket(r) {
 const es=r.tx_result.events.filter(e=>e.type==='send_packet');if(es.length!==1)throw Error('IBC_PACKET_EVENT_COUNT');
 const a=Object.fromEntries(es[0].attributes.map(x=>[x.key,x.value]));
 const [revision_number,revision_height]=a.packet_timeout_height.split('-');
 return {sequence:a.packet_sequence,source_port:a.packet_src_port,source_channel:a.packet_src_channel,destination_port:a.packet_dst_port,destination_channel:a.packet_dst_channel,data:Buffer.from(a.packet_data_hex,'hex').toString('base64'),timeout_height:{revision_number,revision_height},timeout_timestamp:a.packet_timeout_timestamp};
}
export async function transfer(c,destination,channel,amount='1000000',denom='stake',timeoutSeconds=120) {
 const r=await c.tx([{'@type':'/ibc.applications.transfer.v1.MsgTransfer',source_port:'transfer',source_channel:channel,token:{denom,amount},sender:c.relay,receiver:destination,timeout_height:{revision_number:'0',revision_height:'0'},timeout_timestamp:String(BigInt(Date.now()+timeoutSeconds*1000)*1000000n),memo:''}]);
 return {result:r,packet:sentPacket(r)};
}
export async function receivePacket(source,destination,destClient,packet,{mutate}={}) {
 const h=await source.head();await source.waitHeight(h+1);
 const p=await proof(source,`commitments/ports/${packet.source_port}/channels/${packet.source_channel}/sequences/${packet.sequence}`,h);
 await updateClient(destination,source,destClient,h+1);
 const msg={'@type':'/ibc.core.channel.v1.MsgRecvPacket',packet,proof_commitment:p.proof,proof_height:p.proof_height,signer:destination.relay};
 if(mutate)mutate(msg);
 const r=await destination.tx([msg],{expectFailure:!!mutate});
 let acknowledgement=null;
 const ev=r.tx_result.events.find(e=>e.type==='write_acknowledgement');
 if(ev){const attributes=Object.fromEntries(ev.attributes.map(x=>[x.key,x.value]));acknowledgement=Buffer.from(attributes.packet_ack_hex,'hex').toString('base64');}
 return {result:r,acknowledgement};
}
export async function acknowledgePacket(source,destination,sourceClient,packet,acknowledgement,{mutate}={}) {
 const h=await destination.head();await destination.waitHeight(h+1);
 const p=await proof(destination,`acks/ports/${packet.destination_port}/channels/${packet.destination_channel}/sequences/${packet.sequence}`,h);
 await updateClient(source,destination,sourceClient,h+1);
 const msg={'@type':'/ibc.core.channel.v1.MsgAcknowledgement',packet,acknowledgement,proof_acked:p.proof,proof_height:p.proof_height,signer:source.relay};
 if(mutate)mutate(msg);
 return source.tx([msg],{expectFailure:!!mutate});
}
export async function timeoutPacket(source,destination,sourceClient,packet,{mutate}={}) {
 const h=await destination.head();await destination.waitHeight(h+1);
 const p=await proof(destination,`receipts/ports/${packet.destination_port}/channels/${packet.destination_channel}/sequences/${packet.sequence}`,h);
 await updateClient(source,destination,sourceClient,h+1);
 const msg={'@type':'/ibc.core.channel.v1.MsgTimeout',packet,proof_unreceived:p.proof,proof_height:p.proof_height,next_sequence_recv:'1',signer:source.relay};
 if(mutate)mutate(msg);
 return source.tx([msg],{expectFailure:!!mutate});
}
