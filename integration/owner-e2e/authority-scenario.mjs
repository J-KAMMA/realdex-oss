/** Three permission boundaries exercised against a real child server and real local chain. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {startInjective} from '../injective/fixture.mjs';import {PipeDriver} from './drivers.mjs';
import {need,uint,cleanupAll} from './protocol.mjs';import {SCHEMA,FALSE_FLAGS,ATTACKS,CROSS_ROUTES,snapshot,validateRejection,verifyAuthorityEvidence} from './authority-protocol.mjs';
import {ownerHttp,attackRequest,crossRouteRequest} from './authority-http.mjs';
const FEE='500000000000000',AMOUNT='1000000000000000000';
const policy={gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};
export async function runAuthorityScenario({commit,tree,onStep=()=>{}}){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-e2e07-vault-')),secret=randomBytes(32).toString('hex'),password='Disposable authority '+randomBytes(16).toString('hex');
 let chain,host,config,primary;const checks=[],rejections=[];
 const mark=async id=>{checks.push(id);await onStep({id});};
 const start=async create=>{host=new PipeDriver({command:process.execPath,args:[fileURLToPath(new URL('./authority-host.mjs',import.meta.url))],timeoutMs:60000});return host.send('start',{home,password,create,...(create?{secretHex:secret}:{})});};
 const stop=async()=>{if(host){try{await host.send('stop',{});}finally{await host.close();host=null;}}};
 const stats=()=>host.send('stats',{});
 const ok=r=>{need(r.status===200&&r.data&&!r.data.error,'E2E_AUTH_POSITIVE_CONTROL');return r.data;};
 const api=(route,body={})=>ownerHttp(config,{route:'/api/'+route,body});
 const reject=async(expected,opts)=>{
  const before=snapshot(await stats()),r=await ownerHttp(config,opts),after=snapshot(await stats());
  // Never retain response bodies, URLs, capability tokens or arbitrary exception strings.
  const row={id:expected.id,status:r.status,error:r.data?.error,before,after};
  try{need(r.data&&Object.keys(r.data).join(',')==='error'&&!r.text.includes(config.token)&&!r.text.includes(secret),'E2E_AUTH_ERROR_DISCLOSURE');if(opts.route.startsWith('/api/'))need(r.headers['access-control-allow-origin']===undefined,'E2E_AUTH_OWNER_CORS');validateRejection(row,expected);}catch(e){await onStep({id:expected.id,status:r.status,error:typeof r.data?.error==='string'&&/^[A-Z0-9_]{1,80}$/.test(r.data.error)?r.data.error:'REDACTED',failed:true});throw e;}
  rejections.push(row);await mark(expected.id);
 };
 try{
  chain=await startInjective({actorSecretHexes:[secret]});config=await start(true);const owner=chain.actors[0],sub=owner.subaccountId.slice(0,-1)+'1';
  const bank=async denom=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom='+denom)).balance.amount;
  const state=async()=>{const d=(await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom=ubase')).deposits;const amount=d?.available_balance??'0';need(/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(amount),'E2E_AUTH_FRACTIONAL');return {base:await bank('ubase'),gas:await bank('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+owner.address)).account.base_account.sequence,exchangeBase:amount.split('.')[0]};};
  const before=await state();const html=await ownerHttp(config,{route:'/wallet/',method:'GET',headers:{origin:null,authorization:null},rawBody:''});
  need(html.status===200&&!html.text.includes(config.token)&&!html.text.includes(secret)&&html.headers['access-control-allow-origin']===undefined,'E2E_AUTH_STATIC_LEAK');
  const headerKeys=['cache-control','x-content-type-options','referrer-policy','x-frame-options','cross-origin-opener-policy','content-security-policy'];const staticHeaders=Object.fromEntries(headerKeys.map(k=>[k,html.headers[k]]));await mark('static-headers-no-capability');
  const payment={accountId:config.accountId,payment:{requestKey:'e2e07-owner-deposit',endpoint:chain.rest,subaccountId:sub,denom:'ubase',amountAtomic:AMOUNT,policy}};
  for(const a of ATTACKS)await reject({...a,id:'prepare/'+a.id},attackRequest(a.id,config,'/api/non-evm/injective/deposit/prepare',payment));
  let a=await stats();const p=ok(await api('non-evm/injective/deposit/prepare',payment));let b=await stats();need(a.writes===b.writes&&a.sends===b.sends&&b.records.length===0,'E2E_AUTH_PREMATURE_SAVE');await mark('valid-prepare-no-signature');
  const approval={id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false};
  for(const a of ATTACKS)await reject({...a,id:'approve/'+a.id},attackRequest(a.id,config,'/api/non-evm/approve',approval));
  a=await stats();const record=ok(await api('non-evm/approve',approval)).record;b=await stats();need(record.state==='signed'&&b.records.length===1&&a.sends===b.sends&&a.writes<b.writes,'E2E_AUTH_SIGN_ONLY');await mark('valid-approve-no-send');
  const submission={id:record.id,confirmation:record.signed.requestId};
  for(const a of ATTACKS)await reject({...a,id:'submit/'+a.id},attackRequest(a.id,config,'/api/non-evm/injective/submit',submission));
  for(const a of CROSS_ROUTES)await reject({...a,id:'cross-route/'+a.id},crossRouteRequest(a.id,config,approval));
  need(JSON.stringify(await state())===JSON.stringify(before),'E2E_AUTH_REJECTED_CHAIN_MUTATION');
  need(ok(await api('non-evm/injective/submit',submission)).state==='broadcast','E2E_AUTH_BROADCAST');need((await stats()).sends===1,'E2E_AUTH_SEND_COUNT');await mark('valid-submit-once');
  const included=await chain.included(record.signed.requestId);need(included.code===0,'E2E_AUTH_INCLUDED');const confirmed=ok(await api('non-evm/injective/reconcile',{id:record.id}));need(confirmed.state==='reported-confirmed','E2E_AUTH_CONFIRMED');await mark('included-deposit-exact');
  const rateBefore=snapshot(await stats());let last,count=0;for(;count<601;){last=await api('status');count++;if(last.status===429)break;ok(last);}
  need(last.status===429&&last.data.error==='REQUEST_RATE_LIMIT','E2E_AUTH_RATE_NOT_REACHED');await mark('owner-rate-limit');
  const limited=await api('non-evm/injective/deposit/prepare',{...payment,payment:{...payment.payment,requestKey:'must-not-create'}});
  need(limited.status===429&&limited.data.error==='REQUEST_RATE_LIMIT','E2E_AUTH_RATE_MUTATION');const rateAfter=snapshot(await stats());need(JSON.stringify(rateBefore)===JSON.stringify(rateAfter),'E2E_AUTH_RATE_MUTATED');await mark('rate-limited-mutation-denied');
  const lock=await api('lock');need(lock.status===200&&lock.data.locked&&(await stats()).locked,'E2E_AUTH_EMERGENCY_BLOCKED');await mark('emergency-lock-at-limit');
  const old=config,preClose=await stats();await stop();need(!fs.existsSync(path.join(home,'writer.lock')),'E2E_AUTH_NORMAL_CLOSE_LOCK');config=await start(false);
  need(config.accountId===old.accountId&&config.pid!==old.pid&&config.token!==old.token,'E2E_AUTH_RESTART');await mark('same-store-restart');
  const staleBefore=snapshot(await stats()),denied=await ownerHttp(config,{headers:{authorization:'Bearer '+old.token}}),staleAfter=snapshot(await stats());need(denied.status===401&&denied.data.error==='UI_AUTH_REQUIRED'&&JSON.stringify(staleBefore)===JSON.stringify(staleAfter),'E2E_AUTH_OLD_TOKEN');await mark('old-capability-after-restart');
  const repeat=await api('non-evm/injective/submit',submission);need(repeat.status===400&&repeat.data.error==='INJECTIVE_RESUBMISSION_FORBIDDEN'&&(await stats()).sends===0,'E2E_AUTH_REPEAT_SENT');await mark('no-resend-on-repeat');
  const after=await state();need(uint(before.base)-uint(after.base)===BigInt(AMOUNT)&&uint(after.exchangeBase)-uint(before.exchangeBase)===BigInt(AMOUNT)&&uint(before.gas)-uint(after.gas)===BigInt(FEE)&&uint(after.sequence)-uint(before.sequence)===1n,'E2E_AUTH_BALANCES');await mark('exact-fee-and-sequence');
  const result={schema:SCHEMA,mode:'api-authority',status:'passed',commit,tree,checks,checkCount:checks.length,rejections,staticHeaders,sourceStable:true,transport:'direct-loopback-http',syntheticResponses:0,externalRequests:0,
   before,after,transaction:{hash:included.txhash,height:included.height,code:included.code,gasWanted:included.gas_wanted,gasUsed:included.gas_used,gasLimit:policy.gasLimit,feeAtomic:FEE},
   rate:{status:last.status,error:last.data.error,before:rateBefore,after:rateAfter,requests:count,mutationStatus:limited.status,mutationError:limited.data.error,lockStatus:lock.status,locked:true},
   ownerSends:preClose.sends,restartSends:(await stats()).sends,walletRestarts:1,oldCapabilityStatus:denied.status,oldCapabilityError:denied.data.error,repeatStatus:repeat.status,repeatError:repeat.data.error,chainVersion:chain.version,genesisSha256:chain.genesisSha256,...Object.fromEntries(FALSE_FLAGS.map(k=>[k,false]))};
  return result; // Runtime/source stability is checked by the CLI before evidence is accepted.
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[stop,()=>chain?.close(),()=>fs.rmSync(home,{recursive:true,force:true})]);}
}
