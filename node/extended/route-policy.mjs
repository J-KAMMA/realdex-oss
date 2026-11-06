/** Policy screening for route *claims*. Passing this screen is NOT evidence that
 * a bridge/pool implements its declared privacy properties or is safe to execute. */
import {check,keys,text,uint,freeze} from './guard.mjs';
import {canonical} from '../chains/core.mjs';
function endpoint(x){keys(x,['networkId','assetKey','visibility']);text(x.networkId,100);text(x.assetKey,256);check(['transparent','shielded','confidential','unknown'].includes(x.visibility),'VISIBILITY_INVALID');return x;}
function settings(raw={}){keys(raw,[],['requireEndToEndPrivacy','allowPublicBoundary','allowConfidentialHardware']);const p={requireEndToEndPrivacy:true,allowPublicBoundary:false,allowConfidentialHardware:false,...raw};
 check(Object.values(p).every(v=>typeof v==='boolean'),'ROUTE_POLICY_INVALID');check(!(p.requireEndToEndPrivacy&&p.allowPublicBoundary),'ROUTE_POLICY_CONFLICT');return p;}
export function screenRoute(route,request,rawPolicy={},now=Date.now()){
 const policy=settings(rawPolicy);keys(request,['inputAssetKey','outputAssetKey','amountInAtomic']);text(request.inputAssetKey,256);text(request.outputAssetKey,256);const amount=uint(request.amountInAtomic);check(amount>0n,'AMOUNT_ZERO');
 keys(route,['id','amountInAtomic','minimumOutAtomic','additionalCostOutAtomic','expiresAt','steps']);text(route.id,128);
 check(Number.isSafeInteger(now)&&now>0&&Number.isSafeInteger(route.expiresAt),'TIME_INVALID');check(Array.isArray(route.steps)&&route.steps.length>=1&&route.steps.length<=16,'ROUTE_STEP_LIMIT');
 const reasons=[];if(route.expiresAt<=now)reasons.push('QUOTE_EXPIRED');if(uint(route.amountInAtomic)!==amount)reasons.push('INPUT_AMOUNT_MISMATCH');
 const min=uint(route.minimumOutAtomic);let cost=null;if(route.additionalCostOutAtomic!==null)cost=uint(route.additionalCostOutAtomic);else reasons.push('INCOMPLETE_FEE_ESTIMATE');
 let privacyDeclared=true;for(let i=0;i<route.steps.length;i++){
  const s=route.steps[i];keys(s,['id','kind','from','to','disclosure']);text(s.id,128);check(['swap','bridge'].includes(s.kind),'STEP_KIND_INVALID');endpoint(s.from);endpoint(s.to);
  check(['none','public-amounts','public-addresses','public-both','unknown'].includes(s.disclosure),'DISCLOSURE_INVALID');
  if(i>0&&canonical(s.from)!==canonical(route.steps[i-1].to))reasons.push('ROUTE_DISCONTINUITY');
  if(s.kind==='swap'&&s.from.networkId!==s.to.networkId)reasons.push('CROSS_CHAIN_SWAP_WITHOUT_BRIDGE');
  if(s.kind==='bridge'&&s.from.networkId===s.to.networkId)reasons.push('BRIDGE_NETWORK_AMBIGUOUS');
  const vis=[s.from.visibility,s.to.visibility];
  if(vis.includes('unknown')||s.disclosure==='unknown'){reasons.push('PRIVACY_PROPERTY_UNKNOWN');privacyDeclared=false;}
  if(vis.includes('confidential')&&!policy.allowConfidentialHardware)reasons.push('CONFIDENTIAL_HARDWARE_NOT_ALLOWED');
  if(vis.includes('transparent')||s.disclosure!=='none'){privacyDeclared=false;if(policy.requireEndToEndPrivacy)reasons.push('END_TO_END_PRIVACY_REQUIRED');}
  const privateBoundary=vis.some(v=>['shielded','confidential'].includes(v))&&(vis.includes('transparent')||s.disclosure!=='none');
  if(privateBoundary&&!policy.allowPublicBoundary)reasons.push('PRIVACY_DOWNGRADE_NOT_AUTHORIZED');
 }
 if(route.steps[0].from.assetKey!==request.inputAssetKey||route.steps.at(-1).to.assetKey!==request.outputAssetKey)reasons.push('ASSET_BINDING_MISMATCH');
 const net=cost===null?null:min>cost?min-cost:0n;if(net===0n)reasons.push('NO_POSITIVE_NET_OUTPUT');
 return freeze({routeId:route.id,allowedForFurtherVerification:reasons.length===0,reasons:[...new Set(reasons)],
  netMinimumOutAtomic:net===null?null:String(net),declaredPrivacyPreserved:privacyDeclared,privacyActuallyVerified:false,quoteActuallyVerified:false,executable:false});
}
export function selectPolicyRoute(routes,request,policy={},now=Date.now()){
 check(Array.isArray(routes)&&routes.length<=128,'ROUTE_LIMIT');check(new Set(routes.map(r=>r.id)).size===routes.length,'DUPLICATE_ROUTE_ID');
 const assessments=routes.map(r=>screenRoute(r,request,policy,now));const eligible=assessments.filter(a=>a.allowedForFurtherVerification);
 eligible.sort((a,b)=>{const x=BigInt(a.netMinimumOutAtomic),y=BigInt(b.netMinimumOutAtomic);return x===y?(a.routeId<b.routeId?-1:1):x>y?-1:1;});
 return freeze({selectedForFurtherVerification:eligible[0]?.routeId??null,assessments,allRoutesRejected:eligible.length===0,executable:false});
}
