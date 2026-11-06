/** Test child for an unmodified WalletServer. No public bind, user home or persistent keys. */
import readline from 'node:readline';import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {need,safeCode} from './protocol.mjs';
const rl=readline.createInterface({input:process.stdin});let app,store,vault,started=false,drop=false,dropped=0;const sent=new Map();
async function stop(){if(app){await app.close();app=null;}else store?.close();}
async function handle(action,p){
 if(action==='start'){
  need(!started&&p&&typeof p.home==='string'&&path.basename(p.home).startsWith('realdex-e2e01-vault-')&&fs.realpathSync(p.home)===p.home,'E2E_TEST_DIRECTORY');started=true;
  store=new PrivateStore(p.home);vault=new Vault(store);
  if(p.create){await vault.create(p.password);await vault.addAccount({family:'evm',label:'Disposable E2E01 owner',secretHex:p.secretHex});const b=await vault.backup();await vault.verifyBackup(b.encrypted,p.password);}
  else await vault.unlock(p.password);
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});
  const real=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
   const submission=o.method==='POST'&&u.endsWith('/cosmos/tx/v1beta1/txs');
   if(submission){const b=JSON.parse(o.body);const h=createHash('sha256').update(Buffer.from(b.tx_bytes,'base64')).digest('hex').toUpperCase();sent.set(h,(sent.get(h)??0)+1);}
   const response=await real(u,o);
   if(submission&&drop){drop=false;dropped++;await response.arrayBuffer();throw Error('E2E_TEST_RESPONSE_LOSS');}return response;
  };
  const start=await app.start(0);const accounts=vault.status().accounts;need(accounts.length===1,'E2E_TEST_ACCOUNT');
  return {origin:start.origin,token:app.uiToken,accountId:accounts[0].id,pid:process.pid};
 }
 need(app,'E2E_HOST_NOT_STARTED');
 if(action==='drop-next'){need(!drop&&dropped===0,'E2E_DROP_BUDGET');drop=true;return {armed:true};}
 if(action==='stats')return {ownerSends:[...sent.values()].reduce((a,b)=>a+b,0),hashes:[...sent.keys()],perHash:[...sent.values()],droppedResponses:dropped,records:(await vault.injectiveRecords()).map(r=>({id:r.id,requestKey:r.requestKey,hash:r.signed.requestId,state:r.state}))};
 if(action==='stop'){await stop();return {closed:true};}
 throw Error('E2E_HOST_ACTION');
}
try{for await(const line of rl){let msg;try{need(Buffer.byteLength(line)<=262144,'E2E_CHILD_INPUT_LIMIT');msg=JSON.parse(line);need(Number.isSafeInteger(msg.id)&&msg.id>0,'E2E_CHILD_FRAME');const data=await handle(msg.action,msg.payload);console.log(JSON.stringify({id:msg.id,ok:true,data}));if(msg.action==='stop')break;}catch(e){console.log(JSON.stringify({id:msg?.id??0,ok:false,error:safeCode(e)}));process.exitCode=1;break;}}}
finally{await stop();rl.close();}
