import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {prepareInjectiveLimitOrder,prepareInjectiveCancelOrder,orderProgress,reconcileInjectiveOrderObservation} from '../injective-orders.mjs';
import {demoSnapshot} from '../demo.mjs';import {accountAddress} from '../../../wallet/codec/bech32.mjs';
import {fields,text,one} from '../protobuf.mjs';
const now=1788652800000,sender=accountAddress('inj',Buffer.alloc(20,1));
const input=()=>({requestKey:'order-1',sender,subaccountId:'0x'+'01'.repeat(20)+'00'.repeat(12),side:'buy',quantity:'1.25',limitPrice:'11'});
const plan=()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),input(),{now});
test('Exact Injective LegacyDec scaling and protobuf fields match the pinned v1beta1 schema',()=>{
 const p=plan(),m=fields(Buffer.from(p.message.valueBase64,'base64')),o=fields(one(m,2,2)),oi=fields(one(o,2,2));
 assert.equal(text(m,1),sender);assert.equal(text(oi,3),'11000000');assert.equal(text(oi,4),'1250000000000000000000000000000000000');
 assert.equal(text(oi,2),sender);assert.equal(text(oi,5),p.clientOrderId);assert.equal(one(o,3,0),1n);assert.equal(text(o,4),'0');
 assert.equal(p.quoteNotionalCeilingAtomic,'13750000');assert.equal(p.baseQuantityAtomic,'1250000000000000000');
 assert.equal(p.executable,false);assert.equal(p.signingEnabled,false);assert.equal(p.broadcastEnabled,false);
});
test('Sell is a separate order enum, never a leveraged or triggered order',()=>{
 const p=prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),side:'sell'},{now});assert.equal(p.messageData.order.orderType,2);
});
for(const [key,value]of [['quantity','0'],['quantity','1.251'],['limitPrice','11.5'],['side','market'],['side','perp'],['quantity','1e0'],['limitPrice','1e1'],['requestKey','../escape']])test('Reject malformed or off-tick order '+key+'='+value,()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),[key]:value},{now})));
test('Unknown request properties cannot add arbitrary calls, leverage or recipient overrides',()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),feeRecipient:sender},{now}),/INJ_ORDER_FIELDS/));
test('An account cannot propose another owner subaccount',()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),subaccountId:'0x'+'02'.repeat(32)},{now}),/OWNER_MISMATCH/));
test('Uppercase or ambiguous address forms are refused',()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),sender:sender.toUpperCase()},{now}),/CANONICAL/));
test('Expired observation cannot prepare an order',()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('injective',now),input(),{now:now+30001}),/EXPIRED/));
test('Unknown minimum-order requirement blocks preparation',()=>{const s=demoSnapshot('injective',now);s.market.minNotionalKnown=false;assert.throws(()=>prepareInjectiveLimitOrder(s,input(),{now}),/REQUIREMENTS_UNKNOWN/);});
test('Minimum notional is tested without floating-point rounding',()=>{const s=demoSnapshot('injective',now);s.market.minNotionalQuote={numerator:'13750001',denominator:'1'};assert.throws(()=>prepareInjectiveLimitOrder(s,input(),{now}),/MINIMUM_NOTIONAL/);});
test('A HyperCore book cannot be reused as an Injective order',()=>assert.throws(()=>prepareInjectiveLimitOrder(demoSnapshot('hypercore',now),input(),{now}),/SPOT_SNAPSHOT/));
test('Plan binds the snapshot and exact request and leaves no mutable asset references',()=>{
 const s=demoSnapshot('injective',now),a=prepareInjectiveLimitOrder(s,input(),{now}),b=prepareInjectiveLimitOrder(s,input(),{now});assert.deepEqual(a,b);
 const changed=prepareInjectiveLimitOrder(s,{...input(),quantity:'1.26'},{now});assert.equal(a.clientOrderId,changed.clientOrderId);assert.notEqual(a.inputSha256,changed.inputSha256);
 s.market.base.symbol='changed';assert.notEqual(a.baseAsset.symbol,'changed');assert.equal(a.orderExpiryOnChain,null);
});
test('Cancel contains the exact market, owner, subaccount and order hash; it is not a success receipt',()=>{
 const i=input(),hash='0x'+'bc'.repeat(32),p=plan(),c=prepareInjectiveCancelOrder({sender,marketId:p.marketId,subaccountId:i.subaccountId,orderHash:hash}),f=fields(Buffer.from(c.message.valueBase64,'base64'));
 assert.equal(text(f,1),sender);assert.equal(text(f,2),p.marketId);assert.equal(text(f,3),i.subaccountId);assert.equal(text(f,4),hash);assert.equal(c.cancelled,false);assert.equal(c.executable,false);
});
test('Partial fill and cancellation-pending do not release the remainder or permit retries',()=>{
 const p=plan(),r=orderProgress(p,{filledBaseAtomic:'500000000000000000',status:'cancel-pending'});
 assert.equal(r.remainingBaseAtomic,'750000000000000000');assert.equal(r.reportedTerminal,false);assert.equal(r.remainingCanRest,true);assert.equal(r.automaticRetryAllowed,false);assert.equal(r.reservationMayBeReleased,false);
});
test('Cancellation report preserves already filled quantity and does not prove settlement',()=>{
 const r=orderProgress(plan(),{filledBaseAtomic:'500000000000000000',status:'cancelled'});assert.equal(r.reportedTerminal,true);assert.equal(r.filledBaseAtomic,'500000000000000000');assert.equal(r.settlementVerified,false);
});
for(const [amount,status]of [['1250000000000000001','filled'],['0','filled'],['1250000000000000000','open']])test('Invalid fill report is rejected '+amount+'/'+status,()=>assert.throws(()=>orderProgress(plan(),{filledBaseAtomic:amount,status})));
test('Independent Python Decimal and protobuf encoder agree for mixed token precisions',()=>{
 const vectors=[];for(const bd of [6,8,18,24])for(const qd of [6,8])for(const side of ['buy','sell']){
  const s=demoSnapshot('injective',now);s.market.base.decimals=bd;s.market.quote.decimals=qd;
  s.market.lotAtomic=(10n**BigInt(bd-2)).toString();s.market.priceTick={numerator:'1',denominator:'1000000000000000000000000000000'};s.market.minNotionalQuote={numerator:'1',denominator:'1'};
  const i={...input(),side};vectors.push({bd,qd,input:i,plan:prepareInjectiveLimitOrder(s,i,{now})});
 }
 const run=spawnSync('python3',[new URL('./injective-orders-reference.py',import.meta.url).pathname],{input:JSON.stringify(vectors),encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).passed,vectors.length);
});

// Application observations, not authenticated venue events or settlement proofs.
const observation=(p,extra={})=>({planSha256:p.planSha256,clientOrderId:p.clientOrderId,
 orderHash:'0x'+'ab'.repeat(32),revision:'1',filledBaseAtomic:'0',status:'open',...extra});
const reconcile=reconcileInjectiveOrderObservation;
const unsafeFlags=['observationAuthenticated','signingEnabled','broadcastEnabled','executable',
 'reservationMayBeReleased','settlementVerified','automaticRetryAllowed'];
const safe=s=>{for(const k of unsafeFlags)assert.equal(s[k],false,k);};
const flatDigest=o=>createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k=>[k,o[k]])))).digest('hex');
function rehashState(s){const {stateSha256,...body}=s;return {...body,stateSha256:flatDigest(body)};}
test('Observation reconciliation copies bounded data and remains non-executable',()=>{
 const p=plan(),o=observation(p),original=JSON.stringify({p,o}),r=reconcile(p,o);
 assert.equal(r.duplicate,false);assert.equal(r.state.schema,'realdex.injective-observed-progress.v1');
 assert.equal(r.state.remainingBaseAtomic,p.baseQuantityAtomic);assert.equal(r.state.reportedTerminal,false);safe(r.state);
 assert.equal(JSON.stringify({p,o}),original);o.filledBaseAtomic='1';assert.equal(r.state.filledBaseAtomic,'0');
});
test('Identical observations replay idempotently after JSON serialization',()=>{
 const p=plan(),o=observation(p),s=reconcile(p,o).state;
 const r=reconcile(JSON.parse(JSON.stringify(p)),JSON.parse(JSON.stringify(o)),JSON.parse(JSON.stringify(s)));
 assert.equal(r.duplicate,true);assert.deepEqual(r.state,s);assert.notEqual(r.state,s);safe(r.state);
});
test('Different observation key insertion order has the same local receipt digest',()=>{
 const p=plan(),o=observation(p),s=reconcile(p,o).state;
 const r=reconcile(p,Object.fromEntries(Object.entries(o).reverse()),s);assert.equal(r.duplicate,true);assert.deepEqual(r.state,s);
});
test('A distinct plan sharing the client order ID is not the same order plan',()=>{
 const p=plan(),q=prepareInjectiveLimitOrder(demoSnapshot('injective',now),{...input(),quantity:'1.26'},{now});
 assert.equal(p.clientOrderId,q.clientOrderId);assert.notEqual(p.planSha256,q.planSha256);
 assert.throws(()=>reconcile(q,observation(p)),/PLAN_MISMATCH/);
 assert.throws(()=>reconcile(q,observation(q),reconcile(p,observation(p)).state),/PLAN_MISMATCH/);
});
for(const [key,value]of [['baseQuantityAtomic','1'],['planSha256','f'.repeat(64)],['signingEnabled',true],['broadcastEnabled',true],['executable',true]])test('Altered plan cannot be reconciled '+key,()=>{
 const p=plan();assert.throws(()=>reconcile({...p,[key]:value},observation(p)),/PLAN|INTEGRITY/);
});
for(const extra of [{planSha256:'a'.repeat(64)},{clientOrderId:'rdx-'+'f'.repeat(32)}])test('Observation binding rejects '+Object.keys(extra)[0],()=>{
 const p=plan();assert.throws(()=>reconcile(p,observation(p,extra)),/PLAN_MISMATCH/);
});
for(const orderHash of ['0x'+'00'.repeat(32),'0x'+'AB'.repeat(32),'0x123','',null,123])test('Invalid order hash '+JSON.stringify(orderHash),()=>{
 const p=plan();assert.throws(()=>reconcile(p,observation(p,{orderHash})),/HASH/);
});
for(const revision of ['0','01','-1','1.0','1e0','18446744073709551616','9'.repeat(21),1,null])test('Invalid application revision '+JSON.stringify(revision),()=>{
 const p=plan();assert.throws(()=>reconcile(p,observation(p,{revision})));
});
test('Max uint64 local revision is accepted; later wraparound is rejected',()=>{
 const p=plan(),s=reconcile(p,observation(p,{revision:'18446744073709551615'})).state;
 assert.throws(()=>reconcile(p,observation(p,{revision:'1'}),s),/STALE/);safe(s);
});
test('Stale observations cannot roll state backward',()=>{
 const p=plan(),s=reconcile(p,observation(p,{revision:'2',filledBaseAtomic:'1'})).state;
 assert.throws(()=>reconcile(p,observation(p),s),/STALE/);
});
for(const patch of [{filledBaseAtomic:'1'},{status:'cancel-pending'}])test('Same revision conflicting content fails '+Object.keys(patch)[0],()=>{
 const p=plan(),s=reconcile(p,observation(p)).state;assert.throws(()=>reconcile(p,observation(p,patch),s),/REVISION_CONFLICT/);
});
test('A reported order hash cannot change even at a later revision',()=>{
 const p=plan(),s=reconcile(p,observation(p)).state;
 assert.throws(()=>reconcile(p,observation(p,{revision:'2',orderHash:'0x'+'cd'.repeat(32)}),s),/ORDER_HASH_CHANGED/);
});
test('Cumulative fills are exact, monotonic, and independent of arrival count',()=>{
 const p=plan(),s=reconcile(p,observation(p,{filledBaseAtomic:'9007199254740993'})).state;
 const r=reconcile(p,observation(p,{revision:'7',filledBaseAtomic:'9007199254740994'}),s);
 assert.equal(r.state.remainingBaseAtomic,'1240992800745259006');safe(r.state);
 assert.throws(()=>reconcile(p,observation(p,{revision:'8',filledBaseAtomic:'9007199254740993'}),r.state),/FILL_REGRESSION/);
});
test('Cancellation pending followed by a raced complete fill is retained without settlement approval',()=>{
 const p=plan(),s=reconcile(p,observation(p,{status:'cancel-pending',filledBaseAtomic:'10'})).state;
 const r=reconcile(p,observation(p,{revision:'2',filledBaseAtomic:p.baseQuantityAtomic,status:'filled'}),s);
 assert.equal(r.state.reportedTerminal,true);assert.equal(r.state.remainingBaseAtomic,'0');safe(r.state);
});
for(const terminal of ['filled','cancelled'])test('Terminal '+terminal+' may repeat at a later revision but cannot be reopened',()=>{
 const p=plan(),o=observation(p,{status:terminal,filledBaseAtomic:terminal==='filled'?p.baseQuantityAtomic:'10'}),s=reconcile(p,o).state;
 const r=reconcile(p,{...o,revision:'2'},s);assert.equal(r.duplicate,false);assert.equal(r.state.reportedTerminal,true);safe(r.state);
 assert.throws(()=>reconcile(p,{...o,status:'unknown',revision:'3'},r.state),/TERMINAL_OBSERVATION_CONFLICT/);
});
test('Later fills after terminal cancellation require manual reconciliation, not silent correction',()=>{
 const p=plan(),o=observation(p,{status:'cancelled',filledBaseAtomic:'10'}),s=reconcile(p,o).state;
 assert.throws(()=>reconcile(p,{...o,revision:'2',filledBaseAtomic:'11'},s),/TERMINAL_OBSERVATION_CONFLICT/);
});
test('Unknown full-quantity report is not silently promoted to a filled report',()=>{
 const p=plan(),s=reconcile(p,observation(p,{status:'unknown',filledBaseAtomic:p.baseQuantityAtomic})).state;
 assert.equal(s.reportedTerminal,false);assert.equal(s.remainingBaseAtomic,'0');safe(s);
});
for(const patch of [{filledBaseAtomic:'1250000000000000001'},{filledBaseAtomic:'01'},{filledBaseAtomic:1},{filledBaseAtomic:'-1'},{status:'filled'},{status:'done'},{status:'open',filledBaseAtomic:'1250000000000000000'}])test('Invalid progress rejected '+JSON.stringify(patch),()=>{
 const p=plan();assert.throws(()=>reconcile(p,observation(p,patch)));
});
for(const key of ['remainingBaseAtomic','reportedTerminal','remainingCanRest','observationSha256','stateSha256',...unsafeFlags])test('Modified previous state rejected even with recomputed local state hash '+key,()=>{
 const p=plan(),s=reconcile(p,observation(p)).state;
 s[key]=typeof s[key]==='boolean'?!s[key]:s[key]==='0'?'1':'0';
 const altered=key==='stateSha256'?s:rehashState(s);
 assert.throws(()=>reconcile(p,observation(p,{revision:'2'}),altered),/PREVIOUS_STATE_INVALID/);
});
for(const target of ['observation','previous'])test('Extra or missing fields in '+target+' are rejected',()=>{
 const p=plan(),o=observation(p),s=reconcile(p,o).state;
 const call=x=>target==='observation'?reconcile(p,x):reconcile(p,o,x);
 const x=target==='observation'?o:s;assert.throws(()=>call({...x,approved:true}),/FIELDS/);
 const missing={...x};delete missing.revision;assert.throws(()=>call(missing),/FIELDS/);
});
test('Accessors and toJSON are not executed by the reconciliation boundary',()=>{
 const p=plan();let reads=0;const o=observation(p);Object.defineProperty(o,'revision',{enumerable:true,get(){reads++;return '1';}});
 assert.throws(()=>reconcile(p,o),/JSON_DATA/);assert.equal(reads,0);
 const q={...p,toJSON(){reads++;return p;}};assert.throws(()=>reconcile(q,observation(p)),/JSON_DATA/);assert.equal(reads,0);
});
for(const [name,make]of [
 ['prototype',o=>Object.assign(Object.create({hidden:true}),o)],
 ['symbol',o=>Object.assign(o,{[Symbol('secret')]:true})],
 ['hidden',o=>Object.defineProperty(o,'hidden',{value:1})],
 ['cycle',o=>Object.assign(o,{self:o})],
 ['oversized string',o=>({...o,revision:'1'.repeat(9000)})],
 ['too many fields',o=>({...o,...Object.fromEntries(Array.from({length:513},(_,i)=>['x'+i,i]))})],
 ['long key',o=>({...o,['x'.repeat(129)]:0})],
 ['sparse array',o=>({...o,extra:Array(2)})]
])test('Noncanonical or unbounded observation rejected '+name,()=>{const p=plan();assert.throws(()=>reconcile(p,make(observation(p))));});
test('Returned receipts do not alias previous state or observation',()=>{
 const p=plan(),o=observation(p),s=reconcile(p,o).state,r=reconcile(p,o,s);r.state.revision='99';
 assert.equal(s.revision,'1');assert.equal(o.revision,'1');
});
test('512 cumulative observations and 64 duplicate replays match independent Python integer accounting',()=>{
 const p=plan(),total=BigInt(p.baseQuantityAtomic),rows=[];let previous=null;
 for(let i=1;i<=512;i++){
  const filled=total*BigInt(i)/512n,o=observation(p,{revision:String(i),filledBaseAtomic:String(filled),status:i===512?'filled':i%11===0?'cancel-pending':'open'});
  const r=reconcile(p,o,previous);assert.equal(r.duplicate,false);safe(r.state);previous=r.state;
  if(i%8===0){const duplicate=reconcile(p,JSON.parse(JSON.stringify(o)),JSON.parse(JSON.stringify(previous)));assert.equal(duplicate.duplicate,true);assert.deepEqual(duplicate.state,previous);}
  rows.push(previous);
 }
 const code='import json,sys\nx=json.load(sys.stdin)\ntotal=int(x["total"])\nfor i,r in enumerate(x["rows"],1):\n n=total*i//512\n assert int(r["filledBaseAtomic"])==n\n assert int(r["remainingBaseAtomic"])==total-n\n assert r["reportedTerminal"]==(i==512)\nprint(json.dumps({"checked":len(x["rows"])}))\n';
 const r=spawnSync('python3',['-c',code],{input:JSON.stringify({total:String(total),rows}),encoding:'utf8',timeout:10000,maxBuffer:1048576});
 assert.equal(r.error,undefined);assert.equal(r.signal,null);assert.equal(r.status,0,r.stderr);assert.equal(JSON.parse(r.stdout).checked,512);
});
