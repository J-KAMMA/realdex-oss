import fs from 'node:fs';
import {extendedRegistry} from '../extended/registry.mjs';
import {encodeCbor,decodeCbor} from '../icp/cbor.mjs';
import {principalBytes} from '../icp/principal.mjs';
export const networks=extendedRegistry(JSON.parse(fs.readFileSync(new URL('../extended/networks.json',import.meta.url),'utf8')));
export const vectors=JSON.parse(fs.readFileSync(new URL('./v06-candid-vectors.json',import.meta.url),'utf8')).vectors;
export const NOW=Date.UTC(2026,8,5,0,0,0),H=n=>BigInt(n).toString(16).padStart(64,'0'),ICP='ryjl3-tyaaa-aaaaa-aaaba-cai',CKBTC='mxzaz-hqaaa-aaaar-qaada-cai';
export function request(p=networks.get('monero:mainnet'),extra={}){
 return {profile:p,endpoints:['http://127.0.0.1:18081','http://127.0.0.1:18082'],now:()=>NOW,
  ...(p.family==='cometbft'?{identityAnchor:{height:'1',hash:H(1)}}:{genesisPin:H(0)}),
  ...(p.family==='icp'?{ledger:{canister:ICP,networkFormat:'hex'}}:{}),...extra};
}
export function wire(p,url,init,ledger={canister:ICP,networkFormat:'hex'}){
 const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):{},time=NOW/1000;
 const target=ledger.networkFormat==='hex'?Buffer.from(principalBytes(ledger.canister)).toString('hex'):ledger.canister;
 const net={blockchain:'Internet Computer',network:target};
 if(p.family==='icp'){
  if(path.endsWith('/network/list'))return {network_identifiers:[net]};
  if(path.endsWith('/network/status'))return {genesis_block_identifier:{index:0,hash:H(0)},current_block_identifier:{index:100,hash:H(100)},current_block_timestamp:NOW,sync_status:{synced:true}};
  if(path.endsWith('/block')){const n=body.block_identifier.index;return {block:{block_identifier:{index:n,hash:H(n)},parent_block_identifier:{index:Math.max(0,n-1),hash:H(Math.max(0,n-1))},timestamp:NOW,transactions:[]}};}
  throw Error('FIXTURE_PATH_UNSUPPORTED');
 }
 const method=body.method,params=body.params;let result;
 const block=n=>({height:n,hash:H(n),time,parentHash:H(Math.max(0,n-1))});
 if(p.family==='monero'){
  if(method==='get_info')result={status:'OK',untrusted:false,synchronized:true,busy_syncing:false,offline:false,nettype:p.networkIdentity,height:101,top_block_hash:H(100),wide_cumulative_difficulty:'0x1000000000000000000'};
  if(method==='get_block_header_by_height'){const n=params.height;result={status:'OK',untrusted:false,block_header:{height:n,hash:H(n),prev_hash:H(Math.max(0,n-1)),timestamp:n?time:0,orphan_status:false}};}
 }
 if(p.family==='utxo-core'){
  if(method==='getblockchaininfo')result={chain:p.networkIdentity,blocks:100,headers:100,bestblockhash:H(100),initialblockdownload:false,verificationprogress:0.9999999};
  if(method==='getblockhash')result=H(params[0]);
  if(method==='getblockheader'){const n=Number(BigInt('0x'+params[0]));result={height:n,hash:H(n),previousblockhash:H(Math.max(0,n-1)),time:n?time:0,confirmations:101-n};}
 }
 if(p.family==='cometbft'){
  if(method==='status')result={node_info:{network:p.networkIdentity},sync_info:{catching_up:false,latest_block_height:'100',latest_block_hash:H(100),latest_block_time:new Date(NOW).toISOString()}};
  if(method==='block'){const n=Number(params.height);result={block_id:{hash:H(n)},block:{header:{chain_id:p.networkIdentity,height:String(n),time:new Date(NOW).toISOString()}}};}
 }
 if(p.family==='evm'){
  if(method==='eth_chainId')result='0x'+BigInt(p.networkIdentity).toString(16);
  if(method==='eth_syncing')result=false;
  if(method==='eth_getBlockByNumber'){const n=params[0]==='latest'?100:Number(BigInt(params[0]));result={number:'0x'+n.toString(16),hash:'0x'+H(n),parentHash:'0x'+H(Math.max(0,n-1)),timestamp:'0x'+(n?time:0).toString(16)};}
 }
 if(result===undefined)throw Error('FIXTURE_METHOD_UNSUPPORTED');return {jsonrpc:p.family==='utxo-core'?'1.0':'2.0',id:body.id,result};
}
export function fixtureFetch(p,{calls=[],transform=x=>x,ledger}={}){
 return async(url,init)=>{const event={url:String(url),method:init.method,body:JSON.parse(init.body??'{}'),init};calls.push(event);
  const response=await transform(wire(p,url,init,ledger),event);return new Response(typeof response==='string'?response:JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});};
}
export function icrcFetch({calls=[],transform=x=>x}={}){
 return async(url,init)=>{const payload=decodeCbor(init.body),event={url:String(url),payload,init};calls.push(event);
  const method=payload.content.method_name;if(!vectors[method])throw Error('FIXTURE_METHOD_UNSUPPORTED');
  let reply={status:'replied',reply:{arg:new Uint8Array(Buffer.from(vectors[method],'hex'))}};reply=await transform(reply,event);
  return new Response(encodeCbor(reply),{headers:{'content-type':'application/cbor'}});
 };
}
