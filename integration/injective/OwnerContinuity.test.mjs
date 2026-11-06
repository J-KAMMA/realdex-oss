/** Real-node identity substitution through an unchanged loopback endpoint.
 * Two isolated nodes deliberately share chain ID/account keys, NOT chain history.
 * No public provider, live assets, UI capability export or production signer.
 */
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {PrivateStore} from '../../wallet/lib/storage.mjs';import {Vault} from '../../wallet/lib/vault.mjs';import {WalletServer} from '../../wallet/lib/server.mjs';
import {startInjective,waitFor,localTransaction,movement} from './fixture.mjs';
const SECRET='49'.repeat(32),PASSWORD='public INJ09 isolated continuity fixture password',FEE=500000000000000n;
const policy={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:String(FEE),gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};

test('INJ09 real nodes with identical chain ID cannot substitute stored owner history',async t=>{
 const chains=[];t.after(async()=>{for(const c of chains)await c.close();});
 const a=await startInjective({actorSecretHexes:[SECRET]});chains.push(a);
 const b=await startInjective({actorSecretHexes:[SECRET]});chains.push(b);
 let target=a,drop=false,app,vault,store,start;const sends=[],included=[],checks=[];
 // The proxy is test-only, forwards raw responses, and targets only these two local nodes.
 const proxy=http.createServer(async(req,res)=>{
  try{
   if(!req.url.startsWith('/cosmos/')&&!req.url.startsWith('/injective/')){res.writeHead(404);res.end();return;}
   const parts=[];let n=0;for await(const p of req){n+=p.length;if(n>524288)throw Error('OVERSIZED_TEST_REQUEST');parts.push(p);}
   const body=Buffer.concat(parts),chosen=target,write=req.method==='POST'&&req.url==='/cosmos/tx/v1beta1/txs';
   if(write)sends.push(chosen===a?'A':'B');
   const response=await fetch(chosen.rest+req.url,{method:req.method,headers:{accept:'application/json',...(body.length?{'content-type':'application/json'}:{}),...(req.headers['x-cosmos-block-height']?{'x-cosmos-block-height':req.headers['x-cosmos-block-height']}:{})},...(body.length?{body}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
   const payload=Buffer.from(await response.arrayBuffer());
   if(write&&drop){drop=false;res.destroy();return;}
   const headers={'content-type':response.headers.get('content-type')??'application/json'};
   for(const h of ['x-cosmos-block-height','grpc-metadata-x-cosmos-block-height'])if(response.headers.has(h))headers[h]=response.headers.get(h);
   res.writeHead(response.status,headers);res.end(payload);
  }catch{if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"ISOLATED_TEST_PROXY_FAILURE"}');}
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{proxy.close(r);proxy.closeAllConnections();}));
 const endpoint='http://127.0.0.1:'+proxy.address().port,home=fs.mkdtempSync(path.join(os.tmpdir(),'inj09-owner-'));
 t.after(async()=>{try{await app?.close();}finally{fs.rmSync(home,{recursive:true,force:true});}});
 store=new PrivateStore(home);vault=new Vault(store);await vault.create(PASSWORD);
 const account=await vault.addAccount({family:'evm',label:'Disposable continuity owner',secretHex:SECRET}),backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 async function open(){app=new WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]}});start=await app.start(0);}
 await open();
 const call=async(route,body={})=>{const r=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const owner=a.actors[0],sub=owner.subaccountId.slice(0,-1)+'1';
 const prepare=(key,amount='100000000000000000',kind='deposit',extra={})=>call('non-evm/injective/'+kind+'/prepare',{accountId:account.id,payment:{requestKey:key,endpoint,subaccountId:sub,denom:'ubase',amountAtomic:amount,policy,...extra}});
 const approve=async p=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;
 const submit=r=>call('non-evm/injective/submit',{id:r.id,confirmation:r.signed.requestId});
 const seq=async c=>(await c.get('/cosmos/auth/v1beta1/accounts/'+owner.address)).account.base_account;
 const bank=async(c,d)=>BigInt((await c.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom='+d)).balance.amount);
 const latest=async c=>BigInt((await c.get('/cosmos/base/tendermint/v1beta1/blocks/latest')).block.header.height);
 const waitAt=async(c,h)=>waitFor(async()=>await latest(c)>=BigInt(h));
 const check=(name,fn)=>t.test(name,async()=>{await fn();checks.push(name);});
 const baseBefore=await bank(a,'ubase'),gasBefore=await bank(a,'inj');let signed,retired;
 await check('Two real nodes share the same chain ID/account counters but have different histories',async()=>{
  assert.equal(a.chainId,b.chainId);assert.notEqual(a.genesisSha256,b.genesisSha256);
  const aa=await seq(a),ba=await seq(b);assert.equal(aa.address,ba.address);assert.equal(aa.account_number,ba.account_number);assert.equal(aa.sequence,ba.sequence);
  const ab=await a.get('/cosmos/base/tendermint/v1beta1/blocks/3'),bb=await b.get('/cosmos/base/tendermint/v1beta1/blocks/3');assert.notEqual(ab.block_id.hash,bb.block_id.hash);
 });
 await check('Approval of an A review at the same endpoint switched to B writes/signs nothing',async()=>{
  const p=await prepare('old-A-review'),disk=store.read();target=b;await waitAt(b,p.summary.review.anchor.height);
  await assert.rejects(approve(p),/CONTINUITY_ANCHOR_CHANGED/);assert.equal(store.read(),disk);assert.equal((await vault.injectiveRecords()).length,0);assert.equal(sends.length,0);
 });
 await check('Already signed A bytes cannot be initially broadcast on B',async()=>{
  target=a;signed=await approve(await prepare('signed-on-A'));const history=await vault.injectiveRecords(),disk=store.read();target=b;await waitAt(b,JSON.parse(signed.summary.reviewJson).anchor.height);
  await assert.rejects(submit(signed),/CONTINUITY_ANCHOR_CHANGED/);assert.equal(store.read(),disk);assert.deepEqual(await vault.injectiveRecords(),history);assert.equal(sends.length,0);
 });
 await check('Returning to A sends once; a lost response retains broadcast-unknown',async()=>{
  target=a;drop=true;assert.equal((await submit(signed)).state,'broadcast-unknown');assert.deepEqual(sends,['A']);
  const tx=await a.included(signed.signed.requestId);assert.equal(tx.code,0);included.push({phase:'A-owner-deposit',hash:tx.txhash,height:tx.height,code:tx.code});
  assert.equal(await bank(a,'ubase'),baseBefore-100000000000000000n);assert.equal(await bank(a,'inj'),gasBefore-FEE);
 });
 await check('B cannot turn A unknown state into a missing or final receipt',async()=>{
  target=b;const history=await vault.injectiveRecords(),disk=store.read();await assert.rejects(call('non-evm/injective/reconcile',{id:signed.id}),/CONTINUITY/);
  assert.equal(store.read(),disk);assert.deepEqual(await vault.injectiveRecords(),history);assert.deepEqual(sends,['A']);
 });
 await check('Encrypted restart preserves the chain pin; A reconciles without another send',async()=>{
  await app.close();app=null;store=new PrivateStore(home);vault=new Vault(store);await vault.unlock(PASSWORD);await open();
  await assert.rejects(call('non-evm/injective/reconcile',{id:signed.id}),/CONTINUITY/);
  await assert.rejects(submit(signed),/RESUBMISSION/);target=a;
  const r=await call('non-evm/injective/reconcile',{id:signed.id});assert.equal(r.state,'reported-confirmed');assert.equal(r.report.actionEffect.availableAtomic,'100000000000000000');assert.deepEqual(sends,['A']);
 });
 await check('Matching the next account sequence on B does not permit a fresh B review to replace A history',async()=>{
  // One B-only setup transaction aligns its account sequence with A. It is not a wallet send.
  const setup=await localTransaction(b,0,movement(b,0,'Deposit',sub,'1')),sent=await b.broadcast(b.sign(setup));assert.equal(sent.tx_response.code,0);
  const tx=await b.included(sent.tx_response.txhash);assert.equal(tx.code,0);included.push({phase:'B-diagnostic-sequence-alignment',hash:tx.txhash,height:tx.height,code:tx.code});
  assert.equal((await seq(a)).sequence,(await seq(b)).sequence);target=b;
  const p=await prepare('new-B-review'),disk=store.read(),history=await vault.injectiveRecords();
  await assert.rejects(approve(p),/CONTINUITY/);assert.equal(store.read(),disk);assert.deepEqual(await vault.injectiveRecords(),history);assert.deepEqual(sends,['A']);
 });
 await check('A new endpoint cannot silently remove the stored endpoint binding',async()=>{
  target=a;const p=await prepare('different-origin','1','deposit',{endpoint:a.rest}),disk=store.read();await assert.rejects(approve(p),/CONTINUITY_ENDPOINT/);assert.equal(store.read(),disk);assert.deepEqual(sends,['A']);
 });
 await check('B cannot retire an expired A transaction; actual A can retain and retire it',async()=>{
  target=a;retired=await approve(await prepare('A-expiring','1','deposit',{policy:{...policy,timeoutBlocks:5}}));
  await waitAt(a,BigInt(retired.summary.timeoutHeight)+1n);await waitAt(b,BigInt(retired.summary.timeoutHeight)+1n);target=b;const disk=store.read();
  await assert.rejects(call('non-evm/injective/recovery/prepare',{id:retired.id}),/CONTINUITY/);assert.equal(store.read(),disk);target=a;
  const p=await call('non-evm/injective/recovery/prepare',{id:retired.id}),r=await call('non-evm/injective/recovery/retire',{id:retired.id,review:p,confirmation:p.reviewSha256,transactionHash:retired.signed.requestId});
  assert.equal(r.state,'retired-unsent-expired');assert.deepEqual(r.signed,retired.signed);assert.deepEqual(sends,['A']);
 });
 await check('New approved A withdrawal succeeds; original bank balance and exactly two wallet fees agree',async()=>{
  const r=await approve(await prepare('A-final-withdraw','100000000000000000','withdraw'));await submit(r);
  const tx=await a.included(r.signed.requestId);assert.equal(tx.code,0);included.push({phase:'A-owner-withdraw',hash:tx.txhash,height:tx.height,code:tx.code});
  const final=await call('non-evm/injective/reconcile',{id:r.id});assert.equal(final.state,'reported-confirmed');assert.equal(final.report.actionEffect.availableAtomic,'0');
  assert.equal(await bank(a,'ubase'),baseBefore);assert.equal(await bank(a,'inj'),gasBefore-2n*FEE);assert.equal((await seq(a)).sequence,'2');assert.deepEqual(sends,['A','A']);
  await assert.rejects(submit(retired),/RESUBMISSION|REVIEW_EXPIRED/);
 });
 if(process.env.REALDEX_INJ09_EVIDENCE){
  const git=x=>execFileSync('git',['rev-parse',x],{encoding:'utf8'}).trim();
  fs.writeFileSync(process.env.REALDEX_INJ09_EVIDENCE,JSON.stringify({schema:'realdex.inj09-chain-continuity.v1',passed:true,commit:git('HEAD'),tree:git('HEAD^{tree}'),trackedClean:execFileSync('git',['diff','--name-only','HEAD'],{encoding:'utf8'}).trim()==='',createdAt:new Date().toISOString(),nodeVersion:process.versions.node,checks,subchecks:checks.length,transactions:included,walletSends:sends.length,replacementNodeWalletSends:sends.filter(x=>x==='B').length,genesisHashes:[a.genesisSha256,b.genesisSha256],chainId:a.chainId,identicalChainIds:true,independentChainProof:false,publicNetwork:false,productionReady:false},null,2)+'\n',{flag:'wx',mode:0o600});
 }
});
