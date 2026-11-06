/** One worker, a persistent nonce/fee journal, no automatic retransmission after ambiguity. */
import {randomUUID} from 'node:crypto';
import {need,canonical} from '../wallet/lib/guard.mjs';
import {feeStatus} from './policy.mjs';
import {signAction} from './codec.mjs';
import {RelayAdapter} from './adapter.mjs';
const pending=a=>['signed','broadcast','broadcast-unknown'].includes(a.state);
const errorCode=e=>/^[A-Z0-9_-]{1,100}$/.test(e?.message)?e.message:'RELAY_OPERATION_FAILED';
export class RelayWorker {
  constructor(vault,{adapter=new RelayAdapter(),now=Date.now}={}){this.vault=vault;this.adapter=adapter;this.now=now;this.epoch=0;this.active=false;this.running=false;this.cursor=0;}
  start(){this.vault.check();need(!this.active&&!this.running,'RELAY_ALREADY_RUNNING');this.active=true;this.epoch++;return this.status();}
  stop(){this.active=false;this.epoch++;return {active:false,running:this.running,inFlightTransactionsCannotBeCancelled:true};}
  status(){return {active:this.active,running:this.running,...this.vault.publicState()};}
  guard(epoch){need(this.active&&epoch===this.epoch,'RELAY_STOPPED');this.vault.check();need(this.now()>=this.vault.data.lastClock,'RELAY_CLOCK_REVERSED');need(this.now()<this.vault.data.policy.expiresAt,'RELAY_POLICY_EXPIRED');}
  persist(epoch,fn){this.guard(epoch);this.vault.update(d=>{fn(d);d.lastClock=this.now();});}
  // RPC/transport adapters only receive public transaction material, never secret keys.
  context(){const d=this.vault.data;return {policy:d.policy,keys:d.keys.map(({secretHex,...k})=>k),jobs:d.jobs,actions:d.actions};}
  async tick(){
    need(!this.running,'RELAY_TICK_IN_PROGRESS');this.running=true;const epoch=this.epoch;
    try{
      this.guard(epoch);const jobs=this.vault.data.jobs;if(!jobs.length)return {worked:false};
      let job;
      for(let i=0;i<jobs.length;i++){const at=(this.cursor+i)%jobs.length,j=jobs[at];if(!['blocked','settled-observed'].includes(j.status)&&j.nextAt<=this.now()){job=structuredClone(j);this.cursor=(at+1)%jobs.length;break;}}
      if(!job)return {worked:false};
      try{await this.step(job,epoch);return {worked:true,jobId:job.id};}
      catch(e){
        if(!this.active||this.epoch!==epoch||!this.vault.key)throw e;
        const code=errorCode(e);
        this.persist(epoch,d=>{const j=d.jobs.find(j=>j.id===job.id);j.failures++;j.lastError=code;j.nextAt=this.now()+Math.min(300000,d.policy.intervalMs*2**Math.min(j.failures,8));
          if(/RELAY_(BUDGET|TX_LIMIT|FEE_POLICY|TX_EXPIRED|SEQUENCE_CHANGED|KEY_CHANGED|SOURCE_PACKET_CHANGED|SOURCE_FAILED|PACKET_ASSET_OR_CAP|SOURCE_NOT_TRANSFER|PACKET_TRANSFER_BINDING)/.test(code))j.status='blocked';});
        return {worked:true,jobId:job.id,error:code};
      }
    }catch(e){this.stop();throw e;}finally{this.running=false;}
  }
  async step(job,epoch){
    const data=this.vault.data,route=data.policy.routes.find(r=>r.id===job.routeId);
    const unresolved=data.actions.find(a=>a.jobId===job.id&&pending(a));
    if(unresolved){
      const a=structuredClone(unresolved),receipt=await this.adapter.receipt(this.context(),a);this.guard(epoch);
      if(receipt){
        this.persist(epoch,d=>{const x=d.actions.find(x=>x.id===a.id),j=d.jobs.find(j=>j.id===job.id);x.evidence=receipt;x.state=receipt.code==='0'?'included':'failed';j.lastError=null;j.failures=0;j.nextAt=0;
          j.status=receipt.code!=='0'?'blocked':a.kind==='receive'?'active':'settled-observed';});return;
      }
      if(a.state!=='signed'){this.persist(epoch,d=>{d.jobs.find(j=>j.id===job.id).nextAt=this.now()+d.policy.intervalMs;});return;}
      await this.broadcast(job,a,epoch);return;
    }
    const plan=await this.adapter.plan(this.context(),job);this.guard(epoch);
    if(job.packet)need(canonical(job.packet)===canonical(plan.packet),'RELAY_SOURCE_PACKET_CHANGED');
    if(plan.settled){this.persist(epoch,d=>{const j=d.jobs.find(j=>j.id===job.id);j.packet=plan.packet;j.status='settled-observed';j.lastError=null;});return;}
    const draft=plan.draft,key=data.keys.find(k=>k.networkId===draft.networkId),f=feeStatus(data,draft.networkId);
    need(f.signedTransactions<f.maxTransactions&&BigInt(f.remainingFeeAtomic)>=BigInt(draft.feeAtomic),'RELAY_BUDGET_EXHAUSTED');
    need(!data.actions.some(a=>a.networkId===draft.networkId&&pending(a)),'RELAY_NETWORK_PENDING_TRANSACTION');
    need(!data.actions.some(a=>a.networkId===draft.networkId&&a.accountNumber===draft.accountNumber&&a.sequence===draft.sequence),'RELAY_SEQUENCE_CHANGED');
    const last=data.actions.filter(a=>a.networkId===draft.networkId).at(-1);
    need(!last||this.now()-last.createdAt>=data.policy.intervalMs,'RELAY_RATE_LIMIT');
    const secret=Buffer.from(key.secretHex,'hex');let signed;
    try{this.guard(epoch);signed=signAction(draft,route,plan.packet,secret);}finally{secret.fill(0);}
    this.guard(epoch);
    const action={...draft,...signed,id:randomUUID(),jobId:job.id,state:'signed',createdAt:this.now(),evidence:null};
    this.persist(epoch,d=>{const j=d.jobs.find(j=>j.id===job.id);j.packet=plan.packet;j.status='active';j.lastError=null;j.failures=0;j.nextAt=0;d.actions.push(action);});
    await this.broadcast({...job,packet:plan.packet},action,epoch);
  }
  async broadcast(job,a,epoch){
    await this.adapter.revalidate(this.context(),job,a);this.guard(epoch);
    this.persist(epoch,d=>{d.actions.find(x=>x.id===a.id).state='broadcast-unknown';});
    this.guard(epoch); // No await between this authority check and the network operation.
    await this.adapter.submit(this.context(),a);this.guard(epoch);
    this.persist(epoch,d=>{d.actions.find(x=>x.id===a.id).state='broadcast';d.jobs.find(j=>j.id===job.id).nextAt=this.now()+d.policy.intervalMs;});
  }
  async run(){
    need(this.active,'RELAY_NOT_STARTED');
    while(this.active){await this.tick();if(!this.active)break;await new Promise(resolve=>{this.wake=resolve;this.timer=setTimeout(resolve,this.vault.data.policy.intervalMs);});this.wake=null;clearTimeout(this.timer);}
  }
  interrupt(){const s=this.stop();this.wake?.();return s;}
}
