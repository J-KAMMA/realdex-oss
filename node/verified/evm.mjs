import { need, integer, exact } from '../shared/protocol-core.mjs';
import { address, keccak256, selector } from './keccak.mjs';
import { constantProductOut, optimizeDiscreteSplit } from '../optimizer/discrete-split.mjs';
import { rankExactInputQuotes, assetId, identifier, amount } from '../optimizer/quote-objective.mjs';

// A LOCAL trust root, synchronized by test with src/swap/local-amm-code-identities.json.
// This value is NEVER obtained from a node announcement or an RPC response.
export const FACTORY_RUNTIME_HASH = '0xff03fb954cf0e48c7da39c529d7666baa4f25063918aaf8a9d6f0a318fa023f8';
export const MAX_RESERVE = (1n<<112n)-1n;
const ZERO = '0x'+'0'.repeat(40), MAX_UINT = (1n<<256n)-1n;
const ABI = Object.freeze(Object.fromEntries(['getPool(address,address,uint256)','factory()','token0()','token1()','feeBasisPoints()',
  'getReserves()','quoteExactIn(address,uint256)','balanceOf(address)','allowance(address,address)','swapExactIn(address,uint256,uint256,address,uint256)'].map(s => [s,selector(s)])));
export function uintWord(value) {
  need(typeof value === 'bigint' && value >= 0n && value <= MAX_UINT,'ABI_UINT_INVALID'); return value.toString(16).padStart(64,'0');
}
export const addressWord = value => address(value).slice(2).padStart(64,'0');
export function encodeCall(signature,words = []) {
  need(Object.hasOwn(ABI,signature) && Array.isArray(words) && words.length === (signature.endsWith('()') ? 0 : signature.split(',').length) &&
    words.every(w => typeof w === 'string' && /^[0-9a-f]{64}$/.test(w)),'ABI_CALL_INVALID');
  return ABI[signature]+words.join('');
}
export function decodeWords(value,count) {
  integer(count,1,8,'ABI_WORD_COUNT_INVALID');
  need(typeof value === 'string' && value.length === 2+64*count && /^0x[0-9a-f]*$/.test(value),'ABI_RETURN_INVALID');
  return Array.from({length:count},(_,i) => BigInt('0x'+value.slice(2+i*64,66+i*64)));
}
export function decodeAddress(value) {
  const [word] = decodeWords(value,1); need(word < (1n<<160n),'ABI_ADDRESS_PADDING_INVALID'); return '0x'+word.toString(16).padStart(40,'0');
}
const call = (s,to,signature,words=[]) => s.read('eth_call',[{to,data:encodeCall(signature,words)}]);
function deepFreeze(x) { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; }
const ISSUED = new WeakMap();
function current(observation) {
  const session = ISSUED.get(observation); need(session,'OBSERVATION_NOT_ISSUED_HERE'); session.time(); return session;
}
export function assertCurrentObservation(observation) { current(observation); return observation; }
export function parseDiscoveryRequest(value) {
  exact(value,['requestId','chainId','tokenIn','tokenOut','amountIn','slippageBps','feeTiers'],'DISCOVERY_REQUEST_INVALID');
  need(typeof value.requestId === 'string' && /^[a-z0-9][a-z0-9:._-]{2,160}$/.test(value.requestId),'REQUEST_ID_INVALID');
  need(typeof value.chainId === 'string' && /^eip155:[1-9][0-9]{0,19}$/.test(value.chainId),'CHAIN_ID_INVALID');
  const tokenIn = address(value.tokenIn),tokenOut = address(value.tokenOut); need(tokenIn!==tokenOut,'TOKEN_PAIR_INVALID');
  need(typeof value.amountIn === 'bigint' && value.amountIn > 0n && value.amountIn <= MAX_RESERVE,'AMOUNT_INVALID');
  integer(value.slippageBps,0,1000,'SLIPPAGE_INVALID');
  need(Array.isArray(value.feeTiers) && value.feeTiers.length>=1 && value.feeTiers.length<=16 && new Set(value.feeTiers).size===value.feeTiers.length,'FEE_TIERS_INVALID');
  value.feeTiers.forEach(f => integer(f,1,100,'FEE_TIERS_INVALID'));
  return deepFreeze({...value,tokenIn,tokenOut,feeTiers:[...value.feeTiers]});
}
/** A peer supplies only factory addresses. All code, token, reserve and quote
 * checks come from caller-selected RPCs at the same block hash. Pool provenance
 * observes the exact Factory runtime and its getPool mapping. This does NOT
 * prove its constructor/initial storage or the Pool's creation provenance.
 * Pool runtime templates and CREATE2 provenance are not yet bound here. A node's
 * claimed code hash, pool address, fee, balance, spender or quote is never read. */
export async function observeLocalPools(session,candidateValues,requestValue,localPolicy = {factoryRuntimeHash:FACTORY_RUNTIME_HASH}) {
  // Explicit caller-owned trust policy permits independent local test deployments.
  // The browser and CLI never accept a policy hash from peers or form inputs.
  exact(localPolicy,['factoryRuntimeHash'],'FACTORY_POLICY_INVALID');
  need(typeof localPolicy.factoryRuntimeHash === 'string' && /^0x[0-9a-f]{64}$/.test(localPolicy.factoryRuntimeHash),'FACTORY_POLICY_INVALID');
  const factoryRuntimeHash = localPolicy.factoryRuntimeHash;
  const request = parseDiscoveryRequest(structuredClone(requestValue));
  need(request.chainId===session.anchor.chainId,'REQUEST_CHAIN_MISMATCH');
  need(Array.isArray(candidateValues) && candidateValues.length<=512,'CANDIDATE_LIMIT');
  const candidates=structuredClone(candidateValues),factories=[],seen=new Set(),rejected=[];
  for (const c of candidates) {
    try {
      need(c && c.protocol==='realdex-cpmm-v1' && c.chainId===request.chainId,'CANDIDATE_CHAIN_OR_PROTOCOL');
      const factory=address(c.address); need(!seen.has(factory),'DUPLICATE_FACTORY'); seen.add(factory); factories.push(factory);
    } catch(e) { rejected.push({factory:typeof c?.address==='string'?c.address.slice(0,42):'invalid',feeBps:null,code:e.message}); }
  }
  need(factories.length*request.feeTiers.length<=32,'FACTORY_TIER_BUDGET_EXCEEDED');
  const pools=[],seenPools=new Set();
  for (const factory of factories) {
    try {
      const code = await session.read('eth_getCode',[factory]);
      need(code!=='0x' && keccak256(code)===factoryRuntimeHash,'FACTORY_CODE_MISMATCH');
    } catch(e) { rejected.push({factory,feeBps:null,code:e.message}); continue; }
    for (const feeBps of request.feeTiers) {
      try {
        const pool=decodeAddress(await call(session,factory,'getPool(address,address,uint256)',[addressWord(request.tokenIn),addressWord(request.tokenOut),uintWord(BigInt(feeBps))]));
        need(pool!==ZERO,'POOL_NOT_FOUND'); need(!seenPools.has(pool),'DUPLICATE_POOL');
        const [code,owner,t0,t1,fee,reserves,onChainOut] = await Promise.all([
          session.read('eth_getCode',[pool]),call(session,pool,'factory()'),call(session,pool,'token0()'),call(session,pool,'token1()'),
          call(session,pool,'feeBasisPoints()'),call(session,pool,'getReserves()'),
          call(session,pool,'quoteExactIn(address,uint256)',[addressWord(request.tokenIn),uintWord(request.amountIn)])]);
        need(code!=='0x','POOL_CODE_MISSING'); need(decodeAddress(owner)===factory,'POOL_FACTORY_MISMATCH');
        const token0=decodeAddress(t0),token1=decodeAddress(t1),sorted=[request.tokenIn,request.tokenOut].sort();
        need(token0===sorted[0] && token1===sorted[1],'POOL_TOKEN_PAIR_MISMATCH');
        need(decodeWords(fee,1)[0]===BigInt(feeBps),'POOL_FEE_MISMATCH');
        const [reserve0,reserve1,lastTimestamp]=decodeWords(reserves,3);
        need(reserve0>0n && reserve1>0n && reserve0<=MAX_RESERVE && reserve1<=MAX_RESERVE && lastTimestamp < (1n<<32n),'POOL_RESERVES_INVALID');
        const [tokenCodeIn,tokenCodeOut,b0,b1]=await Promise.all([
          session.read('eth_getCode',[request.tokenIn]),session.read('eth_getCode',[request.tokenOut]),
          call(session,token0,'balanceOf(address)',[addressWord(pool)]),call(session,token1,'balanceOf(address)',[addressWord(pool)])]);
        need(tokenCodeIn!=='0x' && tokenCodeOut!=='0x','TOKEN_CODE_MISSING');
        const balance0=decodeWords(b0,1)[0],balance1=decodeWords(b1,1)[0];
        need(balance0>=reserve0 && balance1>=reserve1 && balance0<=MAX_RESERVE && balance1<=MAX_RESERVE,'POOL_BALANCES_UNSUPPORTED');
        const forward=request.tokenIn===token0,reserveIn=forward?reserve0:reserve1,reserveOut=forward?reserve1:reserve0;
        need((forward?balance0:balance1)+request.amountIn<=MAX_RESERVE,'POOL_INPUT_OVERFLOW');
        const expectedOut=constantProductOut(request.amountIn,reserveIn,reserveOut,feeBps),minimumOut=expectedOut*BigInt(10000-request.slippageBps)/10000n;
        need(expectedOut>0n && minimumOut>0n && decodeWords(onChainOut,1)[0]===expectedOut,'POOL_QUOTE_MISMATCH');
        const spotNumerator=request.amountIn*reserveOut;
        const impact=Number((spotNumerator-expectedOut*reserveIn)*10000n/spotNumerator);
        seenPools.add(pool);
        pools.push({routeId:`verified:${request.chainId}:${pool}`,factory,pool,feeBps,token0,token1,reserveIn,reserveOut,
          expectedOut,minimumOut,priceImpactBps:impact,runtimeHash:keccak256(code),
          tokenCodeHashes:{input:keccak256(tokenCodeIn),output:keccak256(tokenCodeOut)}});
      } catch(e) { rejected.push({factory,feeBps,code:e.message}); }
    }
  }
  await session.verifyCurrent();
  const observation=deepFreeze({schema:'realdex.pool-observation.v1',factoryRuntimeHash,request,anchor:{...session.anchor},readerIds:session.readerIds,
    pools,rejected,expiresAt:session.anchor.expiresAt,executable:false,tokenTransferBehaviorVerified:false,poolCreationProvenanceVerified:false,poolRuntimeIdentityVerified:false,
    trust:'agreement-of-configured-rpcs-not-light-client-proof'});
  ISSUED.set(observation,session); return observation;
}
export async function recheckObservation(observation) { await current(observation).verifyCurrent(); return observation; }
/** A separate read-only preflight. A successful eth_call is not a send grant. */
export async function simulateObservedPool(observation,routeId,{account,recipient}) {
  const session=current(observation),r=observation.request,pool=observation.pools.find(p=>p.routeId===routeId);
  need(pool,'OBSERVED_ROUTE_REQUIRED'); account=address(account);recipient=address(recipient);need(recipient!==pool.pool,'RECIPIENT_INVALID');
  await session.verifyCurrent();
  const [balance,allowance]=await Promise.all([
    call(session,r.tokenIn,'balanceOf(address)',[addressWord(account)]),
    call(session,r.tokenIn,'allowance(address,address)',[addressWord(account),addressWord(pool.pool)])]);
  need(decodeWords(balance,1)[0]>=r.amountIn,'ACCOUNT_BALANCE_INSUFFICIENT');
  need(decodeWords(allowance,1)[0]>=r.amountIn,'APPROVAL_REQUIRED_NO_TRANSACTION_SENT');
  const deadline=BigInt(Math.floor(observation.expiresAt/1000));
  const transaction={from:account,to:pool.pool,value:'0x0',data:encodeCall('swapExactIn(address,uint256,uint256,address,uint256)',
    [addressWord(r.tokenIn),uintWord(r.amountIn),uintWord(pool.minimumOut),addressWord(recipient),uintWord(deadline)])};
  const output=decodeWords(await session.read('eth_call',[transaction]),1)[0];
  need(output===pool.expectedOut,'SIMULATED_OUTPUT_MISMATCH');
  const gas=await session.estimateGas(transaction);await session.verifyCurrent();
  const result=deepFreeze({schema:'realdex.readonly-simulation.v1',routeId,requestId:r.requestId,account,recipient,blockHash:observation.anchor.hash,
    gas,expiresAt:observation.expiresAt,executable:false,warning:'eth_call return is not recipient balance-delta proof; no signing grant'});
  SIMULATED.set(result,observation);return result;
}
const SIMULATED = new WeakMap();
/** Network-fee completeness and conversion rates are caller attestations, not
 * statements authenticated by this module. Every attestation is bound to the
 * observed block, route, request, account, recipient and short lifetime. Never
 * use a peer announcement as fee evidence. Defaults remain incomplete. */
export function compareObservedPools(observation,{simulations=[],rates=[],nativeAsset,networkFeeEvidence=[]}={}) {
  const session=current(observation),r=observation.request,now=session.time();
  need(Array.isArray(simulations) && simulations.length<=32,'SIMULATION_LIMIT');
  need(Array.isArray(networkFeeEvidence) && networkFeeEvidence.length<=32,'NETWORK_FEE_EVIDENCE_LIMIT');
  if(nativeAsset!==undefined) need(typeof nativeAsset==='string' && /^eip155:[1-9][0-9]{0,19}\/slip44:(?:0|[1-9][0-9]{0,9})$/.test(nativeAsset) && nativeAsset.split('/')[0]===r.chainId,'NATIVE_ASSET_CHAIN_MISMATCH');
  const context={requestId:r.requestId,sourceAsset:`${r.chainId}/erc20:${r.tokenIn}`,destinationAsset:`${r.chainId}/erc20:${r.tokenOut}`,amountIn:r.amountIn};
  const byRoute=new Map();let accountBinding=null;
  for(const s of simulations) {
    need(SIMULATED.get(s)===observation && s.expiresAt>now && !byRoute.has(s.routeId),'SIMULATION_NOT_BOUND');
    const binding=s.account+'/'+s.recipient;need(accountBinding===null || binding===accountBinding,'SIMULATION_ACCOUNT_CONTEXT_MISMATCH');accountBinding=binding;byRoute.set(s.routeId,s);
  }
  const fees=new Map();
  for(const e of networkFeeEvidence) {
    exact(e,['schema','routeId','requestId','blockHash','account','recipient','asOf','expiresAt','complete','source','costs'],'NETWORK_FEE_EVIDENCE_INVALID');
    const sim=byRoute.get(e.routeId);
    need(e.schema==='realdex.network-fee-attestation.v1' && sim && !fees.has(e.routeId) && e.requestId===r.requestId && e.blockHash===observation.anchor.hash &&
      e.account===sim.account && e.recipient===sim.recipient,'NETWORK_FEE_CONTEXT_MISMATCH');
    integer(e.asOf,observation.anchor.observedAt,now,'NETWORK_FEE_TIME_INVALID');integer(e.expiresAt,now+1,observation.expiresAt,'NETWORK_FEE_TIME_INVALID');
    need(typeof e.complete==='boolean' && identifier(e.source) && Array.isArray(e.costs) && e.costs.length<=16,'NETWORK_FEE_EVIDENCE_INVALID');
    const ids=new Set(['execution-gas']);
    for(const c of e.costs){exact(c,['id','asset','amount'],'NETWORK_FEE_COST_INVALID');
      need(identifier(c.id) && !ids.has(c.id) && assetId(c.asset) && c.asset.split('/')[0]===r.chainId,'NETWORK_FEE_COST_INVALID');amount(c.amount);ids.add(c.id);}
    fees.set(e.routeId,e);
  }
  const quotes=observation.pools.map(pool=>{
    const sim=byRoute.get(pool.routeId),e=fees.get(pool.routeId),costs=[],unpricedCosts=[];
    if(!sim) unpricedCosts.push('ACCOUNT_SIMULATION_AND_GAS_MISSING');
    else if(!nativeAsset) unpricedCosts.push('NATIVE_ASSET_ID_REQUIRED');
    else costs.push({id:'execution-gas',asset:nativeAsset,amount:sim.gas.gasUnits*sim.gas.gasPriceWei,treatment:'additional'});
    if(e) for(const c of e.costs)costs.push({...c,treatment:'additional'});
    if(!e?.complete)unpricedCosts.push('ADDITIONAL_NETWORK_FEES_NOT_ATTESTED');
    return {...context,routeId:pool.routeId,expectedOut:pool.expectedOut,minimumOut:pool.minimumOut,expiresAt:e?Math.min(e.expiresAt,observation.expiresAt):observation.expiresAt,
      durationSeconds:null,priceImpactBps:pool.priceImpactBps,riskClass:'local-amm-observation',finality:'none',costs,unpricedCosts};
  });
  return {...rankExactInputQuotes(context,quotes,rates,{now,minimumLifetimeMs:0,maximumSeconds:null,maximumPriceImpactBps:null,
    allowedRiskClasses:['local-amm-observation'],requireTrackedFinality:false}),
    costEvidence:'caller-attested-network-fees-and-conversion-rates-not-oracle-verified',futureFeeGuarantee:false};
}
/** Gross-output research grid only: zero costs mean EXCLUDED, not free. A separate
 * net result must supply verified, additive cost curves before any ranking claim. */
export function planObservedGrossSplit(observation,{steps=100,maximumSplits=4}={}) {
  const session=current(observation),r=observation.request;
  integer(steps,1,128,'GRID_LIMIT');integer(maximumSplits,1,4,'SPLIT_COUNT_INVALID');
  need(observation.pools.length>=1 && observation.pools.length<=8,'SPLIT_ROUTE_LIMIT');
  need(r.amountIn%BigInt(steps)===0n,'AMOUNT_NOT_ON_GRID');
  const quantum=r.amountIn/BigInt(steps),snapshotId=observation.anchor.hash;
  const context={requestId:r.requestId,sourceAsset:`${r.chainId}/erc20:${r.tokenIn}`,destinationAsset:`${r.chainId}/erc20:${r.tokenOut}`,amountIn:r.amountIn};
  const routes=observation.pools.map(p=>({routeId:p.routeId,requestId:r.requestId,sourceAsset:context.sourceAsset,destinationAsset:context.destinationAsset,
    snapshotId,poolIds:[`${r.chainId}:${p.pool}`],samples:Array.from({length:steps},(_,i)=>{
      const out=constantProductOut(BigInt(i+1)*quantum,p.reserveIn,p.reserveOut,p.feeBps)*BigInt(10000-r.slippageBps)/10000n;
      return out>0n?{steps:i+1,minimumOut:out,additionalCostOut:0n,expiresAt:observation.expiresAt}:null;
    })}));
  const result=optimizeDiscreteSplit(context,routes,{now:session.time(),quantum,maximumSplits,snapshotId,fixedExecutionCostOut:0n});
  return {...result,objective:'gross-minimum-output-excluding-all-network-costs',netOptimality:false,costsExcluded:true,
    coverage:'all-observed-pools-on-requested-grid',selectedPoolCount:routes.length};
}
export function observationJson(observation) {
  current(observation);
  return JSON.stringify({...observation,usage:'READ_ONLY_EVIDENCE_NOT_A_TRANSACTION_OR_RELEASE_APPROVAL'},(_key,value)=>typeof value==='bigint'?value.toString():value,2);
}
