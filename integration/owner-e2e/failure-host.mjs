#!/usr/bin/env node
/** Test-only host: no user Vault, public endpoint, recovery lock deletion or product hook. */
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';import {parseExactJson} from '../../node/extended/json.mjs';
import {need,sha,loopbackOrigin} from './protocol.mjs';import {signedDigest,readPrivateFile,writeExclusive} from './crash-protocol.mjs';
import {exactKeys,failureHome,failureArm,releaseGate,failedReceipt} from './failure-protocol.mjs';
need(process.env.REALDEX_E2E03_CHILD==='disposable-only','E2E_FAILURE_CHILD_ONLY');
const lines=readline.createInterface({input:process.stdin});let home,chainOrigin,store,vault,app,started=false,arm=null,lastId=0,writes=0,queries=0;const sent=new Map();
const ownerSends=()=>[...sent.values()].reduce((a,b)=>a+b,0);
const summarize=r=>({id:r.id,hash:r.signed.requestId,signedSha256:signedDigest(r.signed),state:r.state,report:r.report??null,retirementPresent:Object.hasOwn(r,'retirement')});
async function stop(){if(app){await app.close();app=null;}else store?.close();}
async function current(hash){const r=(await vault.injectiveRecords()).find(r=>r.signed.requestId===hash);need(r&&r.state==='broadcast-unknown'&&r.report?.reason==='SUBMISSION_STARTING','E2E_FAILURE_START_NOT_PERSISTED');return r;}
async function atBoundary(hash){
 const r=await current(hash);writeExclusive(path.join(home,'ready.json'),JSON.stringify({schema:'realdex.failure-barrier.v1',mode:arm.mode,requestHash:hash,state:r.state,reason:r.report.reason,ownerSends:ownerSends(),signedSha256:signedDigest(r.signed)})+'\n');
 const gate=path.join(home,'release.json'),until=Date.now()+20000;
 while(!fs.existsSync(gate)){need(Date.now()<until,'E2E_FAILURE_GATE_TIMEOUT');await new Promise(ok=>setTimeout(ok,40));}
 releaseGate(JSON.parse(readPrivateFile(gate,2048).toString('utf8')),hash);
}
async function handle(action,p){
 if(action==='start'){
  exactKeys(p,['home','password','create','chainOrigin',...(p?.create?['secretHex']:[])]);
  need(!started&&typeof p.create==='boolean'&&typeof p.password==='string'&&p.password.length>=20&&p.password.length<=128,'E2E_FAILURE_START');started=true;
  home=failureHome(p.home);chainOrigin=loopbackOrigin(p.chainOrigin);
  try{store=new PrivateStore(home);}catch(e){if(e.message==='VAULT_IN_USE_OR_STALE_LOCK')throw Error('E2E_FAILURE_STALE_LOCK');throw e;}
  const writer=store.write.bind(store);store.write=(...args)=>{const result=writer(...args);writes++;return result;};vault=new Vault(store);
  if(p.create){need(/^[a-f0-9]{64}$/.test(p.secretHex),'E2E_FAILURE_TEST_KEY');await vault.create(p.password);await vault.addAccount({family:'evm',label:'Disposable E2E03 owner',secretHex:p.secretHex});const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,p.password);}else await vault.unlock(p.password);
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});
  const real=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
   need(new URL(u).origin===chainOrigin,'E2E_FAILURE_LOCAL_ONLY');
   if(o.method!=='POST'||new URL(u).pathname!=='/cosmos/tx/v1beta1/txs'){queries++;return real(u,o);}
   const hash=sha(Buffer.from(JSON.parse(o.body).tx_bytes,'base64')).toUpperCase();
   if(arm){need(hash===arm.requestHash,'E2E_FAILURE_ARMED_HASH');await atBoundary(hash);}
   sent.set(hash,(sent.get(hash)??0)+1);const response=await real(u,o);
   if(arm){
    const check=await response.clone().json();need(response.ok&&check.tx_response?.code===0&&check.tx_response?.txhash===hash,'E2E_FAILURE_CHECKTX');
    let receipt;const until=Date.now()+15000;
    while(Date.now()<until){const q=await real(chainOrigin+'/cosmos/tx/v1beta1/txs/'+hash,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error',credentials:'omit'});
     if(q.status===404){await q.body?.cancel();await new Promise(ok=>setTimeout(ok,100));continue;}
     need(q.ok,'E2E_FAILURE_LOOKUP_HTTP');receipt=failedReceipt((await q.json()).tx_response,hash);break;}
    need(receipt,'E2E_FAILURE_INCLUSION_TIMEOUT');
    if(arm.mode==='kill-before-record'){
     const r=await current(hash),cipher=readPrivateFile(path.join(home,'vault.json'));
     writeExclusive(path.join(home,'failure-marker.json'),JSON.stringify({schema:'realdex.failure-crash-marker.v1',requestHash:hash,state:r.state,reason:r.report.reason,receipt,ownerSends:ownerSends(),signedSha256:signedDigest(r.signed),ciphertextSha256:sha(cipher)})+'\n');
     process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
    }
   }
   return response;
  };
  const s=await app.start(0),accounts=vault.status().accounts;need(accounts.length===1,'E2E_FAILURE_OWNER_COUNT');return {origin:s.origin,token:app.uiToken,accountId:accounts[0].id,pid:process.pid};
 }
 need(app,'E2E_FAILURE_NOT_STARTED');
 if(action==='arm'){
  failureArm(p);need(!arm&&ownerSends()===1,'E2E_FAILURE_ARM_ONCE');const rs=await vault.injectiveRecords(),r=rs.find(x=>x.signed.requestId===p.requestHash);
  need(rs.length===2&&rs[0].state==='reported-confirmed'&&r?.state==='signed'&&JSON.parse(r.summary.reviewJson).action?.kind==='cancel','E2E_FAILURE_ARM_CANCEL_ONLY');arm={...p};return {armed:true};
 }
 exactKeys(p,[]);
 if(action==='snapshot')return {ownerSends:ownerSends(),perHash:[...sent.entries()].map(([hash,count])=>({hash,count})),writes,queries,records:(await vault.injectiveRecords()).map(summarize)};
 if(action==='stop'){await stop();return {closed:true};}
 throw Error('E2E_FAILURE_ACTION');
}
try{for await(const line of lines){let m;try{
 need(Buffer.byteLength(line)<=262144,'E2E_FAILURE_INPUT_LIMIT');parseExactJson(line,{maxChars:262144,maxNodes:3000,maxDepth:12});m=JSON.parse(line);exactKeys(m,['id','action','payload']);need(Number.isSafeInteger(m.id)&&m.id===lastId+1&&typeof m.action==='string','E2E_FAILURE_FRAME');lastId=m.id;
 const data=await handle(m.action,m.payload);console.log(JSON.stringify({id:m.id,ok:true,data}));if(m.action==='stop')break;
 }catch(e){console.log(JSON.stringify({id:m?.id??0,ok:false,error:e instanceof Error&&/^E2E_FAILURE_[A-Z0-9_]+$/.test(e.message)?e.message:'E2E_FAILURE_HOST_REJECTED'}));process.exitCode=1;break;}}
}finally{await stop();lines.close();}
