// Synthetic protocol fixtures. No live-chain data or real balances.
import fs from 'node:fs';
import {makeRegistry} from '../chains/registry.mjs';
export const registry=makeRegistry(JSON.parse(fs.readFileSync(new URL('../chains/profiles.json',import.meta.url),'utf8')));
export const NOW=Date.parse('2026-09-05T00:00:10Z'),SECONDS=Math.floor(NOW/1000)-10,ISO=new Date(SECONDS*1000).toISOString();
export const H=n=>BigInt(n).toString(16).padStart(64,'0');
export const B64=n=>Buffer.alloc(32,n).toString('base64');
export function B58(n){let value=BigInt(n),out='',zeros=32;for(let x=value;x>0n;x>>=8n)zeros--;const abc='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';while(value){out=abc[Number(value%58n)]+out;value/=58n;}return '1'.repeat(zeros)+out;}
export const IDS={evm:'eip155:1',solana:'solana:mainnet-beta',cosmos:'cosmos:cosmoshub-4',aptos:'aptos:1',sui:'sui:35834a8a',near:'near:mainnet',bitcoin:'bitcoin:main',stellar:'stellar:public',xrpl:'xrpl:mainnet',substrate:'substrate:polkadot',algorand:'algorand:mainnet-v1.0',starknet:'starknet:mainnet',tezos:'tezos:mainnet',tron:'tron:mainnet',ton:'ton:mainnet'};
export function profile(family){return registry.get(IDS[family]);}
export function pin(family){return family==='solana'?B58(0):family==='substrate'?'0x'+H(0):family==='tron'?H(0):family==='ton'?B64(0):undefined;}
function block(f,h=100){
 const hx=H(h+1000),b58=B58(h+1000);
 switch(f){
 case 'evm':return {number:'0x'+BigInt(h).toString(16),hash:'0x'+(h===0?H(0):hx),timestamp:'0x'+SECONDS.toString(16)};
 case 'solana':return {blockhash:b58,previousBlockhash:B58(h+999),blockHeight:h-10,blockTime:SECONDS};
 case 'cosmos':return {block_id:{hash:hx.toUpperCase()},block:{header:{chain_id:'cosmoshub-4',height:String(h),time:ISO}}};
 case 'aptos':return {block_height:String(h),block_hash:'0x'+hx,block_timestamp:String(SECONDS*1e6)};
 case 'sui':return {sequenceNumber:h,digest:b58,timestamp:ISO};
 case 'near':return {header:{height:h,hash:b58,timestamp_nanosec:String(BigInt(SECONDS)*1000000000n)}};
 case 'bitcoin':return {height:h,hash:hx,confirmations:101-h,time:SECONDS};
 case 'stellar':return {sequence:h,hash:hx,closed_at:ISO};
 case 'xrpl':return {status:'success',validated:true,ledger_index:h,ledger_hash:hx,ledger:{ledger_index:String(h),ledger_hash:hx,closed:true,close_time:SECONDS-946684800}};
 case 'substrate':return {number:'0x'+h.toString(16).padStart(8,'0'),stateRoot:'0x'+H(4),extrinsicsRoot:'0x'+H(5)};
 case 'algorand':return {block:{rnd:h,ts:SECONDS,gen:'mainnet-v1.0',gh:B64(0)}};
 case 'starknet':return {status:'ACCEPTED_ON_L2',block_number:h,block_hash:'0x'+BigInt(h+1000).toString(16),timestamp:SECONDS};
 case 'tezos':return {level:h,timestamp:ISO};
 case 'tron':return {blockID:BigInt(h).toString(16).padStart(16,'0')+(h===0?'0'.repeat(48):H(h).slice(16)),block_header:{raw_data:{...(h?{number:h}:{}),timestamp:SECONDS*1000}}};
 }
}
const tid=h=>({'@type':'ton.blockIdExt',workchain:-1,shard:'-9223372036854775808',seqno:h,root_hash:B64(h%256),file_hash:B64((h+1)%256)});
export function wire(family,url,init={}){
 const u=new URL(url),data=init.body?JSON.parse(init.body):{},m=data.method,p=data.params??[],rpc=Object.hasOwn(data,'method');let result;
 if(rpc){
  if(family==='evm')result=m==='eth_chainId'?'0x1':block(family,p[0]==='latest'?100:Number(BigInt(p[0])));
  if(family==='solana')result=m==='getGenesisHash'?B58(0):m==='getSlot'?100:block(family,p[0]);
  if(family==='cosmos')result=m==='status'?{node_info:{network:'cosmoshub-4'},sync_info:{catching_up:false,latest_block_height:'100'}}:block(family,Number(p.height));
  if(family==='near')result=m==='status'?{chain_id:'mainnet',sync_info:{syncing:false}}:block(family,p.block_id??100);
  if(family==='bitcoin')result=m==='getblockchaininfo'?{chain:'main',blocks:100,headers:100,initialblockdownload:false}:m==='getblockhash'?(p[0]===0?H(0):H(p[0]+1000)):block(family,Number(BigInt('0x'+p[0]))-1000);
  if(family==='xrpl')result=m==='server_info'?{status:'success',info:{network_id:0,server_state:'full'}}:block(family,p[0].ledger_index==='validated'?100:p[0].ledger_index);
  if(family==='substrate')result=m==='chain_getBlockHash'?'0x'+H(p[0]):m==='chain_getFinalizedHead'?'0x'+H(100):block(family,Number(BigInt(p[0])));
  if(family==='starknet')result=m==='starknet_chainId'?'0x'+Buffer.from('SN_MAIN').toString('hex'):block(family,p[0]==='latest'?100:p[0].block_number);
  if(result===undefined)throw Error('FIXTURE_RPC_UNKNOWN');return family==='xrpl'?{result}:family==='bitcoin'?{result,error:null,id:data.id}:{jsonrpc:'2.0',id:data.id,result};
 }
 if(family==='sui')return {data:data.query.includes('chainIdentifier')?{chainIdentifier:'35834a8a',checkpoint:block('sui')}:{checkpoint:block('sui',data.variables.height)}};
 if(family==='aptos')return u.pathname.includes('/blocks/')?block(family,Number(u.pathname.split('/').at(-1))):{chain_id:1,ledger_version:'999999',block_height:'100'};
 if(family==='stellar')return u.pathname.includes('/ledgers/')?block(family,Number(u.pathname.split('/').at(-1))):{network_passphrase:'Public Global Stellar Network ; September 2015',history_latest_ledger:100};
 if(family==='algorand'){
  if(u.pathname.endsWith('/versions'))return {genesis_id:'mainnet-v1.0',genesis_hash_b64:B64(0)};
  if(u.pathname.endsWith('/status'))return {'last-round':100,'catchup-time':0};
  if(u.pathname.endsWith('/hash'))return {blockHash:'A'.repeat(52)};
  return block(family,Number(u.pathname.split('/').at(-1)));
 }
 if(family==='tezos'){
  if(u.pathname.endsWith('/chain_id'))return 'NetXdQprcVkpaWU';
  if(u.pathname.endsWith('/hash'))return 'B'+'a'.repeat(50);
  const h=u.pathname.split('/').at(-2);return block(family,h==='head'?100:Number(h));
 }
 if(family==='tron')return block(family,u.pathname.endsWith('/getnowblock')?100:data.num);
 if(family==='ton'){
  if(u.pathname.endsWith('/getMasterchainInfo'))return {ok:true,result:{last:tid(100),init:tid(0)}};
  if(u.pathname.endsWith('/lookupBlock'))return {ok:true,result:tid(Number(u.searchParams.get('seqno')))};
  if(u.pathname.endsWith('/getBlockHeader'))return {ok:true,result:{id:tid(Number(u.searchParams.get('seqno'))),global_id:-239,gen_utime:SECONDS}};
 }
 throw Error('FIXTURE_PATH_UNKNOWN');
}
export function fetchFixture(family,{transform,log=[]}={}){return async(url,init)=>{init.signal?.throwIfAborted();const item={url,method:init.method,body:init.body?JSON.parse(init.body):null};log.push(item);let out=wire(family,url,init);if(transform)out=transform(out,item,log.length)??out;return new Response(JSON.stringify(out),{headers:{'content-type':'application/json'}});};}
export function request(family,extra={}){return {profile:profile(family),endpoints:['https://one.example','https://two.example'],...(pin(family)?{genesisPin:pin(family)}:{}),now:()=>NOW,fetchImpl:fetchFixture(family),...extra};}
