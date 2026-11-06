/** One command, two isolated services. Node identity and wallet signing authority never mix. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {need} from '../wallet/lib/guard.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
/** Do not pass AI tokens, signing keys, cloud credentials, or NODE_OPTIONS to shared services. */
export function isolatedServiceEnvironment(source=process.env) {
  const result={};
  for(const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ']) {
    if(Object.hasOwn(source,key)&&typeof source[key]==='string')result[key]=source[key];
  }
  return result;
}

export function applicationOptions(raw={}) {
  const allowed=['directory','nodePort','walletPort'];need(Object.keys(raw).every(k=>allowed.includes(k)),'APP_OPTION_INVALID');
  const directory=path.resolve(raw.directory??path.join(os.homedir(),'.realdex-app'));
  const nodePort=Number(raw.nodePort??8787),walletPort=Number(raw.walletPort??8790);
  for(const port of [nodePort,walletPort])need(Number.isInteger(port)&&port>=1024&&port<=65535,'APP_PORT_INVALID');
  need(nodePort!==walletPort,'APP_PORT_CONFLICT');return {directory,nodePort,walletPort};
}
function privateDirectory(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});const s=fs.lstatSync(directory);need(s.isDirectory()&&!s.isSymbolicLink(),'APP_DIRECTORY_UNSAFE');if(process.platform!=='win32')need(s.uid===process.getuid()&&(s.mode&0o077)===0,'APP_DIRECTORY_PERMISSIONS');}
/** On forced OS termination stale locks are deliberately NOT removed automatically. */
async function stop(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>{
    const timer=setTimeout(()=>{child.kill('SIGKILL');},5000);timer.unref();
    child.once('close',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
  });
}
function startService(file,args,recognize) {
  const child=spawn(process.execPath,[file,...args],{cwd:ROOT,env:isolatedServiceEnvironment(),stdio:['ignore','pipe','pipe'],shell:false});
  const ready=new Promise((resolve,reject)=>{
    let output='',errorText='';const timer=setTimeout(()=>reject(Error('APP_SERVICE_START_TIMEOUT')),15000);
    child.once('error',()=>{clearTimeout(timer);reject(Error('APP_SERVICE_START_FAILED'));});
    child.stderr.on('data',b=>{if(errorText.length<1000)errorText+=b.toString();});
    child.stdout.on('data',b=>{
      output+=b.toString();if(output.length>32768){clearTimeout(timer);reject(Error('APP_SERVICE_OUTPUT_LIMIT'));return;}
      const value=recognize(output);if(value){clearTimeout(timer);resolve(value);output='';}
    });
    child.once('close',()=>{clearTimeout(timer);reject(Error('APP_SERVICE_EXITED_DURING_START'));});
  });
  return {child,ready};
}
export async function startApplication(raw={}, {signal}={}) {
  const checkAbort=()=>need(!signal?.aborted,'APP_START_ABORTED');checkAbort();
  const options=applicationOptions(raw),{directory,nodePort,walletPort}=options;privateDirectory(directory);
  const nodeDirectory=path.join(directory,'node'),walletDirectory=path.join(directory,'wallet');
  if(!fs.existsSync(nodeDirectory)){
    const init=spawnSync(process.execPath,['node/cli.mjs','init','--directory',nodeDirectory,'--port',String(nodePort)],{cwd:ROOT,env:isolatedServiceEnvironment(),encoding:'utf8',timeout:15000});need(init.status===0,'APP_NODE_INIT_FAILED');
  }
  privateDirectory(nodeDirectory);privateDirectory(walletDirectory);
  const configFile=path.join(nodeDirectory,'config.json'),stat=fs.lstatSync(configFile);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<131072,'APP_NODE_CONFIG_INVALID');
  const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
  need(config.host==='127.0.0.1'&&config.port===nodePort&&config.serveDex===false,'APP_NODE_CONFIG_REQUIRES_LOCAL_READONLY');
  const settingsFile=path.join(walletDirectory,'settings.json');
  if(!fs.existsSync(settingsFile))fs.writeFileSync(settingsFile,JSON.stringify({schema:'realdex.wallet-settings.v1',allowedAppOrigins:[`http://127.0.0.1:${nodePort}`],networks:[]},null,2)+'\n',{flag:'wx',mode:0o600});
  let nodeService,walletService,closing=false,closePromise;
  const close=()=>{
    if(closePromise)return closePromise;
    closing=true;
    closePromise=(async()=>{if(walletService)await stop(walletService.child);if(nodeService)await stop(nodeService.child);signal?.removeEventListener('abort',onAbort);})();
    return closePromise;
  };
  let rejectAbort;
  const aborted=new Promise((_,reject)=>{rejectAbort=reject;});
  function onAbort(){rejectAbort(Error('APP_START_ABORTED'));void close();}
  // Race promises always observe the rejection, even if the signal fires after readiness.
  signal?.addEventListener('abort',onAbort,{once:true});
  const readiness=async(service)=>{const value=await Promise.race([service.ready,aborted]);checkAbort();return value;};
  try {
    checkAbort();nodeService=startService('node/cli.mjs',['start','--config',configFile],text=>text.includes('"walletSigning": false')?{url:`http://127.0.0.1:${nodePort}/node/`}:null);
    const node=await readiness(nodeService);checkAbort();
    walletService=startService('wallet/cli.mjs',['start','--directory',walletDirectory,'--port',String(walletPort)],text=>{
      const found=text.match(/http:\/\/127\.0\.0\.1:\d+\/wallet\/#key=[a-f0-9]{64}/);return found?{url:found[0]}:null;
    });
    const wallet=await readiness(walletService);
    need(nodeService.child.exitCode===null&&walletService.child.exitCode===null,'APP_SERVICE_EXITED_DURING_START');
    return {options,nodeUrl:node.url,walletLaunchUrl:wallet.url,close,
      onUnexpectedExit(callback){for(const service of [nodeService,walletService])service.child.once('close',()=>{if(!closing){callback();void close();}});}};
  } catch(error){await close();throw error;}
}
