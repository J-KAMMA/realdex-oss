/** Local HTTP authority checks, not a browser, OS isolation, or security-audit claim. */
import {need,sha,uint} from './protocol.mjs';
export const SCHEMA='realdex.owner-authority-e2e.v1';
export const FALSE_FLAGS=Object.freeze(['publicNetwork','productionReady','stateProofVerified','browserEndToEndPassed','checkpointCompatibilityVerified','productSuccessor','wholeProductAcceptance','independentAudit']);
export const PHASES=Object.freeze(['prepare','approve','submit']);
export const ATTACKS=Object.freeze([
 {id:'missing-authorization',status:401,error:'UI_AUTH_REQUIRED'},
 {id:'wrong-capability',status:401,error:'UI_AUTH_REQUIRED'},
 {id:'missing-origin',status:400,error:'WALLET_ORIGIN_REQUIRED'},
 {id:'foreign-origin-with-owner-capability',status:400,error:'WALLET_ORIGIN_REQUIRED'},
 {id:'allowed-app-origin-with-owner-capability',status:400,error:'WALLET_ORIGIN_REQUIRED'},
 {id:'null-origin',status:400,error:'WALLET_ORIGIN_REQUIRED'},
 {id:'different-host',status:400,error:'HOST_NOT_ALLOWED'},
 {id:'absolute-foreign-target',status:400,error:'REQUEST_URL_INVALID'},
 {id:'query-token',status:400,error:'REQUEST_URL_INVALID'},
 {id:'cross-site-fetch',status:400,error:'FETCH_SITE_FORBIDDEN'},
 {id:'get-operation',status:400,error:'METHOD_NOT_ALLOWED'},
 {id:'options-operation',status:400,error:'METHOD_NOT_ALLOWED'},
 {id:'form-content-type',status:400,error:'JSON_CONTENT_TYPE_REQUIRED'},
 {id:'malformed-json',status:400,error:'JSON_INVALID'}
].map(Object.freeze));
export const CROSS_ROUTES=Object.freeze([
 {id:'unlisted-app-origin',status:400,error:'APP_ORIGIN_NOT_ALLOWED'},
 {id:'bridge-owner-route',status:404,error:'NOT_FOUND'},
 {id:'bridge-without-marker',status:400,error:'BRIDGE_HEADER_REQUIRED'},
 {id:'bridge-cors-owner-header',status:400,error:'CORS_HEADERS_FORBIDDEN'},
 {id:'agent-browser-origin',status:400,error:'AGENT_BROWSER_REQUEST_FORBIDDEN'},
 {id:'agent-invalid-capability',status:401,error:'AGENT_UNAUTHORIZED'}
].map(Object.freeze));
export const SNAPSHOT_KEYS=Object.freeze(['writes','reads','sends','locked','epoch','cipherSha256','requestsSha256','recordsSha256']);
export const STATIC_HEADERS=Object.freeze({'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cross-origin-opener-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"});
export const CHECKS=Object.freeze(['static-headers-no-capability',
 ...ATTACKS.map(a=>'prepare/'+a.id),'valid-prepare-no-signature',
 ...ATTACKS.map(a=>'approve/'+a.id),'valid-approve-no-send',
 ...ATTACKS.map(a=>'submit/'+a.id),...CROSS_ROUTES.map(a=>'cross-route/'+a.id),
 'valid-submit-once','included-deposit-exact','owner-rate-limit','rate-limited-mutation-denied','emergency-lock-at-limit','same-store-restart','old-capability-after-restart','no-resend-on-repeat','exact-fee-and-sequence']);
const fields=(x,keys)=>need(x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(','),'E2E_AUTH_FIELDS');
export function snapshot(s){return Object.fromEntries(SNAPSHOT_KEYS.map(k=>[k,s[k]]));}
export function validateSnapshot(s){
 fields(s,SNAPSHOT_KEYS);for(const k of ['writes','reads','sends','epoch'])need(Number.isSafeInteger(s[k])&&s[k]>=0,'E2E_AUTH_COUNTER');
 need(typeof s.locked==='boolean','E2E_AUTH_LOCK');for(const k of ['cipherSha256','requestsSha256','recordsSha256'])need(/^[a-f0-9]{64}$/.test(s[k]),'E2E_AUTH_DIGEST');
}
export function validateRejection(r,expected){
 fields(r,['id','status','error','before','after']);need(r.id===expected.id&&r.status===expected.status&&r.error===expected.error,'E2E_AUTH_REJECTION');
 validateSnapshot(r.before);validateSnapshot(r.after);need(JSON.stringify(r.before)===JSON.stringify(r.after),'E2E_AUTH_SIDE_EFFECT');
}
export function verifyAuthorityEvidence(r,{expectedCommit,expectedTree}={}){
 const allowed=new Set(['schema','mode','status','commit','tree','checks','checkCount','rejections','rate','staticHeaders','sourceStable','runtimeStable','transport','syntheticResponses','externalRequests','before','after','transaction','ownerSends','restartSends','walletRestarts','oldCapabilityStatus','oldCapabilityError','repeatStatus','repeatError','chainVersion','genesisSha256','createdAt','durationMs','sourceDigest','trackedFiles','nodeVersion',...FALSE_FLAGS]);
 need(r&&Object.keys(r).every(k=>allowed.has(k)),'E2E_AUTH_FIELDS');
 need(r?.schema===SCHEMA&&r.mode==='api-authority'&&r.status==='passed','E2E_AUTH_SCHEMA');
 need(/^[a-f0-9]{40}$/.test(r.commit)&&/^[a-f0-9]{40}$/.test(r.tree)&&r.commit===expectedCommit&&r.tree===expectedTree,'E2E_AUTH_IDENTITY');
 for(const k of FALSE_FLAGS)need(r[k]===false,'E2E_AUTH_SCOPE');
 need(r.sourceStable===true&&r.runtimeStable===true&&r.transport==='direct-loopback-http'&&r.syntheticResponses===0&&r.externalRequests===0,'E2E_AUTH_SCOPE');
 need(Array.isArray(r.checks)&&JSON.stringify(r.checks)===JSON.stringify(CHECKS)&&r.checkCount===CHECKS.length,'E2E_AUTH_CHECK_SET');
 need(Array.isArray(r.rejections)&&r.rejections.length===PHASES.length*ATTACKS.length+CROSS_ROUTES.length,'E2E_AUTH_REJECTION_SET');
 let i=0;for(const p of PHASES)for(const a of ATTACKS)validateRejection(r.rejections[i++],{...a,id:p+'/'+a.id});
 for(const a of CROSS_ROUTES)validateRejection(r.rejections[i++],{...a,id:'cross-route/'+a.id});
 fields(r.rate,['status','error','before','after','requests','mutationStatus','mutationError','lockStatus','locked']);
 need(r.rate.status===429&&r.rate.error==='REQUEST_RATE_LIMIT'&&Number.isSafeInteger(r.rate.requests)&&r.rate.requests>0&&r.rate.requests<=601&&r.rate.mutationStatus===429&&r.rate.mutationError==='REQUEST_RATE_LIMIT'&&r.rate.lockStatus===200&&r.rate.locked===true,'E2E_AUTH_RATE');
 validateSnapshot(r.rate.before);validateSnapshot(r.rate.after);need(JSON.stringify(r.rate.before)===JSON.stringify(r.rate.after),'E2E_AUTH_RATE_SIDE_EFFECT');
 need(r.ownerSends===1&&r.restartSends===0&&r.walletRestarts===1&&r.oldCapabilityStatus===401&&r.oldCapabilityError==='UI_AUTH_REQUIRED'&&r.repeatStatus===400&&r.repeatError==='INJECTIVE_RESUBMISSION_FORBIDDEN','E2E_AUTH_RECOVERY');
 const t=r.transaction;need(t&&/^[A-F0-9]{64}$/.test(t.hash)&&t.code===0&&uint(t.height)>0n&&t.feeAtomic==='500000000000000'&&t.gasLimit==='1000000'&&t.gasWanted===t.gasLimit&&uint(t.gasUsed)>0n&&uint(t.gasUsed)<=uint(t.gasLimit),'E2E_AUTH_TRANSACTION');
 for(const s of [r.before,r.after]){fields(s,['base','gas','sequence','exchangeBase']);for(const v of Object.values(s))uint(v);}
 need(uint(r.before.base)-uint(r.after.base)===1000000000000000000n&&uint(r.after.exchangeBase)-uint(r.before.exchangeBase)===1000000000000000000n&&uint(r.before.gas)-uint(r.after.gas)===uint(t.feeAtomic)&&uint(r.after.sequence)-uint(r.before.sequence)===1n,'E2E_AUTH_ACCOUNTING');
 const h=r.staticHeaders;fields(h,Object.keys(STATIC_HEADERS));need(Object.keys(STATIC_HEADERS).every(k=>h[k]===STATIC_HEADERS[k]),'E2E_AUTH_HEADERS');
 need(/^[a-f0-9]{64}$/.test(r.genesisSha256)&&typeof r.chainVersion==='string','E2E_AUTH_RUNTIME');
 return {passed:true,checks:r.checkCount,rejectedOperations:r.rejections.length,ownerSends:1,browserEndToEndPassed:false,productionReady:false};
}
