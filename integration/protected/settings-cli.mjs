/** Smoke the actual fixed production launcher with a disposable empty pair. No runtime or signer fixture. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {randomBytes} from 'node:crypto';
import {need,sha,cleanupAll} from '../owner-e2e/protocol.mjs';
const ROOT=path.resolve(import.meta.dirname,'../..');
async function launch(root,home,checkpoint,enroll){
 const p=spawn('python3',['-I','-S',path.join(root,'wallet/protected/launch.py'),'--directory',home,'--checkpoint',checkpoint,'--acknowledge-experimental','--port','0',...(enroll?['--enroll']:[])],{cwd:root,stdio:['ignore','pipe','pipe'],shell:false,env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8'}});
 let text='',bytes=0;const closed=new Promise(resolve=>p.once('close',(code,signal)=>resolve({code,signal})));
 const connection=await new Promise((resolve,reject)=>{
  const t=setTimeout(()=>{p.kill('SIGKILL');reject(Error('E2E_SETTINGS_CLI_TIMEOUT'));},20000);
  p.on('error',()=>{clearTimeout(t);reject(Error('E2E_SETTINGS_CLI_SPAWN'));});
  p.once('exit',()=>{clearTimeout(t);reject(Error('E2E_SETTINGS_CLI_EXIT'));});
  p.stderr.on('data',b=>{bytes+=b.length;if(bytes>16384)p.kill('SIGKILL');});
  p.stdout.on('data',b=>{bytes+=b.length;if(bytes>16384){p.kill('SIGKILL');return;}text+=b;const m=/(http:\/\/127\.0\.0\.1:\d+)\/wallet\/#key=([a-f0-9]{64})/.exec(text);if(m){clearTimeout(t);resolve({origin:m[1],token:m[2]});}});
 });
 return {p,closed,...connection};
}
async function stop(h){if(!h)return;h.p.kill('SIGTERM');const timer=setTimeout(()=>h.p.kill('SIGKILL'),5000);try{const r=await h.closed;need(r.code===0&&!r.signal,'E2E_SETTINGS_CLI_STOP');}finally{clearTimeout(timer);}}
export async function runSettingsCli({root=ROOT,baseline=false}={}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up02-cli-vault-')),cp=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up02-cli-witness-')),password='UP02 ephemeral '+randomBytes(18).toString('hex');
 let h,primary;const checks=[];const call=async(route,body={})=>{const r=await fetch(h.origin+'/api/'+route,{method:'POST',headers:{origin:h.origin,authorization:'Bearer '+h.token,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(20000)});return {status:r.status,data:await r.json()};};
 const ok=r=>{need(r.status===200&&!r.data.error,'E2E_SETTINGS_CLI_API');return r.data;};
 try{
  h=await launch(root,home,cp,true);checks.push('actual-fixed-product-launch');ok(await call('create',{password}));checks.push('real-owner-api-create');
  if(baseline){const r=await call('origins/set',{origins:['http://localhost:41234']});need(r.status===400&&r.data.error==='CP_SETTINGS_CHANGE_UNSUPPORTED','E2E_SETTINGS_BASELINE');return {schema:'realdex.up02-settings-cli.v1',baseline:true,checks:[...checks,'up01-settings-change-unsupported-reproduced'],observedError:r.data.error,passed:true};}
  const html=await (await fetch(h.origin+'/wallet/',{signal:AbortSignal.timeout(10000)})).text();need(html.includes('id="protectedSettingsPanel"')&&html.includes('id="protectedSettingsApply"'),'E2E_SETTINGS_UI_ASSET');checks.push('real-server-serves-settings-ui');
  const original=ok(await call('protected/settings'));const settings={...original.settings,allowedAppOrigins:['http://localhost:41234']};
  const p=ok(await call('protected/settings/prepare',{settings}));ok(await call('protected/settings/apply',{id:p.id,reviewSha256:p.reviewSha256,confirmation:'SAVE SETTINGS AND LOCK'}));checks.push('prepare-and-separate-owner-approval');
  need(ok(await call('status')).locked,'E2E_SETTINGS_CLI_LOCK');checks.push('configuration-commit-locks');
  ok(await call('unlock',{password}));need(ok(await call('protected/settings')).revision===1,'E2E_SETTINGS_CLI_REVISION');const backup=ok(await call('backup'));checks.push('exact-backup-includes-settings');
  const locks=[home,cp].map(d=>fs.statSync(path.join(d,'writer.lock')).ino),cipher=sha(fs.readFileSync(path.join(home,'vault.json'))),old=h;
  await stop(h);h=null;h=await launch(root,home,cp,false);need(h.token!==old.token,'E2E_SETTINGS_CLI_TOKEN');
  need(sha(fs.readFileSync(path.join(home,'vault.json')))===cipher,'E2E_SETTINGS_CLI_CIPHER_CHANGED');checks.push('restart-same-pair-without-rewrite');
  const locked=ok(await call('status'));need(locked.locked&&!locked.protectedSettings.loaded&&locked.allowedAppOrigins.length===0,'E2E_SETTINGS_CLI_DISCLOSURE');checks.push('locked-restart-hides-configuration');
  ok(await call('unlock',{password}));const current=ok(await call('protected/settings'));need(current.revision===1&&JSON.stringify(current.settings)===JSON.stringify(settings),'E2E_SETTINGS_CLI_PERSISTENCE');checks.push('decrypt-loads-exact-persisted-settings');
  need(ok(await call('backup')).encrypted===backup.encrypted,'E2E_SETTINGS_CLI_BACKUP_CHANGED');checks.push('unlock-does-not-stale-backup');
  need([home,cp].every((d,i)=>fs.statSync(path.join(d,'writer.lock')).ino===locks[i]),'E2E_SETTINGS_CLI_LOCK_CHANGED');checks.push('permanent-locks-retained');
  return {schema:'realdex.up02-settings-cli.v1',passed:true,baseline:false,checks,actualProductEntry:true,browserTested:false,signerUsed:false,userFunds:false,productionReady:false};
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>stop(h),()=>fs.rmSync(home,{recursive:true,force:true}),()=>fs.rmSync(cp,{recursive:true,force:true})]);}
}
