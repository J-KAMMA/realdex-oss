#!/usr/bin/env node
/** Disposable owner host. Test barriers only pause real network boundaries; never fabricate responses. */
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';import {need,sha,loopbackOrigin} from './protocol.mjs';
import {signedDigest,readPrivateFile} from './crash-protocol.mjs';import {exactKeys} from './failure-protocol.mjs';
import {Barrier,fixtureHome} from './concurrency-protocol.mjs';
need(process.env.REALDEX_E2E04_CHILD==='disposable-only','E2E_CONCURRENCY_CHILD_ONLY');
const rl=readline.createInterface({input:process.stdin}),gate=new Barrier();let home,store,vault,app,origin,started=false,lastId=0,writes=0,queries=0;const sends=new Map();
const count=()=>[...sends.values()].reduce((n,x)=>n+x,0);
async function snapshot(){const locked=vault.status().locked;return {locked,writes,queries,ownerSends:count(),perHash:[...sends].map(([hash,count])=>({hash,count})),busy:app.nonEvm.busy,activeApproval:app.activeApproval,ciphertextSha256:sha(readPrivateFile(path.join(home,'vault.json'))),barrier:gate.snapshot(),records:locked?null:(await vault.injectiveRecords()).map(r=>({id:r.id,hash:r.signed.requestId,state:r.state,reason:r.report?.reason??null,signedSha256:signedDigest(r.signed)}))};}
async function pause(point,extra={}){if(!gate.matches(point))return;const s=await snapshot();await gate.hit(point,{writes:s.writes,queries:s.queries,ownerSends:s.ownerSends,records:s.records,ciphertextSha256:s.ciphertextSha256,...extra});}
async function stop(){gate.close();if(app){await app.close();app=null;}else store?.close();}
async function handle(action,p){
 if(action==='start'){
  exactKeys(p,['home','password','chainOrigin','create',...(p?.create?['secretHex']:[])],'E2E_CONCURRENCY_START_FIELDS');
  need(!started&&typeof p.create==='boolean'&&typeof p.password==='string'&&p.password.length>=20&&p.password.length<=128,'E2E_CONCURRENCY_START');
  home=fixtureHome(p.home);origin=loopbackOrigin(p.chainOrigin);if(p.create)need(/^[a-f0-9]{64}$/.test(p.secretHex)&&fs.readdirSync(home).length===0,'E2E_CONCURRENCY_FRESH_HOME');started=true;
  try{store=new PrivateStore(home);}catch(e){if(e.message==='VAULT_IN_USE_OR_STALE_LOCK')throw Error('E2E_CONCURRENCY_STALE_LOCK');throw e;}
  const write=store.write.bind(store);store.write=(...args)=>{const r=write(...args);writes++;return r;};vault=new Vault(store);
  if(p.create){await vault.create(p.password);await vault.addAccount({family:'evm',label:'Disposable E2E04 owner',secretHex:p.secretHex});const b=await vault.backup();await vault.verifyBackup(b.encrypted,p.password);}else await vault.unlock(p.password);
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});
  const real=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
   const url=new URL(u);need(url.origin===origin,'E2E_CONCURRENCY_LOCAL_ONLY');
   const submit=o.method==='POST'&&url.pathname==='/cosmos/tx/v1beta1/txs';
   if(!submit){queries++;if(o.method==='POST'&&url.pathname==='/cosmos/tx/v1beta1/simulate')await pause('simulate');return real(u,o);}
   const hash=sha(Buffer.from(JSON.parse(o.body).tx_bytes,'base64')).toUpperCase();await pause('submit',{requestHash:hash});
   sends.set(hash,(sends.get(hash)??0)+1);const response=await real(u,o);
   if(gate.matches('response')){const v=await response.clone().json();need(response.ok&&v.tx_response?.code===0&&v.tx_response?.txhash===hash,'E2E_CONCURRENCY_REAL_ACCEPTANCE');await pause('response',{requestHash:hash,acceptedCode:v.tx_response.code});}
   return response;
  };
  const s=await app.start(0),accounts=vault.status().accounts;need(accounts.length===1,'E2E_CONCURRENCY_ONE_OWNER');return {origin:s.origin,token:app.uiToken,accountId:accounts[0].id,pid:process.pid};
 }
 need(app,'E2E_CONCURRENCY_NOT_STARTED');
 if(action==='arm'){need(!app.nonEvm.busy&&!app.activeApproval,'E2E_CONCURRENCY_ALREADY_BUSY');return gate.arm(p);}
 if(action==='release')return gate.release(p);
 exactKeys(p,[],'E2E_CONCURRENCY_COMMAND_FIELDS');
 if(action==='snapshot')return snapshot();
 if(action==='stop'){await stop();return {closed:true};}
 throw Error('E2E_CONCURRENCY_ACTION');
}
try{for await(const line of rl){let m;try{
 need(Buffer.byteLength(line)<=262144,'E2E_CONCURRENCY_INPUT_LIMIT');parseExactJson(line,{maxChars:262144,maxNodes:3000,maxDepth:12});m=JSON.parse(line);exactKeys(m,['id','action','payload'],'E2E_CONCURRENCY_FRAME');need(m.id===lastId+1&&typeof m.action==='string','E2E_CONCURRENCY_FRAME');lastId=m.id;
 const data=await handle(m.action,m.payload);console.log(JSON.stringify({id:m.id,ok:true,data}));if(m.action==='stop')break;
 }catch(e){console.log(JSON.stringify({id:m?.id??0,ok:false,error:e instanceof Error&&/^E2E_CONCURRENCY_[A-Z0-9_]+$/.test(e.message)?e.message:'E2E_CONCURRENCY_HOST_REJECTED'}));process.exitCode=1;break;}}
}finally{await stop();rl.close();}
