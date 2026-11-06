#!/usr/bin/env node
/** No network control API, passphrase argument, environment secret, or auto-start on wallet unlock. */
import fs from 'node:fs';
import {RelayVault} from './store.mjs';
import {RelayWorker} from './engine.mjs';
import {need,safeError} from '../wallet/lib/guard.mjs';
const args=process.argv.slice(2),command=args.shift();let vault,worker;
function readPrivate(fd){
  need(Number.isInteger(fd)&&fd>=0&&fd<=64&&fd!==1&&fd!==2,'RELAY_PASSWORD_FD');
  need(!(fd===0&&process.stdin.isTTY),'RELAY_USE_NON_ECHO_PASSWORD_PIPE');
  const parts=[];let size=0;try{for(;;){const b=Buffer.alloc(1025),n=fs.readSync(fd,b,0,b.length,null);if(!n){b.fill(0);break;}parts.push(b.subarray(0,n));size+=n;need(size<=1024,'RELAY_PASSWORD_LENGTH');}
    return Buffer.concat(parts).toString('utf8').replace(/\r?\n$/,'');
  }finally{for(const b of parts)b.fill(0);}
}
try{
  need(['init','enqueue','status','start'].includes(command),'RELAY_COMMAND');
  const options={},flags=new Set();
  for(let i=0;i<args.length;i++){
    const k=args[i];if(k==='--once'){need(!flags.has(k),'RELAY_DUPLICATE_OPTION');flags.add(k);continue;}
    need(['--directory','--password-fd','--policy','--route','--tx','--confirm'].includes(k)&&!Object.hasOwn(options,k)&&i+1<args.length,'RELAY_ARGUMENT');options[k]=args[++i];
  }
  const permitted={init:['--directory','--password-fd','--policy'],enqueue:['--directory','--password-fd','--route','--tx'],status:['--directory','--password-fd'],start:['--directory','--password-fd','--confirm']}[command];
  need(Object.keys(options).every(k=>permitted.includes(k))&&permitted.every(k=>typeof options[k]==='string'&&options[k].length>0)&&(command==='start'||!flags.size),'RELAY_ARGUMENT');
  need(/^[0-9]+$/.test(options['--password-fd']),'RELAY_PASSWORD_FD');let password=readPrivate(Number(options['--password-fd']));
  vault=new RelayVault(options['--directory']);
  if(command==='init'){
    const s=fs.lstatSync(options['--policy']);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=131072,'RELAY_POLICY_FILE');
    const policy=JSON.parse(fs.readFileSync(options['--policy'],'utf8'));console.log(JSON.stringify(await vault.create(policy,password),null,2));
  }else{
    await vault.unlock(password);password='';
    if(command==='enqueue'){const id=vault.enqueue(options['--route'],options['--tx']);console.log(JSON.stringify({queued:id,...vault.publicState()},null,2));}
    else if(command==='status')console.log(JSON.stringify(vault.publicState(),null,2));
    else{
      need(options['--confirm']===vault.data.policyHash,'RELAY_POLICY_CONFIRMATION_REQUIRED');
      worker=new RelayWorker(vault);const stop=()=>worker.interrupt();process.once('SIGINT',stop);process.once('SIGTERM',stop);
      worker.start();console.log(JSON.stringify({event:'relay-started',policyHash:vault.data.policyHash,expiresAt:vault.data.policy.expiresAt,queued:vault.data.jobs.length,scope:'local-development-only; bounded fee keys; no asset wallet access'}));
      if(flags.has('--once')){const tick=await worker.tick();console.log(JSON.stringify({event:'relay-tick',...tick}));if(tick.error)process.exitCode=2;}else await worker.run();
      console.log(JSON.stringify({event:'relay-stopped',...vault.publicState()},null,2));
    }
  }
}catch(e){console.error(safeError(e));process.exitCode=1;}
finally{worker?.interrupt();vault?.close();}
