import {checkInjectiveContinuity} from './continuity.mjs';
import {injectiveResolved,checkRetirementAnchor} from './retirement.mjs';
/** Owner-only Injective local lifecycle. Signed bytes are persisted before any send. */
import {createHash} from 'node:crypto';
import {parseExactJson} from '../../node/extended/json.mjs';
import {readBytes} from '../../node/extended/http.mjs';
import {need,clone,safeError,canonical} from '../lib/guard.mjs';
import {makeInjectiveIntent,verifyInjectiveIntent,signInjectiveIntent,verifyInjectiveSigned,validateInjectiveReview,injectiveReviewFromSummary,INJECTIVE_OPERATION,injectiveOperation,INJECTIVE_ASSURANCE} from './codec.mjs';
import {ACTION_SCHEMA} from './action-codec.mjs';
import {cancelAction,recheckOwnerAction,readActionEffect} from './actions.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex').toUpperCase();
const U64=(1n<<64n)-1n;const MAX_SAFE=BigInt(Number.MAX_SAFE_INTEGER);
function u64(v){need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v),'INJECTIVE_RPC_INTEGER');const n=BigInt(v);need(n<=U64,'INJECTIVE_RPC_INTEGER');return n;}
function endpoint(s){let u;try{u=new URL(s);}catch{throw Error('INJECTIVE_ENDPOINT_INVALID');}need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.search&&!u.hash&&!u.username&&!u.password,'INJECTIVE_LOOPBACK_ONLY');return u.origin;}
function heightHeader(headers){const a=headers.get('x-cosmos-block-height'),b=headers.get('grpc-metadata-x-cosmos-block-height');need(a||b,'INJECTIVE_QUERY_HEIGHT_MISSING');if(a&&b)need(a===b,'INJECTIVE_QUERY_HEIGHT_CONFLICT');return a??b;}
function blockHeader(raw){const a=raw.block?.header,b=raw.sdk_block?.header;need(a||b,'INJECTIVE_BLOCK_RESPONSE');if(a&&b)need(a.chain_id===b.chain_id&&a.height===b.height,'INJECTIVE_BLOCK_RESPONSE');return a??b;}
const reviewOf=summary=>injectiveReviewFromSummary(summary);
function numericCode(value){const n=u64(value);need(n<=MAX_SAFE,'INJECTIVE_RPC_CODE');return Number(n);}
function accountBase(raw){need(raw.account?.['@type']==='/injective.types.v1beta1.EthAccount','INJECTIVE_ACCOUNT_TYPE');const a=raw.account.base_account;need(a&&typeof a==='object','INJECTIVE_ACCOUNT_RESPONSE');return a;}
async function boundedFetch(fetchImpl,url,options){
 const signal=options.signal;signal.throwIfAborted();let handler;
 const aborted=new Promise((_,reject)=>{handler=()=>reject(Error('INJECTIVE_RPC_TRANSPORT_UNCERTAIN'));signal.addEventListener('abort',handler,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return fetchImpl(url,options);}),aborted]);}
 finally{signal.removeEventListener('abort',handler);}
}
export class InjectiveOwnerEngine {
  constructor({fetchImpl=globalThis.fetch,now=Date.now,timeoutMs=10000}={}){need(typeof fetchImpl==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>=100&&timeoutMs<=30000,'INJECTIVE_ENGINE_OPTIONS');this.fetchImpl=fetchImpl;this.now=now;this.timeoutMs=timeoutMs;this.active=new Set();}
  async request(review,path,{height,body,strictNotFound=false}={}){
    const base=endpoint(review.endpoint),url=new URL(path,base);need(url.origin===base,'INJECTIVE_ENDPOINT_CHANGED');let r;const signal=AbortSignal.timeout(this.timeoutMs);
    need(body===undefined||['/cosmos/tx/v1beta1/simulate','/cosmos/tx/v1beta1/txs'].includes(path),'INJECTIVE_RPC_WRITE_PATH');
    try{r=await boundedFetch(this.fetchImpl,url.href,{method:body===undefined?'GET':'POST',headers:{accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'}),...(height===undefined?{}:{'x-cosmos-block-height':String(height)})},...(body===undefined?{}:{body:JSON.stringify(body)}),credentials:'omit',redirect:'error',cache:'no-store',referrerPolicy:'no-referrer',signal});}catch{throw Error('INJECTIVE_RPC_TRANSPORT_UNCERTAIN');}
    need(r&&!r.redirected,'INJECTIVE_RPC_REDIRECT');if(!strictNotFound&&path.startsWith('/cosmos/tx/v1beta1/txs/')&&r.status===404){try{await r.body?.cancel();}catch{}return {notFound:true};}
    if(strictNotFound&&r.status===404){
      const response=new Response(r.body,{status:200,headers:r.headers});let data;
      try{const raw=await readBytes(response,{maxBytes:16384,signal});data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:16384,maxDepth:8,maxNodes:100});}catch{throw Error('INJECTIVE_RECOVERY_NOTFOUND_INVALID');}
      need(data&&data.code==='5'&&typeof data.message==='string'&&data.message.length>0&&data.message.length<=2048&&Object.keys(data).every(k=>['code','message','details'].includes(k))&&(data.details===undefined||Array.isArray(data.details)&&data.details.length===0),'INJECTIVE_RECOVERY_NOTFOUND_INVALID');return {notFound:true};
    }
    let raw;try{raw=await readBytes(r,{maxBytes:524288,signal});}catch(e){if(e.message==='HTTP_REJECTED')throw Error('INJECTIVE_RPC_HTTP_ERROR');throw Error('INJECTIVE_RPC_TRANSPORT_UNCERTAIN');}
    if(height!==undefined)need(heightHeader(r.headers)===String(height),'INJECTIVE_QUERY_HEIGHT_MISMATCH');
    let data;try{data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:524288,maxNodes:10000,maxDepth:24});}catch{throw Error('INJECTIVE_RPC_JSON_INVALID');}
    need(data&&typeof data==='object'&&!Array.isArray(data),'INJECTIVE_RPC_JSON_INVALID');return data;
  }
  async recheck(review,account,{fresh=true}={}){
    if(review.schema===ACTION_SCHEMA)return recheckOwnerAction(this,review,account,{fresh});
    validateInjectiveReview(review,account,{now:this.now(),fresh});const latest=await this.request(review,'/cosmos/base/tendermint/v1beta1/blocks/latest'),h=blockHeader(latest);need(h.chain_id===review.chainId,'INJECTIVE_CHAIN_CHANGED');const height=u64(h.height);need(height>0n&&height<BigInt(review.transaction.timeoutHeight),'INJECTIVE_TRANSACTION_TIMEOUT');
    const ar=await this.request(review,'/cosmos/auth/v1beta1/accounts/'+review.plan.input.sender,{height:String(height)}),a=accountBase(ar);need(a.address===review.plan.input.sender&&a.account_number===review.account.accountNumber&&a.sequence===review.account.sequence,'INJECTIVE_ACCOUNT_CHANGED');
    if(a.pub_key!==null){need(a.pub_key?.['@type']==='/injective.crypto.v1beta1.ethsecp256k1.PubKey'&&a.pub_key.key===Buffer.from(review.account.publicKeyHex,'hex').toString('base64'),'INJECTIVE_ACCOUNT_KEY_CHANGED');}
    const sim=await this.request(review,'/cosmos/tx/v1beta1/simulate',{height:String(height),body:{tx_bytes:review.transaction.simulationTxBase64}}),used=u64(sim.gas_info?.gas_used),wanted=u64(sim.gas_info?.gas_wanted),cap=u64(review.transaction.fee.gasLimit);need(used>0n&&wanted>=used&&used<=cap&&sim.result&&typeof sim.result==='object'&&!Array.isArray(sim.result),'INJECTIVE_SIMULATION_FAILED');
    const margin=BigInt(review.policy.gasMarginBps);need(used*margin<=cap*10000n,'INJECTIVE_SIMULATION_GAS_MARGIN');return {height:String(height),gasUsed:String(used),gasWanted:String(wanted)};
  }
  unresolved(records,account){need(!records.some(r=>r.accountId===account.id&&!injectiveResolved(r)),'INJECTIVE_UNRESOLVED_TRANSACTION');}
  prepare(account,review){return makeInjectiveIntent(account,review,{now:this.now});}
  hash(intent){return intent.payment.paymentHash;}
  async requireActionSource(vault,review,account){
    if(review.schema!==ACTION_SCHEMA||review.action.kind!=='cancel')return;
    const a=review.action,source=(await vault.injectiveRecords()).find(r=>r.id===a.sourceRecordId);
    need(source,'INJECTIVE_CANCEL_SOURCE_REQUIRED');
    verifyInjectiveSigned(source.signed,source.summary,account);
    const expected=cancelAction(source,account,{requestKey:a.requestKey,orderHash:a.orderHash,policy:review.policy});
    need(canonical(expected)===canonical(a)&&injectiveReviewFromSummary(source.summary).endpoint===review.endpoint,'INJECTIVE_CANCEL_SOURCE_CHANGED');
  }
  async sign(vault,intent,{authorize=()=>{}}={}){
    const account=vault.account(intent.accountId);verifyInjectiveIntent(intent,account,{now:this.now(),fresh:true});const epoch=vault.epoch,guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');verifyInjectiveIntent(intent,account,{now:this.now(),fresh:true});};
    this.unresolved(await vault.injectiveRecords(),account);guard();await this.requireActionSource(vault,reviewOf(intent.summary),account);guard();const checked=await this.recheck(reviewOf(intent.summary),account,{fresh:true});guard();await checkRetirementAnchor(this,await vault.injectiveRecords(),account,reviewOf(intent.summary),checked.height);guard();await checkInjectiveContinuity(this,reviewOf(intent.summary),await vault.injectiveRecords(),account.id,{requiredHeight:checked.height,guard});guard();
    return vault.signInjectiveAndRecord(intent,secret=>{guard();return signInjectiveIntent(secret,intent,account);});
  }
  async current(vault,candidate){const r=(await vault.injectiveRecords()).find(r=>r.id===candidate.id);need(r&&canonical(r)===canonical(candidate)&&r.summary.operation===injectiveOperation(reviewOf(r.summary)),'INJECTIVE_RECORD_CHANGED');verifyInjectiveSigned(r.signed,r.summary,vault.account(r.accountId));return r;}
  report(hash,reason,{received=false,height,code}={}){return {observedAt:this.now(),received,reason,transactionHash:hash,automaticRetry:false,finalityProven:false,...(height===undefined?{}:{height:String(height)}),...(code===undefined?{}:{code})};}
  async broadcast(vault,candidate,{authorize=()=>{}}={}){
    vault.check();const epoch=vault.epoch,key=candidate.accountId;need(!this.active.has(key),'INJECTIVE_OPERATION_BUSY');this.active.add(key);const guard=()=>{authorize();vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');need(Number.isSafeInteger(this.now())&&this.now()<candidate.summary.expiresAt,'INJECTIVE_SIGNED_REVIEW_EXPIRED');};
    try{let r=await this.current(vault,candidate);guard();need(r.state==='signed','INJECTIVE_RESUBMISSION_FORBIDDEN');need(this.now()<r.summary.expiresAt,'INJECTIVE_SIGNED_REVIEW_EXPIRED');const review=reviewOf(r.summary);await this.requireActionSource(vault,review,vault.account(r.accountId));guard();const checked=await this.recheck(review,vault.account(r.accountId),{fresh:false});guard();await checkRetirementAnchor(this,await vault.injectiveRecords(),vault.account(r.accountId),review,checked.height);guard();await checkInjectiveContinuity(this,review,await vault.injectiveRecords(),r.accountId,{requiredHeight:checked.height,guard});guard();
      r=await vault.observeInjective(r,'broadcast-unknown',this.report(r.signed.requestId,'SUBMISSION_STARTING'));guard();let response;
      try{response=await this.request(review,'/cosmos/tx/v1beta1/txs',{body:{tx_bytes:r.signed.txRawBase64,mode:'BROADCAST_MODE_SYNC'}});}catch{return r;}
      const tx=response.tx_response;need(tx&&typeof tx==='object'&&tx.txhash===r.signed.requestId,'INJECTIVE_BROADCAST_RESPONSE');const code=numericCode(tx.code);guard();
      if(code!==0)return vault.observeInjective(r,'reported-reverted',this.report(r.signed.requestId,'CHECKTX_REJECTED',{received:false,code}));
      return vault.observeInjective(r,'broadcast',this.report(r.signed.requestId,'RPC_ACCEPTED_NOT_CONFIRMED',{received:false,code:0}));
    }finally{this.active.delete(key);}
  }
  async reconcile(vault,candidate){
    vault.check();const epoch=vault.epoch,r=await this.current(vault,candidate);if(injectiveResolved(r))return r;
    const guard=()=>{vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');},review=reviewOf(r.summary),records=await vault.injectiveRecords();guard();
    await checkInjectiveContinuity(this,review,records,r.accountId,{guard});guard();let found;
    try{found=await this.request(reviewOf(r.summary),'/cosmos/tx/v1beta1/txs/'+r.signed.requestId);}catch(e){vault.check();need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');return vault.observeInjective(r,r.state==='signed'?'signed':'broadcast-unknown',this.report(r.signed.requestId,safeError(e)));}
    guard();const checked=await checkInjectiveContinuity(this,review,records,r.accountId,{guard});guard();if(found.notFound)return vault.observeInjective(r,r.state==='signed'?'signed':'broadcast-unknown',this.report(r.signed.requestId,'NOT_FOUND_DOES_NOT_PROVE_FAILURE'));
    const tx=found.tx_response;need(tx&&tx.txhash===r.signed.requestId&&typeof tx.height==='string','INJECTIVE_RECEIPT_INVALID');const code=numericCode(tx.code);need(u64(tx.height)>u64(review.anchor.height)&&u64(tx.height)<=u64(checked.observedHeight),'INJECTIVE_RECEIPT_HEIGHT');const state=code===0?'reported-confirmed':'reported-reverted',report=this.report(r.signed.requestId,code===0?'INCLUDED_SUCCESS':'INCLUDED_FAILURE',{received:true,height:tx.height,code});
    if(code===0&&review.schema===ACTION_SCHEMA){try{report.actionEffect=await readActionEffect(this,review,tx.height);}catch{report.actionEffect={kind:review.action.kind,status:'unavailable',independentProof:false};}}
    await checkInjectiveContinuity(this,review,records,r.accountId,{guard});guard();return vault.observeInjective(r,state,report);
  }
}
