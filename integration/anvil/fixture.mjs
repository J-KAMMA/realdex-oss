/** REAL Anvil subprocess. Two transports forward to ONE real EVM, not independent consensus. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {PrivateStore} from '../../wallet/lib/storage.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {Rpc, validateNetwork} from '../../wallet/lib/network.mjs';
import {AUTO_CONFIRMATION} from '../../wallet/lib/agent-policy.mjs';
import {AgentWalletClient} from '../../wallet/agent/client.mjs';
import {verifiedAnvil, ANVIL_PIN} from './toolchain.mjs';
export const PASSWORD = 'Disposable Anvil test backup only - never use for funds';
export const RECIPIENT = '0x3535353535353535353535353535353535353535';
const delay = ms => new Promise(r => setTimeout(r,ms));
export async function startAnvil() {
  const executable = verifiedAnvil(process.env.REALDEX_ANVIL_BINARY);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'realdex-anvil-'));
  const env = {PATH:process.env.PATH ?? '',HOME:directory,LANG:'C',LC_ALL:'C'};
  const child = spawn(executable,['--host','127.0.0.1','--port','0','--chain-id',ANVIL_PIN.chainId,
    '--hardfork',ANVIL_PIN.hardfork,'--accounts','0'],
    {cwd:directory,env,stdio:['ignore','pipe','pipe'],shell:false});
  let output='',exited=false;
  child.on('error',()=>{exited=true;}); child.on('exit',()=>{exited=true;});
  const capture=b=>{output=(output+b.toString()).slice(-32768);};
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const close=async()=>{
    if(child.exitCode===null&&!child.killed)child.kill('SIGTERM');
    for(let i=0;i<100&&!exited;i++)await delay(25);
    if(!exited) {child.kill('SIGKILL');await delay(100);}
    fs.rmSync(directory,{recursive:true,force:true});
  };
  try {
    let match;
    for(let i=0;i<400;i++) {match=output.match(/Listening on (127\.0\.0\.1:\d+)/);if(match)break;assert.ok(!exited,'ANVIL_EXIT_BEFORE_LISTEN');await delay(25);}
    assert.ok(match,'ANVIL_START_TIMEOUT');
    const url='http://'+match[1]+'/',rpc=new Rpc();
    assert.equal(await rpc.call(url,'eth_chainId',[]),'0x7a69');
    const clientVersion=await rpc.call(url,'web3_clientVersion',[]);
    assert.match(clientVersion,/anvil/i);
    return {url,clientVersion,call:(method,params=[])=>rpc.call(url,method,params),close};
  } catch(e) {await close();throw e;}
}
export async function fixture({policy={},contracts=[],setupContracts=null}={}) {
  const chain=await startAnvil(),directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-real-wallet-'));
  let store,vault,app;
  const servers=[],sent=[],calls=[];
  const fault={dropSendResponse:false};
  try {
    store=new PrivateStore(directory);vault=new Vault(store);await vault.create(PASSWORD);
    const account=await vault.addAccount({family:'evm',label:'Temporary unfunded Anvil test key'});
    const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
    await chain.call('anvil_setBalance',[account.address,'0x56bc75e2d63100000']);
    // Optional test deployment callback runs on this one local EVM only.
    const market = setupContracts ? await setupContracts(chain, account) : null;
    if (market) contracts = market.contracts;
    // Forward RPC bodies/responses unchanged. Only explicit lost-response tests suppress delivery.
    for(let peer=0;peer<2;peer++) {
      const server=http.createServer(async(req,res)=>{
        let id=null;
        try {
          const chunks=[];let length=0;for await(const b of req){length+=b.length;assert.ok(length<=524288);chunks.push(b);}
          const body=Buffer.concat(chunks),call=JSON.parse(body);id=call.id;
          calls.push({peer,method:call.method});
          if(call.method==='eth_sendRawTransaction')sent.push(call.params[0]);
          const response=await fetch(chain.url,{method:'POST',headers:{'content-type':'application/json'},body,signal:AbortSignal.timeout(10000)});
          const bytes=Buffer.from(await response.arrayBuffer());
          if(call.method==='eth_sendRawTransaction'&&fault.dropSendResponse){res.destroy();return;}
          res.writeHead(response.status,{'content-type':'application/json'});res.end(bytes);
        } catch {if(!res.destroyed){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32000,message:'TEST_TRANSPORT_FAILED'}}));}}
      });
      await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
    }
    const genesis=await chain.call('eth_getBlockByNumber',['0x0',false]);
    const network=validateNetwork({chainId:'31337',name:'REAL single-node Anvil test ONLY',symbol:'TEST',
      rpcUrls:servers.map(s=>'http://127.0.0.1:'+s.address().port+'/'),genesisHash:genesis.hash,broadcastEnabled:true,
      contracts,maxFeeWei:'10000000000000000',maxSlippageBps:100,confirmationPolicy:{minConfirmations:1,finalityTag:'none'}});
    app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',allowedAppOrigins:[],networks:[network]}});
    const start=await app.start(0);
    const f={chain,market,directory,store,vault,app,start,account,network,sent,calls,fault,
      async owner(route,body={}) {
        const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,'content-type':'application/json',authorization:'Bearer '+app.uiToken},body:JSON.stringify(body)});
        const b=await r.json();assert.equal(r.ok,true,b.error);return b;
      },
      async agent(overrides={}) {
        const raw={label:'Temporary bounded agent',accountId:account.id,chainId:'31337',asset:'native',recipients:[RECIPIENT],mode:'auto',expiresAt:Date.now()+3600000,
          limits:{perTransferAtomic:'100',rolling24hAtomic:'200',lifetimeAtomic:'300',perTxFeeWei:'1000000000000000',rolling24hFeeWei:'5000000000000000',lifetimeFeeWei:'9000000000000000',maxTransfers:10,minIntervalMs:0},...policy,...overrides};
        const draft=await f.owner('agents/prepare',{policy:raw});
        const grant=await f.owner('agents/create',{draftId:draft.draftId,digest:draft.digest,confirmation:AUTO_CONFIRMATION});
        return new AgentWalletClient({url:start.origin,token:grant.token});
      },
      async intent({to=RECIPIENT,value='0x32',type,...request}={}) {
        return app.engine.prepare(network,account,{from:account.address,to,value,...(type===undefined?{}:{type}),...request});
      },
      async submit(request={}) {
        const intent=await f.intent(request),record=await app.engine.sign(vault,network,intent);
        await app.engine.broadcast(vault,network,record);return record;
      },
      balance:async address=>BigInt(await chain.call('eth_getBalance',[address,'latest'])),
      async receipt(hash) {
        for(let i=0;i<100;i++) {const r=await chain.call('eth_getTransactionReceipt',[hash]);if(r)return r;await delay(25);}
        throw Error('REAL_EVM_MINING_TIMEOUT');
      },
      async close(){await app.close();await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));await chain.close();fs.rmSync(directory,{recursive:true,force:true});},
    };
    return f;
  } catch(e) {
    if(app)await app.close();else {vault?.lock();store?.close();}
    await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));await chain.close();fs.rmSync(directory,{recursive:true,force:true});throw e;
  }
}
