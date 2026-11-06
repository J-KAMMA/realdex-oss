#!/usr/bin/env node
/** Disposable test host ONLY. No fault hook is installed in the product server/CLI. */
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';
import {KernelLeaseStore} from './kernel-store.mjs';import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';import {parseExactJson} from '../../node/extended/json.mjs';
import {need,sha,loopbackOrigin} from './protocol.mjs';
import {validateArm,fixtureDirectory,readPrivateFile,writeExclusive,signedDigest} from './crash-protocol.mjs';
need(process.env.REALDEX_E2E08_CHILD==='disposable-only','E2E_KERNEL_CHILD_ONLY');
const lines=readline.createInterface({input:process.stdin});let app,store,vault,home,chainOrigin,armed=null,transportCalls=0,started=false,lastId=0;
const summarize=r=>({id:r.id,hash:r.signed.requestId,signedSha256:signedDigest(r.signed),state:r.state,reason:r.report?.reason??null});
async function stop(){if(app){await app.close();app=null;}else store?.close();}
async function markAndCrash(requestHash,included){
 const records=await vault.injectiveRecords();const r=records.find(r=>r.signed.requestId===requestHash);
 need(records.length===1&&r?.state==='broadcast-unknown'&&r.report?.reason==='SUBMISSION_STARTING','E2E_CRASH_PERSISTED_START_REQUIRED');
 const cipher=readPrivateFile(path.join(home,'vault.json'));
 const marker={schema:'realdex.owner-kernel-marker.v1',boundary:armed.boundary,requestHash,recordState:r.state,recordReason:r.report.reason,lockInode:store.lockStat.ino,directoryInode:store.directoryStat.ino,transportCalls,included,ciphertextSha256:sha(cipher),signedSha256:signedDigest(r.signed),publicNetwork:false,productionReady:false};
 writeExclusive(path.join(home,'kernel-crash-marker.json'),JSON.stringify(marker)+'\n');
 process.kill(process.pid,'SIGKILL');await new Promise(()=>{});
}
async function handle(action,p){
 if(action==='probe'){
  need(!started,'E2E_KERNEL_ALREADY_STARTED');started=true;home=path.resolve(process.argv[2]);
  store=new KernelLeaseStore(home);return {pid:process.pid,ino:store.lockStat.ino,marker:fs.readFileSync(store.lockFile,'utf8')};
 }
 if(action==='probe-write'){need(store&&!app,'E2E_KERNEL_PROBE');store.write(p.data,{create:p.create===true});return {written:true};}
 if(action==='probe-read'){need(store&&!app,'E2E_KERNEL_PROBE');return {data:store.read()};}
 if(action==='probe-stop'){need(store&&!app,'E2E_KERNEL_PROBE');store.close();store=null;return {closed:true};}
 if(action==='probe-drop-lease'){
  need(store&&!app,'E2E_KERNEL_PROBE');
  const r=spawnSync('python3',['-I','-c','import fcntl; fcntl.flock(3,fcntl.LOCK_UN)'],{stdio:['ignore','ignore','ignore',store.lock],timeout:5000});
  need(r.status===0,'E2E_KERNEL_DROP_FAILED');return {dropped:true};
 }
 if(action==='stop'&&store&&!app){store.close();store=null;return {closed:true};}
 if(action==='start'){
  need(!started&&p&&typeof p.create==='boolean'&&typeof p.password==='string'&&p.password.length>=20&&p.password.length<=128,'E2E_CRASH_START');started=true;
  home=path.resolve(process.argv[2]);need(p.home===home,'E2E_KERNEL_HOME_BINDING');chainOrigin=loopbackOrigin(p.chainOrigin);
  try{store=new KernelLeaseStore(home);}catch(e){if(e.message==='VAULT_IN_USE_OR_STALE_LOCK')throw Error('E2E_CRASH_STALE_LOCK');throw e;}
  vault=new Vault(store);
  if(p.create){need(typeof p.secretHex==='string'&&/^[a-f0-9]{64}$/.test(p.secretHex),'E2E_CRASH_TEST_KEY');await vault.create(p.password);await vault.addAccount({family:'evm',label:'Disposable E2E02 owner',secretHex:p.secretHex});const b=await vault.backup();await vault.verifyBackup(b.encrypted,p.password);}
  else {need(p.secretHex===undefined,'E2E_CRASH_RESTART_NO_KEY_IMPORT');await vault.unlock(p.password);}
  app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});
  const real=app.nonEvm.injectiveEngine.fetchImpl;
  app.nonEvm.injectiveEngine.fetchImpl=async(u,o)=>{
   need(new URL(u).origin===chainOrigin,'E2E_CRASH_LOCAL_TARGET');
   const submitting=o.method==='POST'&&new URL(u).pathname==='/cosmos/tx/v1beta1/txs';
   if(!submitting)return real(u,o);
   const body=JSON.parse(o.body),hash=sha(Buffer.from(body.tx_bytes,'base64')).toUpperCase();
   if(armed){need(armed.requestHash===hash,'E2E_CRASH_WRONG_ARMED_HASH');if(armed.boundary==='before-request')await markAndCrash(hash,null);}
   transportCalls++;const response=await real(u,o);
   if(armed?.boundary==='after-inclusion'){
    const accepted=await response.json();need(response.ok&&String(accepted.tx_response?.code)==='0'&&accepted.tx_response?.txhash===hash,'E2E_CRASH_CHECKTX');
    const until=Date.now()+15000;let included;
    while(Date.now()<until){
     const r=await real(chainOrigin+'/cosmos/tx/v1beta1/txs/'+hash,{method:'GET',headers:{accept:'application/json'},signal:AbortSignal.timeout(5000),redirect:'error',credentials:'omit'});
     if(r.status===404){await r.body?.cancel();await new Promise(done=>setTimeout(done,100));continue;}
     const d=await r.json();need(r.ok&&d.tx_response?.txhash===hash&&String(d.tx_response?.code)==='0','E2E_CRASH_INCLUSION');
     const t=d.tx_response;included={hash:t.txhash,code:Number(t.code),height:String(t.height),gasWanted:String(t.gas_wanted),gasUsed:String(t.gas_used)};break;
    }
    need(included,'E2E_CRASH_INCLUSION_TIMEOUT');await markAndCrash(hash,included);
   }
   return response;
  };
  const s=await app.start(0),accounts=vault.status().accounts;need(accounts.length===1,'E2E_CRASH_OWNER_COUNT');return {origin:s.origin,token:app.uiToken,accountId:accounts[0].id,pid:process.pid};
 }
 need(app,'E2E_CRASH_NOT_STARTED');
 if(action==='arm'){validateArm(p);need(!armed&&transportCalls===0,'E2E_CRASH_ALREADY_ARMED');const a=await vault.injectiveRecords();need(a.length===1&&a[0].signed.requestId===p.requestHash&&a[0].state==='signed','E2E_CRASH_SIGNED_RECORD_REQUIRED');armed={...p};return {armed:true,boundary:p.boundary};}
 if(action==='snapshot')return {transportCalls,records:(await vault.injectiveRecords()).map(summarize)};
 if(action==='stop'){await stop();return {closed:true};}
 throw Error('E2E_CRASH_ACTION');
}
try{for await(const line of lines){let msg;try{
 need(Buffer.byteLength(line)<=262144,'E2E_CRASH_INPUT_LIMIT');parseExactJson(line,{maxChars:262144,maxNodes:3000,maxDepth:12});msg=JSON.parse(line);
 need(Number.isSafeInteger(msg.id)&&msg.id===lastId+1&&Object.keys(msg).length===3&&typeof msg.action==='string'&&Object.hasOwn(msg,'payload'),'E2E_CRASH_FRAME');lastId=msg.id;
 const data=await handle(msg.action,msg.payload);console.log(JSON.stringify({id:msg.id,ok:true,data}));if(['stop','probe-stop'].includes(msg.action))break;
 }catch(e){console.log(JSON.stringify({id:msg?.id??0,ok:false,error:e instanceof Error&&/^E2E_(?:CRASH|KERNEL)_[A-Z0-9_]+$/.test(e.message)?e.message:'E2E_CRASH_HOST_FAILED'}));process.exitCode=1;break;}}
}finally{await stop();lines.close();}
