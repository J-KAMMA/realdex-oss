/** REAL regtest Bitcoin Core, P2P disabled. Two transports -> one node, not independent consensus. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import net from 'node:net';import {spawn} from 'node:child_process';
import {verifiedBitcoind} from './toolchain.mjs';
import {keyInfo} from '../../wallet/lib/keys.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';import {Vault} from '../../wallet/lib/vault.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
import {validateBitcoinNetwork,BITCOIN_REGTEST_GENESIS} from '../../wallet/non-evm/bitcoin-network.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
export const RECIPIENT=keyInfo('bitcoin',Buffer.alloc(32,85)).address;
export async function startCore(){
  const executable=verifiedBitcoind(process.env.REALDEX_BITCOIND_BINARY),dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-regtest-'));
  const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
  const log=fs.openSync(path.join(dir,'process.log'),'w',0o600);
  const child=spawn(executable,[`-datadir=${dir}`,'-regtest','-server=1','-listen=0','-networkactive=0','-dnsseed=0','-discover=0','-listenonion=0','-disablewallet=1','-txindex=1',`-rpcport=${port}`,'-rpcbind=127.0.0.1','-rpcallowip=127.0.0.1'],{env:{PATH:process.env.PATH??'',HOME:dir,LANG:'C'},stdio:['ignore',log,log],shell:false});fs.closeSync(log);
  let exited=false,startError;child.on('exit',()=>exited=true);child.on('error',e=>{startError=e;exited=true;});
  const cookieFile=path.join(dir,'regtest','.cookie'),url=`http://127.0.0.1:${port}/`;let sequence=0;
  const rpc=async(method,params=[])=>{const cookie=fs.readFileSync(cookieFile,'utf8').trim();const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',authorization:'Basic '+Buffer.from(cookie).toString('base64')},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method,params}),signal:AbortSignal.timeout(15000)});const r=await res.json();if(r.error)throw Error('TEST_CORE_'+r.error.code+': '+r.error.message);return r.result;};
  const close=async()=>{if(!exited)child.kill('SIGTERM');for(let i=0;i<150&&!exited;i++)await delay(20);if(!exited)child.kill('SIGKILL');fs.rmSync(dir,{recursive:true,force:true});};
  try{let ready=false;for(let i=0;i<200;i++){if(exited)throw startError??Error('BITCOIND_EXIT '+fs.readFileSync(path.join(dir,'process.log'),'utf8'));try{await rpc('getblockchaininfo');ready=true;break;}catch{}await delay(50);}if(!ready)throw Error('BITCOIND_START_TIMEOUT');
    const sync=async()=>{const h=await rpc('getblockcount');for(let i=0;i<200;i++){const index=await rpc('getindexinfo',['txindex']);if(index?.txindex?.synced&&index.txindex.best_block_height>=h)return;await delay(20);}throw Error('TEST_TXINDEX_TIMEOUT');};
    return {dir,url,cookieFile,rpc,sync,close};
  }catch(e){await close();throw e;}
}
export async function fixture(t,chain){
  const f=storeFixture(),clock={value:Date.now()},vault=new Vault(f.store,{now:()=>clock.value});await vault.create(PASSWORD);
  const account=await vault.addAccount({family:'bitcoin',label:'Disposable regtest test key'});const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
  await chain.rpc('generatetoaddress',[101,account.address]);await chain.sync();
  const servers=[],sent=[],calls=[],fault={drop:false,mutate:null,before:null,after:null};
  for(let i=0;i<2;i++){
    const server=http.createServer(async(req,res)=>{let id=null;try{
      const parts=[];for await(const c of req)parts.push(c);const body=Buffer.concat(parts),request=JSON.parse(body);id=request.id;calls.push(request.method);
      if(fault.before)await fault.before(request.method,i);if(request.method==='sendrawtransaction')sent.push(request.params[0]);
      const reply=await fetch(chain.url,{method:'POST',headers:{'content-type':'application/json',authorization:req.headers.authorization},body,signal:AbortSignal.timeout(15000)});
      let bytes=Buffer.from(await reply.arrayBuffer());if(fault.after)await fault.after(request.method,i);if(fault.mutate)bytes=Buffer.from(JSON.stringify(fault.mutate(JSON.parse(bytes),request.method,i)));
      if(fault.drop&&request.method==='sendrawtransaction'){res.destroy();return;}
      res.writeHead(reply.status,{'content-type':'application/json'});res.end(bytes);
    }catch{if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'TEST_PROXY_FAILURE'}}));}}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
  }
  const network=validateBitcoinNetwork({family:'bitcoin',id:'bitcoin:regtest',name:'Test-only Bitcoin Core regtest',chain:'regtest',genesisHash:BITCOIN_REGTEST_GENESIS,checkpoint:{height:1,hash:await chain.rpc('getblockhash',[1])},rpcUrls:servers.map(s=>`http://127.0.0.1:${s.address().port}/`),cookieFile:chain.cookieFile,broadcastEnabled:true,maxTransferSats:'100000000',maxFeeSats:'100000',maxFeeRateSatVb:'100',minConfirmations:2});
  const server=new WalletServer({store:f.store,vault,now:()=>clock.value,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[],bitcoinNetworks:[network]}}),started=await server.start(0);
  t.after(async()=>{await server.close();await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));f.close();});
  const owner=async(route,b={})=>{const res=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',origin:started.origin,authorization:'Bearer '+server.uiToken},body:JSON.stringify(b)});const result=await res.json();if(!res.ok)throw Error(result.error);return result;};
  const scan=await owner('non-evm/bitcoin-online/utxos',{accountId:account.id,networkId:network.id});
  const spendable=scan.utxos.filter(u=>u.eligible),selected=spendable.slice(0,1).map(({txid,vout,amountAtomic,scriptHex})=>({txid,vout,amountAtomic,scriptHex}));
  if(!selected.length)throw Error('TEST_NO_MATURE_UTXO');
  const payment={requestKey:'test-payment',to:RECIPIENT,amountAtomic:'100000',feeAtomic:'1000',maxFeeRateSatVb:'50',utxos:selected};
  const prepare=(overrides={})=>owner('non-evm/bitcoin-online/prepare',{accountId:account.id,networkId:network.id,payment:{...payment,...overrides}});
  const approve=(p,broadcast=true)=>owner('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:RECIPIENT,broadcast});
  const reconcile=r=>owner('non-evm/bitcoin-online/reconcile',{id:r.id});
  const mine=async(n=2)=>{await chain.rpc('generatetoaddress',[n,RECIPIENT]);await chain.sync();};
  return {...f,chain,vault,account,network,server,started,owner,prepare,approve,reconcile,payment,scan,sent,calls,fault,mine,clock};
}
