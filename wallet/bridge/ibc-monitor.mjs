/** Session-only, bounded, read-only scheduler. It has no signer or broadcast operation. */
import {need,shape,safeError} from '../lib/guard.mjs';
export const IBC_MONITOR_LIMIT=16;
export const IBC_MONITOR_DEFAULT_INTERVAL_MS=30000;
export const IBC_MONITOR_MAX_BACKOFF_MS=300000;
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function monitorOptions(value) {
  shape(value,['ids'],['intervalMs']);
  need(Array.isArray(value.ids)&&value.ids.length>0&&value.ids.length<=IBC_MONITOR_LIMIT
    &&value.ids.every(id=>typeof id==='string'&&ID.test(id))&&new Set(value.ids).size===value.ids.length,'IBC_MONITOR_IDS');
  const intervalMs=value.intervalMs??IBC_MONITOR_DEFAULT_INTERVAL_MS;
  need(Number.isSafeInteger(intervalMs)&&intervalMs>=5000&&intervalMs<=300000,'IBC_MONITOR_INTERVAL');
  return {ids:[...value.ids],intervalMs};
}
export class IbcMonitor {
  constructor({probe,available=()=>true,busy=()=>false,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout}) {
    need(typeof probe==='function','IBC_MONITOR_PROBE_REQUIRED');
    Object.assign(this,{probe,available,busy,now,setTimer,clearTimer});
    this.enabled=false;this.running=false;this.generation=0;this.timer=null;this.entries=[];this.intervalMs=IBC_MONITOR_DEFAULT_INTERVAL_MS;
    this.reason='NOT_STARTED';this.lastClock=this.now();
  }
  canObserve(){try{return this.available()===true;}catch{return false;}}
  status(){return {enabled:this.enabled,running:this.running,reason:this.reason,intervalMs:this.intervalMs,
    readOnly:true,signingAuthority:false,relayTransactions:false,requiresUnlockedVault:true,autoResume:false,
    entries:this.entries.map(e=>({...e}))};}
  start(options) {
    const {ids,intervalMs}=monitorOptions(options);
    need(!this.running,'IBC_MONITOR_DRAINING');need(this.canObserve(),'IBC_MONITOR_UNAVAILABLE');
    this.stop('RESTARTED');this.enabled=true;this.reason='RUNNING';this.intervalMs=intervalMs;this.lastClock=this.now();
    this.entries=ids.map(id=>({id,nextAt:this.lastClock,lastAt:null,checks:0,failures:0,stage:null,error:null}));
    this.schedule(0);return this.status();
  }
  stop(reason='OWNER_STOPPED') {
    this.generation++;this.enabled=false;this.reason=reason;this.entries=[];
    if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;
    return this.status();
  }
  schedule(delay) {
    if(!this.enabled)return;
    if(this.timer!==null)this.clearTimer(this.timer);
    this.timer=this.setTimer(()=>{this.timer=null;void this.tick();},delay);this.timer?.unref?.();
  }
  async tick() {
    if(!this.enabled||this.running)return;
    const now=this.now();if(now<this.lastClock){this.stop('CLOCK_MOVED_BACKWARD');return;}this.lastClock=now;
    if(!this.canObserve()){this.stop('WALLET_UNAVAILABLE');return;}
    try{if(this.busy()){this.reason='WAITING_FOR_OWNER';this.schedule(1000);return;}}catch{this.stop('MONITOR_ENVIRONMENT_ERROR');return;}
    const next=[...this.entries].sort((a,b)=>a.nextAt-b.nextAt)[0];
    if(!next){this.stop('NO_TARGETS');return;}
    if(next.nextAt>now){this.schedule(Math.max(1000,next.nextAt-now));return;}
    this.reason='RUNNING';this.running=true;const generation=this.generation;
    const authorize=()=>{need(this.enabled&&this.generation===generation,'IBC_MONITOR_STOPPED');need(this.canObserve(),'IBC_MONITOR_UNAVAILABLE');};
    try {
      authorize();const result=await this.probe(next.id,{authorize});authorize();
      next.lastAt=this.now();next.checks++;next.stage=result.report?.stage??result.state;
      if(next.stage==='inconsistent'){next.failures++;next.error=result.report?.reason??'IBC_TRACKING_INCONSISTENT';}
      else{next.failures=0;next.error=null;}
    } catch(error) {
      if(this.enabled&&generation===this.generation){next.lastAt=this.now();next.checks++;next.failures++;next.error=safeError(error);}
    } finally {
      this.running=false;
      if(this.enabled&&generation===this.generation){
        if(!this.canObserve()){this.stop('WALLET_UNAVAILABLE');}
        else{next.nextAt=this.now()+Math.min(IBC_MONITOR_MAX_BACKOFF_MS,this.intervalMs*2**Math.min(next.failures,6));this.schedule(1000);}
      }
    }
  }
}
