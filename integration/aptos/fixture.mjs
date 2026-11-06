/** Adapted from the 2026-09-06 v0.16 branch to the v0.17 owner API.
 * One real, isolated local Aptos validator. Two local HTTP forwarders are NOT independent validators. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {verifiedAptos,APTOS_PIN} from './toolchain.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';import {PrivateStore} from '../../wallet/lib/storage.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';import {keyInfo} from '../../wallet/lib/keys.mjs';
import {validateAccountNetwork} from '../../wallet/non-evm/account-network.mjs';
export const PASSWORD='public real-Aptos test password; never user data';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
async function json(url,init={}){const r=await fetch(url,{...init,signal:AbortSignal.timeout(15000)});assert.ok(r.ok,'real local Aptos returned HTTP '+r.status);return r.json();}
export async function startAptos(){
 const binary=verifiedAptos(process.env.REALDEX_APTOS_BINARY),directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-aptos-test-'));fs.chmodSync(directory,0o700);
 const version=spawnSync(binary,['--version'],{encoding:'utf8',timeout:10000});assert.equal(version.status,0);assert.equal(version.stdout.trim(),'aptos '+APTOS_PIN.version);
 const [apiPort,faucetPort,readyPort,validatorPort,metricsPort]=await Promise.all(Array.from({length:5},port));assert.equal(new Set([apiPort,faucetPort,readyPort,validatorPort,metricsPort]).size,5);
 const config=path.join(directory,'override.yaml');fs.writeFileSync(config,`api:\n  address: "127.0.0.1:${apiPort}"\nvalidator_network:\n  network_id: validator\n  mutual_authentication: true\n  listen_address: "/ip4/127.0.0.1/tcp/${validatorPort}"\ninspection_service:\n  port: ${metricsPort}\n`,{mode:0o600});
 const log=path.join(directory,'node.log'),fd=fs.openSync(log,'wx',0o600);const proc=spawn(binary,['node','run-localnet','--test-dir',path.join(directory,'chain'),'--test-config-override',config,'--no-txn-stream','--bind-to','127.0.0.1','--faucet-port',String(faucetPort),'--ready-server-listen-port',String(readyPort),'--assume-yes'],{cwd:directory,env:{PATH:process.env.PATH,HOME:directory,RUST_BACKTRACE:'0'},stdio:['ignore',fd,fd]});fs.closeSync(fd);let exited=false;proc.once('exit',()=>exited=true);
 const base=`http://127.0.0.1:${apiPort}`,root=base+'/v1',faucet=`http://127.0.0.1:${faucetPort}`,servers=[];
 const state={sent:0,drop:false,hold:null,mutate:null,lastRaw:null,simulations:0,simulationSignatures:[]};
 const close=async()=>{await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));if(!exited){proc.kill('SIGINT');for(let i=0;i<200&&!exited;i++)await sleep(25);if(!exited){proc.kill('SIGKILL');for(let i=0;i<100&&!exited;i++)await sleep(25);}}if(process.env.REALDEX_APTOS_TEST_LOG_DIR){fs.mkdirSync(process.env.REALDEX_APTOS_TEST_LOG_DIR,{recursive:true});fs.copyFileSync(log,path.join(process.env.REALDEX_APTOS_TEST_LOG_DIR,'local-validator.log'));}fs.rmSync(directory,{recursive:true,force:true});};
 try{
  let ready=false;for(let i=0;i<600&&!exited;i++){try{const r=await fetch(`http://127.0.0.1:${readyPort}/`,{signal:AbortSignal.timeout(1000)});if(r.ok){ready=true;break;}await sleep(100);}catch{await sleep(100);}}
  // The readiness endpoint may return non-JSON. Explicit node+faucet readiness is also checked.
  if(!ready){try{const r=await fetch(`http://127.0.0.1:${readyPort}/`,{signal:AbortSignal.timeout(3000)});ready=r.ok;}catch{}}
  assert.ok(ready&&!exited,'APTOS_LOCAL_NODE_NOT_READY');const info=await json(root);assert.equal(info.chain_id,4);assert.equal(info.git_hash,APTOS_PIN.coreGitHash);
  const checkpoint=await json(root+'/blocks/by_height/1?with_transactions=false');
  for(let peer=0;peer<2;peer++){
   const s=http.createServer(async(req,res)=>{
    try{let chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);if(state.hold)await state.hold(req.url,peer);
      if(req.method==='POST'&&req.url.startsWith('/v1/transactions/simulate')){state.simulations++;state.simulationSignatures.push(body.subarray(-64).toString('hex'));}
      const sending=req.method==='POST'&&req.url==='/v1/transactions';if(sending){state.sent++;state.lastRaw=body;}
      const upstream=http.request(base+req.url,{method:req.method,headers:{...req.headers,'accept-encoding':'identity'},agent:false},r=>{const parts=[];r.on('data',b=>parts.push(b));r.on('end',()=>{let bytes=Buffer.concat(parts);if(sending&&state.drop&&r.statusCode>=200&&r.statusCode<300){res.destroy();return;}if(state.mutate){try{const d=JSON.parse(bytes);state.mutate(d,{url:req.url,peer});bytes=Buffer.from(JSON.stringify(d));}catch{res.destroy();return;}}
        const headers={...r.headers};delete headers['transfer-encoding'];headers['content-length']=String(bytes.length);res.writeHead(r.statusCode,headers);res.end(bytes);
      });r.on('error',()=>res.destroy());});upstream.on('error',()=>res.destroy());upstream.end(body);
    }catch{res.destroy();}
   });await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s);
  }
  const network=validateAccountNetwork({family:'aptos',id:'aptos:local-4',name:'One real local validator / two forwarders',rpcUrls:servers.map(s=>`http://127.0.0.1:${s.address().port}/v1/`),checkpoint:{height:1,hash:checkpoint.block_hash},broadcastEnabled:true,maxTransferAtomic:'100000000',maxFeeAtomic:'10000000',minConfirmations:1,chainId:4});
  return {root,base,faucet,state,network,directory,close,async fixture({fundingAmount="1000000000",secretHex,recipientSeed}={}){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-aptos-vault-')),store=new PrivateStore(dir),vault=new Vault(store);await vault.create(PASSWORD);const account=await vault.addAccount({family:'aptos',label:'Disposable real-localnet account',...(secretHex?{secretHex}:{})}),to=keyInfo('aptos',recipientSeed??randomBytes(32)).address;
    for(const address of [account.address,to]){const hashes=await json(`${faucet}/mint?address=${address}&amount=${fundingAmount}`,{method:'POST'});assert.ok(Array.isArray(hashes));for(const h of hashes){for(let i=0;i<100;i++){const r=await fetch(root+'/transactions/by_hash/'+h,{signal:AbortSignal.timeout(5000)});if(r.ok){const d=await r.json();if(d.type==='user_transaction'){assert.equal(d.success,true);break;}}await sleep(50);}}}
    const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);
    const app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],accountNetworks:[network],allowedAppOrigins:[]}}),start=await app.start(0);
    const call=async(route,body={})=>{const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);return d;};
    state.drop=false;state.mutate=null;state.hold=null;state.simulations=0;state.simulationSignatures=[];const startSent=state.sent;
    return {vault,store,app,account,to,call,startSent,input(extra={}){return {accountId:account.id,networkId:network.id,payment:{requestKey:'real-test-'+account.id,to,amountAtomic:'1000000',maxGasAmount:'100000',gasUnitPrice:'100',...extra}};},async prepare(extra={}){return call('non-evm/account-online/prepare',this.input(extra));},async approve(p,broadcast=false){return call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:to,broadcast});},async settle(record){let r;for(let i=0;i<100;i++){r=await call('non-evm/account-online/reconcile',{id:record.id});if(r.state==='reported-confirmed'||r.state==='reported-reverted')return r;await sleep(100);}throw Error('REAL_APTOS_RECEIPT_NOT_OBSERVED:'+r?.report?.reason);},async balance(address=to,version){const d=await json(root+'/view'+(version?'?ledger_version='+version:''),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({function:'0x1::coin::balance',type_arguments:['0x1::aptos_coin::AptosCoin'],arguments:[address]})});return BigInt(d[0]);},async close(){state.hold=null;state.mutate=null;state.drop=false;await app.close();vault.lock();store.close();fs.rmSync(dir,{recursive:true,force:true});}}
  }};
 }catch(e){await close();throw e;}
}
