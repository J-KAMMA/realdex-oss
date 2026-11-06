/** Local test drivers. Browser RPC uses pipes only, never writes capability tokens to disk. */
import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {parseExactJson} from '../../node/extended/json.mjs';
import {need,loopbackOrigin} from './protocol.mjs';
export class ApiDriver{
 constructor(){this.transport='direct-http';this.externalRequests=0;this.syntheticResponses=0;}
 async open(c){loopbackOrigin(c.origin);this.c=c;return {transport:this.transport};}
 async call(route,body){const r=await fetch(this.c.origin+'/api/'+route,{method:'POST',headers:{origin:this.c.origin,authorization:'Bearer '+this.c.token,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'error'});return {status:r.status,data:await r.json()};}
 async request(action,payload){
  if(action==='prepare')return this.call('non-evm/injective/'+(payload.kind==='order'?'prepare':payload.kind+'/prepare'),payload.body);
  if(action==='approve')return this.call('non-evm/approve',{id:payload.id,intentId:payload.intentId,confirmation:payload.confirmation,broadcast:false});
  if(action==='submit')return this.call('non-evm/injective/submit',{id:payload.id,confirmation:payload.confirmation});
  if(action==='reconcile')return this.call('non-evm/injective/reconcile',{id:payload.id});
  throw Error('E2E_DRIVER_ACTION');
 }
 async close(){}
}
/** Validates framing, IDs, bounded output, timeout and abnormal child termination. */
export class PipeDriver{
 constructor({command='python3',args=['-I',fileURLToPath(new URL('./browser.py',import.meta.url))],timeoutMs=45000,maxBytes=1048576,env={}}={}){
  need(Number.isSafeInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=120000&&Number.isSafeInteger(maxBytes)&&maxBytes>=128&&maxBytes<=1048576,'E2E_DRIVER_LIMIT');
  this.transport='chromium-dom-http';this.externalRequests=0;this.syntheticResponses=0;this.next=1;this.pending=null;this.failure=null;this.buffer='';this.bytes=0;this.stderrBytes=0;this.timeoutMs=timeoutMs;this.maxBytes=maxBytes;
  this.child=spawn(command,args,{stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',env:{PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',...env}});
  this.closed=new Promise(resolve=>{this.child.once('close',(code,signal)=>{this.exit={code,signal};if(!this.stopping&&!(this.lastAction==='stop'&&code===0))this.fail('E2E_CHILD_EXIT');resolve(this.exit);});});
  this.child.once('error',()=>this.fail('E2E_CHILD_SPAWN'));this.child.stdin.on('error',()=>this.fail('E2E_CHILD_STDIN'));
  this.child.stderr.on('data',b=>{this.stderrBytes+=b.length;if(this.stderrBytes>maxBytes)this.fail('E2E_CHILD_OUTPUT_LIMIT');});
  this.child.stdout.on('data',b=>{
   if(this.failure)return;this.bytes+=b.length;if(this.bytes>maxBytes){this.fail('E2E_CHILD_OUTPUT_LIMIT');return;}
   this.buffer+=b.toString('utf8');let i;
   while((i=this.buffer.indexOf('\n'))>=0){const s=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+1);let msg;
    try{parseExactJson(s,{maxChars:1048576,maxNodes:20000,maxDepth:32});msg=JSON.parse(s);}catch{this.fail('E2E_CHILD_JSON');return;}
    if(!this.pending||msg?.id!==this.pending.id||typeof msg.ok!=='boolean'||Object.keys(msg).some(x=>!['id','ok','data','error'].includes(x))){this.fail('E2E_CHILD_FRAME');return;}
    const p=this.pending;this.pending=null;clearTimeout(p.timer);
    if(msg.ok){if(!Object.hasOwn(msg,'data')||Object.hasOwn(msg,'error')){this.failureDelivered=true;p.reject(Error('E2E_CHILD_FRAME'));this.fail('E2E_CHILD_FRAME');return;}p.resolve(msg.data);}
    else{this.failureDelivered=true;const code=typeof msg.error==='string'&&/^E2E_[A-Z0-9_]{1,64}$/.test(msg.error)?msg.error:'E2E_BROWSER_FAILED';p.reject(Error(code));this.fail(code);return;}
   }
  });
 }
 signal(name){try{if(this.child.pid&&process.platform!=='win32')process.kill(-this.child.pid,name);else this.child.kill(name);}catch(e){if(e.code!=='ESRCH')throw e;}}
 fail(code){if(this.failure)return;this.failure=Error(code);if(this.pending){this.failureDelivered=true;clearTimeout(this.pending.timer);this.pending.reject(this.failure);this.pending=null;}if(this.child.exitCode===null)this.signal('SIGKILL');}
 async send(action,payload){
  if(this.failure){this.failureDelivered=true;throw this.failure;}need(!this.pending&&!this.stopping,'E2E_CHILD_BUSY');
  this.lastAction=action;const id=this.next++,line=JSON.stringify({id,action,payload})+'\n';need(Buffer.byteLength(line)<=262144,'E2E_CHILD_INPUT_LIMIT');
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail('E2E_CHILD_TIMEOUT'),this.timeoutMs);this.pending={id,resolve,reject,timer};this.child.stdin.write(line);});
 }
 async open(c){loopbackOrigin(c.origin);return this.send('open',c);}
 async request(action,payload){return this.send(action,payload);}
 close(){
  if(this.closePromise)return this.closePromise;
  this.stopping=true;
  this.closePromise=(async()=>{
   if(this.pending){this.failureDelivered=true;clearTimeout(this.pending.timer);this.pending.reject(Error('E2E_CHILD_CLOSED'));this.pending=null;}
   this.child.stdin.end();let timedOut=false;
   const timer=setTimeout(()=>{if(!this.exit){timedOut=true;this.signal('SIGKILL');}},1500);
   try{const exit=await this.closed;
    if(!this.failureDelivered){if(this.failure)throw this.failure;need(!timedOut&&exit.code===0&&exit.signal===null,'E2E_CHILD_CLOSE_FAILED');}
    return exit;
   }finally{clearTimeout(timer);}
  })();return this.closePromise;
 }
}
