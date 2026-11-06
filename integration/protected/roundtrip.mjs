/** Fixed five-operation owner lifecycle. API and DOM drivers are explicitly different evidence. */
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {randomBytes} from 'node:crypto';import {fileURLToPath} from 'node:url';
import {startInjective,orderRequest} from '../injective/fixture.mjs';
import {preflightInjectiveLimitOrder} from '../../node/external/injective-preflight.mjs';
import {PipeDriver} from '../owner-e2e/drivers.mjs';import {need,uint,netQuote,SCHEMA,verifyEvidence,cleanupAll} from '../owner-e2e/protocol.mjs';
const FEE='500000000000000',BASE='2000000000000000000',REMAINDER='1500000000000000000';
const policy=Object.freeze({gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:FEE,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000});
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<100;i++){const v=await fn();if(v)return v;await pause(100);}throw Error('E2E_STATE_TIMEOUT');}
function exactAtomic(s){need(typeof s==='string'&&/^(0|[1-9][0-9]*)(?:\.0+)?$/.test(s),'E2E_FRACTIONAL_DUST');return s.split('.')[0];}
export async function runProtectedRoundtrip({driver,mode,commit,tree,onStep=()=>{}}){
 need(['api','browser'].includes(mode),'E2E_MODE');need(driver?.transport===(mode==='api'?'direct-http':'chromium-dom-http'),'E2E_MODE_DRIVER_MISMATCH');const password='Disposable UP01 '+randomBytes(16).toString('hex'),secret=randomBytes(32).toString('hex');
 let chain,host,closedStats=null,config,primary;const home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-vault-')),witness=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-up01-witness-')),checks=[],transactions=[];
 const mark=async id=>{checks.push(id);await onStep(id);};
 const startHost=async create=>{
  host=new PipeDriver({command:'python3',args:['-I','-S',fileURLToPath(new URL('./test-launch.py',import.meta.url)),home,witness,create?'yes':'no','host'],timeoutMs:60000});
  return host.send('start',{home,checkpoint:witness,chainOrigin:chain.rest,password,create,...(create?{secretHex:secret}:{})});
 };
 const stopHost=async()=>{if(host){try{await host.send('stop',{});}finally{await host.close();host=null;}}};
 const ok=x=>{need(x&&x.status===200&&x.data&&!x.data.error,'E2E_OWNER_API_REJECTED');return x.data;};
 try{
  chain=await startInjective({actorSecretHexes:[secret]});config=await startHost(true);await driver.open(config);
  const owner=chain.actors[0],sub=owner.subaccountId.slice(0,-1)+'1';
  const bank=async d=>(await chain.get('/cosmos/bank/v1beta1/spendable_balances/'+owner.address+'/by_denom?denom='+d)).balance.amount;
  const exchange=async d=>{const r=await chain.get('/injective/exchange/v1beta1/exchange/subaccountDeposit?subaccount_id='+sub+'&denom='+d);return r.deposits?exactAtomic(r.deposits.available_balance):'0';};
  const orders=async()=>(await chain.get('/injective/exchange/v2/spot/orders/'+chain.market.market_id+'/'+sub)).orders??[];
  const state=async()=>({base:await bank('ubase'),quote:await bank('uquote'),gas:await bank('inj'),sequence:(await chain.get('/cosmos/auth/v1beta1/accounts/'+owner.address)).account.base_account.sequence,exchangeBase:await exchange('ubase'),exchangeQuote:await exchange('uquote'),openOrders:(await orders()).length});
  const before=await state();const firstProtection=(await host.send('stats',{})).protection;need(firstProtection.scheme==='realdex.vault-checkpoint-lease.v1','E2E_CP_SCHEME');need(before.exchangeBase==='0'&&before.exchangeQuote==='0'&&before.openOrders===0,'E2E_INITIAL_STATE');await mark('fresh-wallet');
  const request=(key,amount,denom='ubase')=>({accountId:config.accountId,payment:{requestKey:key,endpoint:chain.rest,subaccountId:sub,denom,amountAtomic:amount,policy}});
  const signed=async(kind,body,expectedAmount)=>{
   const s=await state(),stats=await host.send('stats',{});const p=ok(await driver.request('prepare',{kind,body}));
   need(p.summary.amountAtomic===expectedAmount&&p.summary.feeAtomic===FEE&&/^[a-f0-9]{64}$/.test(p.summary.reviewSha256),'E2E_REVIEW_BINDING');
   if(kind==='deposit')need(p.summary.destination===sub,'E2E_DESTINATION');
   if(kind==='withdraw')need(p.summary.destination===owner.address,'E2E_DESTINATION');
   const a=ok(await driver.request('approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,visible:[p.summary.reviewSha256,expectedAmount,FEE]})).record;
   need(a.state==='signed'&&a.summary.reviewSha256===p.summary.reviewSha256&&a.summary.feeAtomic===FEE,'E2E_SIGNED_BINDING');
   need((await state()).sequence===s.sequence&&(await host.send('stats',{})).ownerSends===stats.ownerSends,'E2E_PREMATURE_SEND');return a;
  };
  const dr=r=>({id:r.id,requestKey:r.requestKey,confirmation:r.signed.requestId});
  const included=async(r,phase,{lost=false}={})=>{
   const receipt=await chain.included(r.signed.requestId);need(receipt.code===0&&receipt.txhash===r.signed.requestId,'E2E_CHAIN_REJECTION');need(receipt.gas_wanted===JSON.parse(r.summary.reviewJson).transaction.fee.gasLimit,'E2E_INCLUDED_GAS_CAP');
   transactions.push({phase,hash:receipt.txhash,height:receipt.height,code:receipt.code,gasLimit:JSON.parse(r.summary.reviewJson).transaction.fee.gasLimit,gasUsed:receipt.gas_used,gasWanted:receipt.gas_wanted,feeAtomic:r.summary.feeAtomic});
   if(lost)return r;const v=ok(await driver.request('reconcile',dr(r)));need(v.state==='reported-confirmed'&&v.signed.requestId===r.signed.requestId,'E2E_RECEIPT_BINDING');return v;
  };
  const send=async(r,phase)=>{need(ok(await driver.request('submit',dr(r))).state==='broadcast','E2E_SUBMISSION');return included(r,phase);};
  let r=await signed('deposit',request('e2e01-deposit',BASE),BASE);await mark('deposit-reviewed');await send(r,'deposit-base');need(await exchange('ubase')===BASE,'E2E_DEPOSIT_STATE');await mark('deposit-included');
  const review=await preflightInjectiveLimitOrder(await orderRequest(chain,0,{side:'sell',quantity:'2',limitPrice:'11',requestKey:'e2e01-order',subaccountId:sub}));
  r=await signed('order',{accountId:config.accountId,review},BASE);await mark('order-reviewed');const source=await send(r,'sell-base');need((await orders()).length===1,'E2E_ORDER_STATE');await mark('order-included');
  const opposite=await preflightInjectiveLimitOrder(await orderRequest(chain,1,{side:'buy',quantity:'0.5',limitPrice:'11',requestKey:'e2e01-counterparty'}));
  const sent=await chain.broadcast(chain.sign(opposite.transaction,1));need(sent.tx_response.code===0,'E2E_COUNTERPARTY_CHECKTX');need((await chain.included(sent.tx_response.txhash)).code===0,'E2E_COUNTERPARTY_INCLUDED');
  const order=await until(async()=>{const a=await orders();return a.length===1&&a[0].fillable==='1.500000000000000000'?a[0]:null;});
  const quoteProceedsAtomic=await exchange('uquote'),quoteBankCreditAtomic=String(uint(await bank('uquote'))-uint(before.quote)),quoteNotionalAtomic='5500000',makerFeeRate=chain.market.maker_fee_rate;
  need(uint(quoteProceedsAtomic)+uint(quoteBankCreditAtomic)===netQuote(quoteNotionalAtomic,makerFeeRate),'E2E_PARTIAL_FILL_ACCOUNTING');need(uint(quoteProceedsAtomic)>0n,'E2E_QUOTE_PROCEEDS');await mark('counterparty-partial-fill');
  r=await signed('cancel',{accountId:config.accountId,sourceRecordId:source.id,payment:{requestKey:'e2e01-cancel',orderHash:order.order_hash,policy}},REMAINDER);await mark('cancel-reviewed');await send(r,'cancel-remainder');need((await orders()).length===0&&await exchange('ubase')===REMAINDER,'E2E_CANCEL_STATE');await mark('cancel-included');
  r=await signed('withdraw',request('e2e01-base-withdraw',REMAINDER),REMAINDER);await mark('base-withdraw-reviewed');await send(r,'withdraw-base');need(await exchange('ubase')==='0','E2E_BASE_WITHDRAW');await mark('base-withdraw-included');
  r=await signed('withdraw',request('e2e01-quote-withdraw',quoteProceedsAtomic,'uquote'),quoteProceedsAtomic);await mark('quote-withdraw-reviewed');
  const bad=await driver.request('submit',{...dr(r),confirmation:'wrong'});need(bad.status===400&&bad.data?.error==='INJECTIVE_TXID_CONFIRMATION_REQUIRED','E2E_WRONG_HASH');need((await host.send('stats',{})).ownerSends===4,'E2E_WRONG_HASH_SENT');await mark('wrong-hash-rejected');
  await host.send('drop-next',{});need(ok(await driver.request('submit',dr(r))).state==='broadcast-unknown','E2E_LOSS_NOT_UNKNOWN');await included(r,'withdraw-quote',{lost:true});
  closedStats=await host.send('stats',{});need(closedStats.ownerSends===5&&closedStats.droppedResponses===1&&closedStats.perHash.every(n=>n===1),'E2E_LOSS_SEND_COUNTS');await mark('response-loss-no-resend');
  const old=config;await stopHost();config=await startHost(false);need(config.pid!==old.pid&&config.token!==old.token&&config.accountId===old.accountId,'E2E_RESTART_IDENTITY');await driver.open(config);await mark('wallet-restart');
  const denied=await fetch(config.origin+'/api/status',{method:'POST',headers:{origin:config.origin,authorization:'Bearer '+old.token,'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(5000)});need(denied.status===401,'E2E_OLD_SESSION');await mark('old-session-rejected');
  const final=ok(await driver.request('reconcile',dr(r)));need(final.state==='reported-confirmed'&&final.signed.requestId===r.signed.requestId,'E2E_RECOVERY_RECEIPT');need((await host.send('stats',{})).ownerSends===0,'E2E_RECOVERY_RESEND');await mark('stored-hash-reconciled');
  const after=await state();need(after.exchangeBase==='0'&&after.exchangeQuote==='0'&&after.openOrders===0,'E2E_EXCHANGE_ACCOUNTING');await mark('both-exchange-balances-zero');
  need(uint(before.base)-uint(after.base)===500000000000000000n&&uint(after.quote)-uint(before.quote)===netQuote(quoteNotionalAtomic,makerFeeRate),'E2E_BANK_ACCOUNTING');await mark('bank-quantity-accounting');
  need(uint(before.gas)-uint(after.gas)===5n*BigInt(FEE)&&uint(after.sequence)-uint(before.sequence)===5n,'E2E_FEE_ACCOUNTING');await mark('exact-fees-and-sequences');
  const last=await host.send('stats',{});need(last.records.length===5&&last.records.every(r=>r.state==='reported-confirmed')&&new Set(closedStats.hashes).size===5,'E2E_UNIQUE_SEND');await mark('unique-owner-sends');
  const result={schema:SCHEMA,mode,commit,tree,status:'passed',checks,transactions,before,after,quoteProceedsAtomic,quoteBankCreditAtomic,quoteNotionalAtomic,makerFeeRate,ownerSends:5,counterpartySends:1,droppedResponses:1,walletRestarts:1,records:5,
   driver:{transport:driver.transport,externalRequests:driver.externalRequests,syntheticResponses:driver.syntheticResponses},browserEndToEndPassed:mode==='browser',publicNetwork:false,productionReady:false,stateProofVerified:false,
   chainVersion:chain.version,genesisSha256:chain.genesisSha256,scope:'disposable-local-node; API mode is not browser evidence'};
  verifyEvidence(result,{expectedCommit:commit,expectedTree:tree,expectedMode:mode});
  const finalProtection=last.protection;need(finalProtection.pairId===firstProtection.pairId&&BigInt(finalProtection.generation)>BigInt(firstProtection.generation),'E2E_CP_GENERATION');
  return {...result,protectedStorage:{scheme:firstProtection.scheme,pairId:firstProtection.pairId,beforeGeneration:firstProtection.generation,afterGeneration:finalProtection.generation,samePairAfterRestart:true,independentAuthority:false},scope:'UP01 protected disposable-local-node; API is not browser evidence'};
 }catch(e){primary=e;throw e;}finally{await cleanupAll(primary,[()=>driver.close(),stopHost,()=>chain?.close(),()=>fs.rmSync(home,{recursive:true,force:true}),()=>fs.rmSync(witness,{recursive:true,force:true})]);}
}
