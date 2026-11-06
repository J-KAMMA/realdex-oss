import test from 'node:test';import assert from 'node:assert/strict';
import {SCHEMA,PHASES,CHECKS,verifyEvidence,loopbackOrigin,netQuote,safeCode,cleanupAll} from '../protocol.mjs';
import {parseArgs} from '../run.mjs';
function report(){return {schema:SCHEMA,mode:'api',commit:'a'.repeat(40),tree:'b'.repeat(40),status:'passed',checks:[...CHECKS],
 transactions:PHASES.map((phase,i)=>({phase,hash:String(i+1).repeat(64),height:String(i+10),code:0,gasLimit:'1000000',gasWanted:'1000000',gasUsed:'200000',feeAtomic:'500000000000000'})),
 before:{base:'2000000000000000000',quote:'1000',gas:'9007199254740993000',sequence:'9007199254740993'},
 after:{base:'1500000000000000000',quote:'5501550',gas:'9004699254740993000',sequence:'9007199254740998',exchangeBase:'0',exchangeQuote:'0',openOrders:0},
 quoteProceedsAtomic:'5500330',quoteBankCreditAtomic:'220',quoteNotionalAtomic:'5500000',makerFeeRate:'-0.000100000000000000',ownerSends:5,counterpartySends:1,droppedResponses:1,walletRestarts:1,records:5,
 driver:{transport:'direct-http',externalRequests:0,syntheticResponses:0},browserEndToEndPassed:false,publicNetwork:false,productionReady:false,stateProofVerified:false};}
const evaluate=r=>verifyEvidence(r,{expectedMode:'api',expectedCommit:'a'.repeat(40),expectedTree:'b'.repeat(40)});
test('Exact API accounting validates without being classified as browser success',()=>assert.equal(evaluate(report()),true));
for(const [name,mutate] of Object.entries({
 mode:r=>r.mode='browser',head:r=>r.commit='c'.repeat(40),tree:r=>r.tree='c'.repeat(40),schema:r=>r.schema='unknown',
 'missing check':r=>r.checks.pop(),'duplicate check':r=>r.checks[1]=r.checks[0],'out of order':r=>r.checks.reverse(),
 'extra transaction':r=>r.transactions.push(r.transactions[0]),'missing transaction':r=>r.transactions.pop(),'duplicate hash':r=>r.transactions[1].hash=r.transactions[0].hash,
 'wrong phase':r=>r.transactions[0].phase='withdraw-quote','failed chain tx':r=>r.transactions[0].code=1,'zero height':r=>r.transactions[0].height='0',
 'unsafe sequence number':r=>r.after.sequence=Number(r.after.sequence),'wrong sequence':r=>r.after.sequence='9007199254740999',
 'wrong gas balance':r=>r.after.gas='1','wrong base balance':r=>r.after.base='1','omitted rebate':r=>r.quoteBankCreditAtomic='0','wrong quoted proceeds':r=>r.after.quote='5501330',
 'open order':r=>r.after.openOrders=1,'unwithdrawn base':r=>r.after.exchangeBase='1','unwithdrawn quote':r=>r.after.exchangeQuote='1',
 'repeated owner send':r=>r.ownerSends=6,'unrestarted wallet':r=>r.walletRestarts=0,'wrong counterparty count':r=>r.counterpartySends=2,
 'wrong included gas cap':r=>r.transactions[0].gasWanted='150000000',
 'gas over cap':r=>r.transactions[0].gasUsed='1000001','negative gas':r=>r.transactions[0].gasUsed='-1',
 'fake browser flag':r=>r.browserEndToEndPassed=true,'fake production':r=>r.productionReady=true,'fake proof':r=>r.stateProofVerified=true,'public network':r=>r.publicNetwork=true,
 'synthetic responses':r=>r.driver.syntheticResponses=1,'external traffic':r=>r.driver.externalRequests=1,'browser driver substitution':r=>r.driver.transport='chromium-dom-http',
 'missing records':r=>r.records=4,'wrong status':r=>r.status='blocked'
}))test('Reject misleading/incomplete evidence: '+name,()=>{const r=report();mutate(r);assert.throws(()=>evaluate(r));});
test('Explicit browser mode requires its own driver and positive browser flag',()=>{const r=report();r.mode='browser';r.driver.transport='chromium-dom-http';r.browserEndToEndPassed=true;assert.equal(verifyEvidence(r,{expectedMode:'browser',expectedCommit:r.commit,expectedTree:r.tree}),true);assert.throws(()=>evaluate(r));});
for(const s of ['https://127.0.0.1:3','http://localhost:3','http://127.0.0.1','http://127.0.0.1:3/','http://127.0.0.1:3/a','http://127.0.0.1:3?x','http://u@127.0.0.1:3','http://127.0.0.1.evil:3'])test('Reject nonexact local origin '+s,()=>assert.throws(()=>loopbackOrigin(s)));
test('Exact IPv4 loopback origin is allowed',()=>assert.equal(loopbackOrigin('http://127.0.0.1:1234'),'http://127.0.0.1:1234'));
test('Positive, zero and negative maker fees use exact arithmetic',()=>{assert.equal(netQuote('5500000','0.001'),5494500n);assert.equal(netQuote('5500000','0'),5500000n);assert.equal(netQuote('5500000','-0.0001'),5500550n);});
for(const rate of ['nan','1e-4','-0.000000000000000001','01','2'])test('Unsupported fee precision/range '+rate,()=>assert.throws(()=>netQuote('5500000',rate)));
test('Error sanitization never emits URLs/tokens/raw messages',()=>assert.equal(safeCode(Error('https://host/?token=secret')),'E2E_EXECUTION_FAILED'));
test('Cleanup retains primary and every secondary failure',async()=>{const a=Error('primary'),b=Error('cleanup'),called=[];await assert.rejects(cleanupAll(a,[()=>{called.push(1);throw b;},()=>called.push(2)]),e=>e instanceof AggregateError&&e.errors[0]===a&&e.errors[1]===b);assert.deepEqual(called,[1,2]);});
test('Successful cleanup does not replace the original caller exception',async()=>{await cleanupAll(Error('existing'),[()=>{}]);});
for(const a of [[],['--mode','browser'],['--mode','api','--mode','api'],['--mode','api','--public','yes'],['--mode']])test('CLI missing/duplicate/unknown flags rejected '+a.join(' '),()=>assert.throws(()=>parseArgs(a)));
