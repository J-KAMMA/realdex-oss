/** Protocol-specific read allowlists. Reject unexpected fields even when a node
 * would ignore them: ignored RPC parameters can still leak wallet secrets. */
import {check,keys,uint} from './guard.mjs';
import {hashHex,hexUint} from '../chains/core.mjs';
import {readHttp} from './http.mjs';
const integer=n=>{check(typeof n==='number'&&Number.isSafeInteger(n)&&n>=0,'HEIGHT_INVALID');};
export function readProtocol(protocol,endpoint,options={}){
 check(['monero','utxo-core','evm','cometbft','icp'].includes(protocol),'PROTOCOL_UNSUPPORTED');const request=readHttp(endpoint,options);let seq=0;
 return Object.freeze({async rpc(method,params=[]){
  check(typeof method==='string','READ_METHOD_FORBIDDEN');let valid=false;
  if(protocol==='monero'){
   if(method==='get_info'){keys(params,[]);valid=true;}
   if(method==='get_block_header_by_height'){keys(params,['height']);integer(params.height);valid=true;}
  }
  if(protocol==='utxo-core'){
   check(Array.isArray(params),'PARAMS_INVALID');
   if(method==='getblockchaininfo'&&params.length===0)valid=true;
   if(method==='getblockhash'&&params.length===1){integer(params[0]);valid=true;}
   if(method==='getblockheader'&&params.length===2&&params[1]===true){hashHex(params[0],false);valid=true;}
  }
  if(protocol==='cometbft'){
   if(method==='status'&&Array.isArray(params)&&params.length===0)valid=true;
   if(method==='block'){keys(params,['height']);uint(params.height);valid=true;}
  }
  if(protocol==='evm'){
   check(Array.isArray(params),'PARAMS_INVALID');
   if(['eth_chainId','eth_syncing'].includes(method)&&params.length===0)valid=true;
   if(method==='eth_getBlockByNumber'&&params.length===2&&params[1]===false){if(params[0]!=='latest')hexUint(params[0]);valid=true;}
  }
  check(valid,'READ_METHOD_FORBIDDEN');const id=String(++seq),r=await request({json:{jsonrpc:protocol==='utxo-core'?'1.0':'2.0',id,method,params}});
  check(r&&typeof r==='object'&&!Array.isArray(r),'RPC_ENVELOPE_INVALID');check(r.id===id,'RPC_ID_MISMATCH');
  check(r.jsonrpc==='2.0'||protocol==='utxo-core'&&[undefined,'1.0'].includes(r.jsonrpc),'RPC_VERSION_INVALID');
  check(r.error===undefined||r.error===null,'RPC_REMOTE_ERROR');check(Object.hasOwn(r,'result')&&r.result!==null,'RPC_RESULT_MISSING');return r.result;
 },async rosetta(path,body){
  check(protocol==='icp'&&['/network/list','/network/status','/block'].includes(path),'READ_PATH_FORBIDDEN');
  if(path==='/network/list')keys(body,[]);else {
   keys(body,['network_identifier'],path==='/block'?['block_identifier']:[]);const n=body.network_identifier;keys(n,['blockchain','network']);
   check(n.blockchain==='Internet Computer'&&typeof n.network==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(n.network),'ROSETTA_NETWORK_INVALID');
   if(path==='/block'){keys(body.block_identifier,['index']);integer(body.block_identifier.index);}
  }
  return request({path,json:body});
 }});
}
