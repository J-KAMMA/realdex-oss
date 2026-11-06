/** REAL pinned simd, one validator, no P2P peers. HTTP forwarding only; no mock state. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import http from 'node:http';
import {spawn,spawnSync} from 'node:child_process';
import {verifiedSimd} from './toolchain.mjs';
import {keyInfo} from '../../wallet/lib/keys.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
import {validateCosmosNetwork} from '../../wallet/non-evm/cosmos-network.mjs';
import {decodeCosmos} from '../../wallet/test/cosmos-online-fixtures.mjs';
export async function waitFor(fn,timeout=15000){let last;for(const end=Date.now()+timeout;Date.now()<end;){try{const v=await fn();if(v)return v;}catch(e){last=e;}await new Promise(r=>setTimeout(r,80));}throw last??Error('COSMOS_RUNTIME_TIMEOUT');}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export async function startSimd({lastKey=0x50}={}){
 if(!Number.isInteger(lastKey)||lastKey<0x50||lastKey>0x70)throw Error('TEST_KEY_LIMIT_INVALID');
 const binary=verifiedSimd(process.env.REALDEX_SIMD_BINARY),home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-simd-')),chainId='realdex-local-runtime',env={};
 for(const k of ['PATH','HOME','LANG','LC_ALL','TMPDIR'])if(process.env[k])env[k]=process.env[k];
 function run(args){const r=spawnSync(binary,[...args,'--home',home],{encoding:'utf8',timeout:30000,env,shell:false});if(r.status!==0)throw Error('SIMD_SETUP_FAILED: '+r.stderr.slice(-1000));return r.stdout;}
 let child,fd;
 try{
  run(['init','single-test-validator','--chain-id',chainId]);
  const validator=JSON.parse(run(['keys','add','validator','--keyring-backend','test','--output','json']));
  run(['genesis','add-genesis-account',validator.address,'1000000000000stake']);
  run(['genesis','gentx','validator','100000000stake','--chain-id',chainId,'--keyring-backend','test']);run(['genesis','collect-gentxs']);
  // All keys below are public disposable test vectors, not user keys.
  for(let i=0x31;i<=lastKey;i++)run(['genesis','add-genesis-account',keyInfo('cosmos',Buffer.alloc(32,i)).address,'1000000000stake,1000000000ugas']);
  const to=keyInfo('cosmos',Buffer.alloc(32,0x7f)).address;run(['genesis','add-genesis-account',to,'1000000000stake,1000000000ugas']);
  const rpcPort=await port(),apiPort=await port(),p2pPort=await port();
  const cfg=path.join(home,'config/config.toml');let s=fs.readFileSync(cfg,'utf8');s=s.replace('tcp://127.0.0.1:26657',`tcp://127.0.0.1:${rpcPort}`).replace('tcp://0.0.0.0:26656',`tcp://127.0.0.1:${p2pPort}`).replace('timeout_commit = "5s"','timeout_commit = "500ms"').replace('pex = true','pex = false').replace('pprof_laddr = "localhost:6060"','pprof_laddr = ""');fs.writeFileSync(cfg,s);
  fd=fs.openSync(path.join(home,'runtime.log'),'w',0o600);
  child=spawn(binary,['start','--home',home,'--api.enable','--api.address',`tcp://127.0.0.1:${apiPort}`,'--grpc.enable=false','--minimum-gas-prices','0.001stake,0.001ugas','--log_level','error'],{env,stdio:['ignore',fd,fd],shell:false});
  const rpcUrl=`http://127.0.0.1:${rpcPort}/`,restUrl=`http://127.0.0.1:${apiPort}/`;
  const get=async url=>{const r=await fetch(url,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error('SIMD_READ_FAILED');return r.json();};
  await waitFor(async()=>{if(child.exitCode!==null)throw Error('SIMD_EXITED '+fs.readFileSync(path.join(home,'runtime.log'),'utf8').slice(-3000));return Number((await get(rpcUrl+'status')).result.sync_info.latest_block_height)>=3;});
  const checkpoint={height:1,hash:(await get(rpcUrl+'block?height=1')).result.block_id.hash};
  const balance=async(address,denom='stake')=>BigInt((await get(restUrl+'cosmos/bank/v1beta1/spendable_balances/'+address+'/by_denom?denom='+denom)).balance.amount);
  const account=async a=>(await get(restUrl+'cosmos/auth/v1beta1/accounts/'+a)).account;
  let next=0x31;
  const close=async()=>{if(child?.exitCode===null){child.kill('SIGTERM');await waitFor(()=>child.exitCode!==null||child.signalCode!==null,8000).catch(()=>child.kill('SIGKILL'));}if(fd!==undefined){fs.closeSync(fd);fd=undefined;}fs.rmSync(home,{recursive:true,force:true});};
  return {binary,home,chainId,to,rpcUrl,restUrl,checkpoint,get,balance,account,close,nextKey(){if(next>lastKey)throw Error('TEST_KEYS_EXHAUSTED');return next++;}};
 }catch(e){child?.kill('SIGTERM');if(fd!==undefined)fs.closeSync(fd);fs.rmSync(home,{recursive:true,force:true});throw e;}
}
export async function simdWalletFixture(chain,overrides={},options={}){
 const store=storeFixture(),vault=new Vault(store.store);await vault.create(PASSWORD);const key=chain.nextKey(),account=await vault.addAccount({family:'cosmos',label:'PUBLIC DISPOSABLE VECTOR',secretHex:Buffer.alloc(32,key).toString('hex')});const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 const state={sent:0,simulationSignaturesChecked:0,drop:false,hide:false,mutate:null,delay:null,calls:[]},servers=[];
 const accountNumber=(await chain.account(account.address)).account_number;
 async function forward(target,peer){const s=http.createServer(async(req,res)=>{
  try{const chunks=[];for await(const c of req)chunks.push(c);const b=Buffer.concat(chunks),body=b.length?JSON.parse(b):null,info={path:req.url,peer,method:body?.method??req.method};state.calls.push(info);if(state.delay)await state.delay(info);
   if(req.url.endsWith('/simulate')){if(options.decodeSimulation)await options.decodeSimulation(Buffer.from(body.tx_bytes,'base64'));else decodeCosmos(Buffer.from(body.tx_bytes,'base64'),chain.chainId,accountNumber,{simulation:true});state.simulationSignaturesChecked++;}
   if(body?.method==='tx'&&state.hide){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32603,message:'injected unavailable'}}));return;}
   if(req.url.endsWith('/txs'))state.sent++;
   const r=await fetch(target.replace(/\/$/,'')+req.url,{method:req.method,headers:{'content-type':'application/json',...(req.headers['x-cosmos-block-height']?{'x-cosmos-block-height':req.headers['x-cosmos-block-height']}:{})},...(req.method==='POST'?{body:b}:{}),signal:AbortSignal.timeout(10000)});
   const text=await r.text();if(req.url.endsWith('/txs')&&state.drop){req.socket.destroy();return;}
   let output=text;if(state.mutate){let json=JSON.parse(text);json=state.mutate(json,info)??json;output=JSON.stringify(json);}
   const headers={'content-type':'application/json'};if(r.headers.has('x-cosmos-block-height'))headers['x-cosmos-block-height']=r.headers.get('x-cosmos-block-height');res.writeHead(r.status,headers);res.end(output);
  }catch(e){if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'TEST_PROXY_FAILURE'}));}}
 });await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);return `http://127.0.0.1:${s.address().port}/`;}
 const endpoints=[];for(let i=0;i<2;i++)endpoints.push({rpcUrl:await forward(chain.rpcUrl,i),restUrl:await forward(chain.restUrl,i)});
 const network=validateCosmosNetwork({family:'cosmos',id:'cosmos:'+chain.chainId,name:'SINGLE REAL SIMD TEST',chainId:chain.chainId,hrp:'cosmos',endpoints,checkpoint:chain.checkpoint,denom:'stake',decimals:6,symbol:'SIM',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'100000000',maxFeeAtomic:'10000',maxGasLimit:'500000',timeoutBlocks:100,minConfirmations:1,broadcastEnabled:true,...overrides});
 const app=new WalletServer({store:store.store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[],cosmosNetworks:[network]}});const started=await app.start(0);
 const call=async(route,body={})=>{const r=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const payment=(e={})=>({requestKey:'real-cosmos',to:chain.to,amountAtomic:'1250000',feeAtomic:'500',gasLimit:'200000',memo:'RealDEX local test',...e});
 const prepare=(e={})=>call('non-evm/cosmos-online/prepare',{accountId:account.id,networkId:network.id,payment:payment(e)});
 const approve=async(p,broadcast=false)=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:chain.to,broadcast})).record;
 const reconcile=r=>call('non-evm/cosmos-online/reconcile',{id:r.id});
 const settled=r=>waitFor(async()=>{const x=await reconcile(r);return x.state==='reported-confirmed'?x:false;},15000);
 const close=async()=>{await app.close();for(const s of servers){s.closeAllConnections();await new Promise(r=>s.close(r));}store.close();};
 return {state,store,vault,account,key,app,network,started,call,payment,prepare,approve,reconcile,settled,close};
}
