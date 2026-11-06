import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {runIbcLab} from '../../integration/ibc/interactive.mjs';

test('IBC lab shutdown during pending startup disposes acquired resources without printing owner capability',async()=>{
 const signals=new EventEmitter(),input=new PassThrough(),lines=[];let resolveFixture,closed=0,done=false;
 const run=runIbcLab({signals,input,output:{log:x=>lines.push(x),error:x=>lines.push(x)},createFixture:()=>new Promise(r=>{resolveFixture=r;})}).then(()=>{done=true;});
 signals.emit('SIGTERM');signals.emit('SIGINT');
 await Promise.resolve();assert.equal(done,false);
 resolveFixture({close:async()=>{closed++;}});await run;
 assert.equal(closed,1);assert.equal(lines.length,0);assert.equal(signals.listenerCount('SIGTERM'),0);assert.equal(signals.listenerCount('SIGINT'),0);input.destroy();
});
test('IBC lab idle stop closes once and detaches signal handlers',async()=>{
 const signals=new EventEmitter(),input=new PassThrough();let closed=0;const lines=[];
 const run=runIbcLab({signals,input,output:{log:x=>lines.push(x),error:x=>lines.push(x)},createFixture:async()=>({started:{origin:'http://127.0.0.1:1'},app:{uiToken:'synthetic-only'},accounts:[{address:'one'},{address:'two'}],close:async()=>{closed++;}})});
 await new Promise(r=>setImmediate(r));assert.equal(lines.length,4);signals.emit('SIGTERM');signals.emit('SIGINT');await run;
 assert.equal(closed,1);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);input.destroy();
});
test('IBC lab startup failure detaches shutdown handlers and does not print capability',async()=>{
 const signals=new EventEmitter(),input=new PassThrough(),lines=[];
 await assert.rejects(runIbcLab({signals,input,output:{log:x=>lines.push(x)},createFixture:async()=>{throw Error('fixture setup failure');}}),/fixture setup failure/);
 assert.equal(lines.length,0);assert.equal(signals.listenerCount('SIGINT'),0);assert.equal(signals.listenerCount('SIGTERM'),0);input.destroy();
});
