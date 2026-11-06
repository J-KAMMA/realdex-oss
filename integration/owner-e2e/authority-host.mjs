/** Disposable child: unmodified product server, with observation counters only. */
import readline from 'node:readline';import fs from 'node:fs';import path from 'node:path';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {need,sha,safeCode} from './protocol.mjs';
const rl=readline.createInterface({input:process.stdin});let app,store,vault,started=false,writes=0,reads=0,sends=0;const hashes=[];
async function stop(){if(app){await app.close();app=null;}else store?.close();}
async function handle(action,p){
 if(action==='start'){
  need(!started&&p&&typeof p.home==='string'&&path.basename(p.home).startsWith('realdex-e2e07-vault-')&&fs.realpathSync(p.home)===p.home,'E2E_AUTH_TEST_DIRECTORY');started=true;
  store=new PrivateStore(p.home);const write=store.write.bind(store);store.write=(...args)=>{writes++;return write(...args);};vault=new Vault(store);
  if(p.create){await vault.create(p.password);await vault.addAccount({family:'evm',label:'Disposable E2E07 owner',secretHex:p.secretHex});const b=await vault.backup();await vault.verifyBackup(b.encrypted,p.password);}
  else await vault.unlock(p.password);
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:['http://127.0.0.1:5173']}});
  const engine=app.nonEvm.injectiveEngine,real=engine.fetchImpl;
  engine.fetchImpl=async(u,o)=>{const send=o.method==='POST'&&u.endsWith('/cosmos/tx/v1beta1/txs');if(send){sends++;hashes.push(sha(Buffer.from(JSON.parse(o.body).tx_bytes,'base64')).toUpperCase());}else reads++;return real(u,o);};
  const start=await app.start(0);const accounts=vault.status().accounts;need(accounts.length===1,'E2E_AUTH_ACCOUNT');
  return {origin:start.origin,token:app.uiToken,accountId:accounts[0].id,pid:process.pid};
 }
 need(app,'E2E_AUTH_NOT_STARTED');
 if(action==='stats'){
  const locked=vault.status().locked,records=locked?[]:await vault.injectiveRecords();
  return {writes,reads,sends,hashes:[...hashes],locked,epoch:vault.epoch,cipherSha256:sha(store.read()),
   requestsSha256:sha(JSON.stringify([...app.requests.values()].map(r=>({id:r.id,state:r.state})))),
   recordsSha256:sha(JSON.stringify(records)),records:records.map(r=>({id:r.id,state:r.state,hash:r.signed.requestId})),
   ownerBudget:app.budget.n,ownerBudgetAt:app.budget.at};
 }
 if(action==='stop'){await stop();return {closed:true};}
 throw Error('E2E_AUTH_HOST_ACTION');
}
try{for await(const line of rl){let m;try{need(Buffer.byteLength(line)<=262144,'E2E_AUTH_INPUT_LIMIT');m=JSON.parse(line);need(Number.isSafeInteger(m.id)&&m.id>0,'E2E_AUTH_FRAME');const data=await handle(m.action,m.payload);console.log(JSON.stringify({id:m.id,ok:true,data}));if(m.action==='stop')break;}catch(e){console.log(JSON.stringify({id:m?.id??0,ok:false,error:safeCode(e)}));process.exitCode=1;break;}}}finally{await stop();rl.close();}
