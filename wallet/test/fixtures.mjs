import {parseSignedEvmTransaction} from '../lib/transactions.mjs';
/** Public test keys and SYNTHETIC RPCs only. Never a chain/EVM implementation. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {PrivateStore} from '../lib/storage.mjs';
import {Vault} from '../lib/vault.mjs';
import {WalletServer} from '../lib/server.mjs';
import {EvmEngine} from '../lib/evm-engine.mjs';
import {Rpc,validateNetwork} from '../lib/network.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
export const PASSWORD='public test password, not a user secret';
export const KEY='46'.repeat(32);
export const TO='0x'+'35'.repeat(20);
export const GENESIS='0x'+'11'.repeat(32), BLOCK='0x'+'22'.repeat(32);
export function storeFixture(){const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-wallet-test-'));const store=new PrivateStore(directory);return {directory,store,close(){store.close();fs.rmSync(directory,{recursive:true,force:true});}};}
export async function vaultFixture(options={}){const f=storeFixture(),vault=new Vault(f.store,options);await vault.create(PASSWORD);const account=await vault.addAccount({family:'evm',label:'Public vector test key',secretHex:KEY});return {...f,vault,account,async backup(){const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);return b;},close(){vault.lock();f.close();}};}
export async function syntheticRpc(){
  const state={now:Date.now(),chain:'0x7a69',nonce:'0x0',pendingNonce:null,balance:'0x3635c9adc5dea00000',code:{},genesis:GENESIS,block:BLOCK,dropSend:false,wrongSendHash:false,receipt:null,sent:[],calls:[],secondMismatch:null,delay:null};
  const servers=[];
  for(let peer=0;peer<2;peer++){
    const server=http.createServer(async(req,res)=>{let chunks=[];for await(const c of req)chunks.push(c);const {id,method,params}=JSON.parse(Buffer.concat(chunks));state.calls.push({peer,method,params});
      if(state.delay)await state.delay(method);
      let result;
      switch(method){
        case 'eth_chainId':result=state.chain;break;
        case 'eth_blockNumber':result=state.height??'0x10';break;
        case 'eth_getBlockByNumber':{
          const height=['safe','finalized'].includes(params[0])?(state.finalityHeight??state.height??'0x10'):params[0];
          result=state.blocks?.[height]??{hash:height==='0x0'?state.genesis:state.block,number:height,timestamp:'0x'+Math.floor(state.now/1000).toString(16),baseFeePerGas:'0x3b9aca00',transactions:state.receipt?[state.receipt.transactionHash]:[]};break;
        }
        case 'eth_getTransactionCount':result=params[1]==='pending'?(state.pendingNonce??state.nonce):state.nonce;break;
        case 'eth_getBalance':result=state.balance;break;
        case 'eth_getCode':result=state.code[params[0]]??'0x';break;
        case 'eth_gasPrice':result='0xb2d05e00';break;
        case 'eth_estimateGas':result=state.estimate??'0x5208';break;
        case 'eth_call':result=state.callResponses?.[params[0].to.toLowerCase()+':'+params[0].data]??state.callValues?.[params[0].data]??(params[0].data==='0x313ce567'?'0x'+BigInt(state.tokenDecimals??18).toString(16).padStart(64,'0'):params[0].data?.startsWith('0x70a08231')?'0x'+BigInt(state.tokenBalance??1000000000000000000000n).toString(16).padStart(64,'0'):params[0].data?.startsWith('0xdd62ed3e')?'0x'+BigInt(state.tokenAllowance??0).toString(16).padStart(64,'0'):state.callResult??'0x');break;
        case 'eth_getTransactionReceipt':result=state.receipt?{transactionIndex:'0x0',gasUsed:'0x5208',effectiveGasPrice:'0x3b9aca00',logs:[],...state.receipt}:null;break;
        case 'eth_getTransactionByHash':{
          if(state.transaction!==undefined){result=state.transaction;break;}
          const raw=[...state.sent,...(state.knownSigned??[])].find(raw=>keccak256(raw)===params[0]);
          if(!raw||!state.receipt){result=null;break;}
          const parsed=parseSignedEvmTransaction(raw),t=parsed.transaction,qty=v=>'0x'+BigInt(v).toString(16);
          result={hash:parsed.transactionHash,from:parsed.from,to:t.to,nonce:qty(t.nonce),value:qty(t.value),input:t.data,gas:qty(t.gasLimit),type:qty(t.type),chainId:qty(t.chainId),blockHash:state.receipt.blockHash,blockNumber:state.receipt.blockNumber,transactionIndex:'0x0',...(t.type===2?{maxFeePerGas:qty(t.maxFeePerGas),maxPriorityFeePerGas:qty(t.maxPriorityFeePerGas),accessList:[]}:{gasPrice:qty(t.gasPrice)})};break;
        }
        case 'eth_sendRawTransaction':state.sent.push(params[0]);if(state.dropSend){req.socket.destroy();return;}result=state.wrongSendHash?GENESIS:keccak256(params[0]);break;
        default:res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32601,message:'synthetic unsupported'}}));return;
      }
      if(peer===1&&state.secondMismatch===method)result=method==='eth_getCode'?'0x00':'0xdead';
      res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,result}));
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
  }
  const rpcUrls=servers.map(s=>`http://127.0.0.1:${s.address().port}/`);
  const network=validateNetwork({chainId:'31337',name:'SYNTHETIC test network',symbol:'TEST',rpcUrls,genesisHash:GENESIS,broadcastEnabled:true,contracts:[],maxFeeWei:'10000000000000000',maxSlippageBps:100});
  return {state,network,async close(){await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));}};
}
export async function serverFixture(){
  const rpc=await syntheticRpc(),f=await vaultFixture({now:()=>rpc.state.now});await f.backup();
  const app=new WalletServer({store:f.store,vault:f.vault,settings:{schema:'realdex.wallet-settings.v1',networks:[rpc.network],allowedAppOrigins:['http://127.0.0.1:5173']},engine:new EvmEngine({rpc:new Rpc(),now:()=>rpc.state.now}),now:()=>rpc.state.now});
  const start=await app.start(0);
  const ui=(route,body={})=>fetch(start.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',origin:start.origin,authorization:'Bearer '+app.uiToken},body:JSON.stringify(body)});
  const call=async(route,body={})=>{const r=await ui(route,body),b=await r.json();if(!r.ok)throw Error(b.error);return b;};
  const bridge=async(route,body,origin='http://127.0.0.1:5173')=>{const r=await fetch(start.origin+'/bridge/'+route,{method:'POST',headers:{'content-type':'application/json','x-realdex-bridge':'1',origin},body:JSON.stringify(body)});return {status:r.status,body:await r.json(),headers:r.headers};};
  return {...f,...rpc,app,start,ui,call,bridge,async close(){await app.close();await rpc.close();fs.rmSync(f.directory,{recursive:true,force:true});}};
}
export async function waitFor(fn,timeout=3000){const until=Date.now()+timeout;while(Date.now()<until){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('TEST_WAIT_TIMEOUT');}
