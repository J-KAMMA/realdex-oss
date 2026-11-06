import {canonical} from '../../wallet/lib/guard.mjs';
/** Disposable integration control, not part of the public owner entry point. */
import readline from 'node:readline';import fs from 'node:fs';import path from 'node:path';
import {CheckpointLeaseStore} from '../../wallet/protected/store.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';import {ProtectedOwnerServer} from '../../wallet/protected/server.mjs';
import {sha,need,loopbackOrigin} from '../owner-e2e/protocol.mjs';
const home=process.argv[2],witness=process.argv[3];need(process.env.REALDEX_CP_TEST==='disposable-only','E2E_CP_MODE');
let store,app,vault,chainOrigin,armed=null,transmissions=0,writeArmed=null,started=false,drop=false,dropped=0;const sent=new Map();
const rl=readline.createInterface({input:process.stdin});
const summarize=r=>({id:r.id,hash:r.signed.requestId,state:r.state,reason:r.report?.reason??null,kind:r.kind,signedSha256:sha(canonical(r.signed))});
async function stop(){if(app){await app.close();app=null;}else store?.close();}
function crash(hash,boundary){
 const m={boundary,hash,transmissions,ciphertextSha256:sha(fs.readFileSync(store.file)),generation:store.info().generation};
 fs.writeFileSync(path.join(home,'test-crash.json'),JSON.stringify(m)+'\n',{flag:'wx',mode:0o600});
 process.kill(process.pid,'SIGKILL');
}
async function start(p){
 need(!started&&p.home===home&&p.checkpoint===witness,'E2E_CP_START');started=true;chainOrigin=loopbackOrigin(p.chainOrigin);
 store=new CheckpointLeaseStore(home,witness,{onBoundary:stage=>{
  if(writeArmed===stage){writeArmed=null;throw Error('CP_TEST_SAVE_FAILURE');}
 }});
 vault=new Vault(store);
 if(p.create){
  need(typeof p.secretHex==='string'&&/^[a-f0-9]{64}$/.test(p.secretHex),'E2E_CP_TEST_KEY');
  await vault.create(p.password);await vault.addAccount({family:'evm',label:'UP01 disposable',secretHex:p.secretHex});
  const b=await vault.backup();await vault.verifyBackup(b.encrypted,p.password);
 }else if(p.password)await vault.unlock(p.password);
 app=new ProtectedOwnerServer({store,vault});
 const real=app.nonEvm.injectiveEngine.fetchImpl;
 app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
  need(new URL(u).origin===chainOrigin,'E2E_CP_LOCAL_TARGET');
  if(o.method!=='POST'||new URL(u).pathname!=='/cosmos/tx/v1beta1/txs')return real(u,o);
  const hash=sha(Buffer.from(JSON.parse(o.body).tx_bytes,'base64')).toUpperCase();
  if(armed?.boundary==='before-request'){need(hash===armed.hash,'E2E_CP_HASH');crash(hash,'before-request');}
  transmissions++;sent.set(hash,(sent.get(hash)??0)+1);const response=await real(u,o);
  if(drop){drop=false;dropped++;await response.arrayBuffer();throw Error('E2E_TEST_RESPONSE_LOSS');}
  if(armed?.boundary==='after-inclusion'){
   need(hash===armed.hash,'E2E_CP_HASH');const d=await response.json();need(response.ok&&String(d.tx_response?.code)==='0','E2E_CP_CHECKTX');
   let included=false;
   for(let i=0;i<120;i++){
    const r=await real(chainOrigin+'/cosmos/tx/v1beta1/txs/'+hash,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error'});
    if(r.status===404){await r.body?.cancel();await new Promise(done=>setTimeout(done,100));continue;}
    const x=await r.json();need(r.ok&&x.tx_response?.txhash===hash&&String(x.tx_response?.code)==='0','E2E_CP_INCLUSION');included=true;break;
   }
   need(included,'E2E_CP_INCLUSION');crash(hash,'after-inclusion');
  }
  return response;
 };
 const s=await app.start(0);return {origin:s.origin,token:app.uiToken,accountId:vault.key?vault.publicAccounts()[0].id:null,pid:process.pid};
}
try{
 for await(const line of rl){
  let msg;
  try{
   need(Buffer.byteLength(line)<=1500000,'E2E_CP_INPUT');msg=JSON.parse(line);need(Number.isSafeInteger(msg.id)&&typeof msg.action==='string','E2E_CP_FRAME');let data;
   if(msg.action==='start')data=await start(msg.payload);
   else {need(app,'E2E_CP_STARTED');
    if(msg.action==='snapshot')data={transmissions,locked:!vault.key,protection:store.poisoned?{failed:true}:store.info(),records:vault.key?(await vault.injectiveRecords()).map(summarize):[]};
    else if(msg.action==='stats')data={ownerSends:transmissions,hashes:[...sent.keys()],perHash:[...sent.values()],droppedResponses:dropped,protection:store.info(),records:(await vault.injectiveRecords()).map(r=>({id:r.id,requestKey:r.requestKey,hash:r.signed.requestId,state:r.state}))};
    else if(msg.action==='drop-next'){need(!drop&&dropped===0,'E2E_CP_DROP');drop=true;data={armed:true};}
    else if(msg.action==='arm'){need(['before-request','after-inclusion'].includes(msg.payload.boundary)&&/^[A-F0-9]{64}$/.test(msg.payload.hash),'E2E_CP_ARM');armed=msg.payload;data={armed:true};}
    else if(msg.action==='fault'){need(['staged','intent','renamed','vault-durable','checkpoint-durable'].includes(msg.payload.stage),'E2E_CP_FAULT');writeArmed=msg.payload.stage;data={armed:true};}
    else if(msg.action==='stop'){await stop();data={closed:true};}
    else throw Error('E2E_CP_ACTION');
   }
   console.log(JSON.stringify({id:msg.id,ok:true,data}));if(msg.action==='stop')break;
  }catch(e){const c=/^(CP_|VAULT_|E2E_)[A-Z0-9_]+$/.test(e.message)?e.message:'CP_HOST_FAILED';console.log(JSON.stringify({id:msg?.id??0,ok:false,error:c.startsWith('E2E_')?c:'E2E_'+c}));process.exitCode=1;break;}
 }
}finally{await stop();rl.close();}
