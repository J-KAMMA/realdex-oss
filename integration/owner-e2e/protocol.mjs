/** Strict evidence for the fixed local round trip; counts never certify other modes/trees. */
import {createHash} from 'node:crypto';
export const SCHEMA='realdex.owner-stack-e2e.v1';
export const PHASES=Object.freeze(['deposit-base','sell-base','cancel-remainder','withdraw-base','withdraw-quote']);
export const CHECKS=Object.freeze(['fresh-wallet','deposit-reviewed','deposit-included','order-reviewed','order-included',
 'counterparty-partial-fill','cancel-reviewed','cancel-included','base-withdraw-reviewed','base-withdraw-included',
 'quote-withdraw-reviewed','wrong-hash-rejected','response-loss-no-resend','wallet-restart','old-session-rejected',
 'stored-hash-reconciled','both-exchange-balances-zero','bank-quantity-accounting','exact-fees-and-sequences','unique-owner-sends']);
export const need=(v,code)=>{if(!v)throw Error(code);};
export const sha=b=>createHash('sha256').update(b).digest('hex');
export const uint=s=>{need(typeof s==='string'&&/^(0|[1-9][0-9]{0,77})$/.test(s),'E2E_INTEGER');return BigInt(s);};
export function loopbackOrigin(s){
 need(typeof s==='string','E2E_LOCAL_ORIGIN');let u;try{u=new URL(s);}catch{throw Error('E2E_LOCAL_ORIGIN');}
 need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port!==''&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password&&s===u.origin,'E2E_LOCAL_ORIGIN');return u.origin;
}
export function safeCode(error){return error instanceof Error&&/^E2E_[A-Z0-9_]{1,64}$/.test(error.message)?error.message:'E2E_EXECUTION_FAILED';}
export function netQuote(notional,rate){
 need(typeof rate==='string'&&/^-?(0|[1-9][0-9]{0,3})(\.[0-9]{1,18})?$/.test(rate),'E2E_FEE_RATE');
 const [whole,fraction='']=rate.replace('-','').split('.'),den=10n**BigInt(fraction.length),num=(BigInt(whole)*den+BigInt(fraction||'0'))*(rate.startsWith('-')?-1n:1n);
 const n=uint(notional),fee=n*num;need(fee%den===0n,'E2E_NONINTEGRAL_FEE');const net=n-fee/den;need(net>0n,'E2E_FEE_RATE');return net;
}
export function verifyEvidence(v,{expectedCommit,expectedTree,expectedMode}={}){
 need(v?.schema===SCHEMA&&['api','browser'].includes(v.mode)&&v.mode===expectedMode,'E2E_MODE');
 need(v.commit===expectedCommit&&v.tree===expectedTree&&/^[a-f0-9]{40}$/.test(v.commit)&&/^[a-f0-9]{40}$/.test(v.tree),'E2E_IDENTITY');
 need(v.publicNetwork===false&&v.productionReady===false&&v.stateProofVerified===false,'E2E_APPROVAL');
 need(Array.isArray(v.checks)&&v.checks.length===CHECKS.length&&CHECKS.every((x,i)=>v.checks[i]===x),'E2E_CHECK_SET');
 need(v.driver?.transport===(v.mode==='browser'?'chromium-dom-http':'direct-http')&&v.driver.externalRequests===0&&v.driver.syntheticResponses===0,'E2E_DRIVER');
 need(v.mode==='api'?v.browserEndToEndPassed===false:v.browserEndToEndPassed===true,'E2E_BROWSER_FLAG');
 need(Array.isArray(v.transactions)&&v.transactions.length===5,'E2E_TX_SET');
 const hashes=new Set();let fees=0n;
 for(let i=0;i<5;i++){
  const t=v.transactions[i];need(t.phase===PHASES[i]&&/^[A-F0-9]{64}$/.test(t.hash)&&!hashes.has(t.hash)&&t.code===0,'E2E_TX_IDENTITY');hashes.add(t.hash);
  need(t.gasWanted===t.gasLimit&&uint(t.height)>0n&&uint(t.gasUsed)>0n&&uint(t.gasUsed)<=uint(t.gasLimit),'E2E_TX_GAS');
  fees+=uint(t.feeAtomic);
 }
 need(v.ownerSends===5&&v.counterpartySends===1&&v.droppedResponses===1&&v.walletRestarts===1,'E2E_SEND_COUNTS');
 need(uint(v.after.sequence)===uint(v.before.sequence)+5n,'E2E_SEQUENCE_ACCOUNTING');
 need(uint(v.before.gas)-uint(v.after.gas)===fees,'E2E_FEE_ACCOUNTING');
 need(uint(v.before.base)-uint(v.after.base)===500000000000000000n,'E2E_BASE_ACCOUNTING');
 need(v.quoteNotionalAtomic==='5500000'&&uint(v.quoteProceedsAtomic)>0n,'E2E_QUOTE_AMOUNT');
 const net=netQuote(v.quoteNotionalAtomic,v.makerFeeRate);
 need(uint(v.after.quote)-uint(v.before.quote)===net&&uint(v.quoteProceedsAtomic)+uint(v.quoteBankCreditAtomic)===net,'E2E_QUOTE_ACCOUNTING');
 need(v.after.exchangeBase==='0'&&v.after.exchangeQuote==='0'&&v.after.openOrders===0,'E2E_EXCHANGE_ACCOUNTING');
 need(v.records===5&&v.status==='passed','E2E_STATUS');return true;
}

/** Run every cleanup; never mask an earlier test failure with a cleanup exception. */
export async function cleanupAll(primary,cleanups){
 const errors=[];for(const cleanup of cleanups){try{await cleanup();}catch(e){errors.push(e);}}
 if(errors.length)throw new AggregateError(primary?[primary,...errors]:errors,primary?'E2E_PRIMARY_AND_CLEANUP':'E2E_CLEANUP_FAILED');
}
