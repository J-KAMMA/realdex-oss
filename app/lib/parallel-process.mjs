/** Bounded child processes for test execution. Never starts an agent or deploys. */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';

export function testEnvironment(source=process.env) {
  const out={CI:'1',REALDEX_REQUIRE_OFFLINE_SOLC:'1'};
  for (const key of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ']) {
    if (typeof source[key]==='string') out[key]=source[key];
  }
  return out;
}
function requireValue(ok,code) { if (!ok) throw new Error(code); }

/** Log is opened exclusively. Abort/timeout terminates the owned process group on Unix. */
export async function runProcess({command,args=[],cwd,log,timeoutMs=600000,maxLogBytes=33554432,signal,env=testEnvironment()}) {
  requireValue(typeof command==='string'&&Array.isArray(args)&&args.every(x=>typeof x==='string'),'CI_COMMAND_INVALID');
  requireValue(Number.isSafeInteger(timeoutMs)&&timeoutMs>=20&&timeoutMs<=1800000,'CI_TIMEOUT_INVALID');
  requireValue(Number.isSafeInteger(maxLogBytes)&&maxLogBytes>=1024&&maxLogBytes<=134217728,'CI_LOG_LIMIT_INVALID');
  requireValue(!signal?.aborted,'CI_ABORTED_BEFORE_START');
  const fd=fs.openSync(log,'wx',0o600),started=performance.now(),startedAt=new Date().toISOString();
  return await new Promise(resolve=>{
    let child,done=false,error=null,reason=null,timer,monitor,escalation;
    const kill=(sig)=>{
      if (!child?.pid) return;
      try { if (process.platform!=='win32') process.kill(-child.pid,sig); else child.kill(sig); }
      catch(e) { if(e.code!=='ESRCH') error??=e; }
    };
    const stop=(why)=>{
      if(done||reason)return;reason=why;kill('SIGTERM');
      escalation=setTimeout(()=>kill('SIGKILL'),250);escalation.unref?.();
    };
    const aborted=()=>stop('CI_ABORTED');
    const finish=(status,terminationSignal)=>{
      if(done)return;done=true;clearTimeout(timer);clearInterval(monitor);clearTimeout(escalation);
      signal?.removeEventListener('abort',aborted);
      if(fs.fstatSync(fd).size>maxLogBytes)reason??='CI_LOG_LIMIT';
      // A runner may leave descendants behind even when the direct process exits.
      if(process.platform!=='win32')kill('SIGKILL');
      fs.closeSync(fd);
      resolve({status,signal:terminationSignal??null,error:error?{code:error.code??'SPAWN_FAILED'}:reason?{code:reason}:null,
        reason,startedAt,finishedAt:new Date().toISOString(),durationMs:Math.round(performance.now()-started),
        logBytes:fs.statSync(log).size,processTreeTermination:process.platform==='win32'?'direct-child-only':'owned-process-group'});
    };
    try {
      child=spawn(command,args,{cwd,env,stdio:['ignore',fd,fd],shell:false,detached:process.platform!=='win32',windowsHide:true});
      child.once('error',e=>{error=e;});child.once('close',finish);
      signal?.addEventListener('abort',aborted,{once:true});
      if(signal?.aborted)aborted();
      timer=setTimeout(()=>stop('CI_TIMEOUT'),timeoutMs);
      monitor=setInterval(()=>{try{if(fs.fstatSync(fd).size>maxLogBytes)stop('CI_LOG_LIMIT');}catch{stop('CI_LOG_READ_FAILED');}},50);
    } catch(e) { error=e;finish(null,null); }
  });
}

/** Executes every selected job once, at most concurrency jobs at a time. */
export async function runPool(items,worker,{concurrency=3,signal}={}) {
  requireValue(Array.isArray(items)&&items.length>0&&items.length<=32,'CI_JOBS_INVALID');
  requireValue(Number.isSafeInteger(concurrency)&&concurrency>=1&&concurrency<=4,'CI_CONCURRENCY_INVALID');
  const results=new Array(items.length);let next=0;
  async function loop(){
    for(;;){const index=next++;if(index>=items.length)return;
      if(signal?.aborted){results[index]={status:'cancelled',reason:'CI_ABORTED_BEFORE_START'};continue;}
      try{results[index]=await worker(items[index],index);}catch(e){results[index]={status:'failed',reason:e instanceof Error?e.message:'CI_WORKER_FAILED'};}
    }
  }
  await Promise.all(Array.from({length:Math.min(items.length,concurrency)},loop));return results;
}
