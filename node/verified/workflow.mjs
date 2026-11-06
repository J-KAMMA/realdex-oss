import { exact, need, publicKeyValid } from '../shared/protocol-core.mjs';
import { address } from './keccak.mjs';
import { safeEndpoint, VerifiedCatalogue } from './catalogue.mjs';
import { createReadOnlyRpc, openPinnedReadSession } from './rpc.mjs';
import { parseDiscoveryRequest, observeLocalPools, simulateObservedPool, recheckObservation, compareObservedPools, observationJson } from './evm.mjs';

/** Local configuration only. RPC addresses and trust roots never come from peers.
 * Amounts are decimal strings at the file boundary and bigint internally. */
export function parseReadOnlyConfig(input) {
  exact(input,['schema','nodeUrl','relayPublicKey','publisherKeys','rpcUrls','request','account'],'READONLY_CONFIG_INVALID');
  need(input.schema==='realdex.readonly-request.v1','READONLY_CONFIG_INVALID');
  need(publicKeyValid(input.relayPublicKey) && Array.isArray(input.publisherKeys) && input.publisherKeys.length>=1 &&
    input.publisherKeys.length<=32 && input.publisherKeys.every(publicKeyValid) && new Set(input.publisherKeys).size===input.publisherKeys.length,'PUBLISHER_POLICY_INVALID');
  const nodeUrl=safeEndpoint(input.nodeUrl); need(nodeUrl.pathname==='/' && !nodeUrl.search,'NODE_ENDPOINT_ROOT_REQUIRED');
  need(Array.isArray(input.rpcUrls) && input.rpcUrls.length>=2 && input.rpcUrls.length<=4,'DISTINCT_RPC_READERS_REQUIRED');
  const rpcUrls=input.rpcUrls.map(value=>safeEndpoint(value).href);need(new Set(rpcUrls).size===rpcUrls.length,'DISTINCT_RPC_READERS_REQUIRED');
  need(typeof input.request?.amountIn==='string' && /^[1-9][0-9]{0,33}$/.test(input.request.amountIn),'AMOUNT_DECIMAL_STRING_REQUIRED');
  const request=parseDiscoveryRequest({...input.request,amountIn:BigInt(input.request.amountIn)});
  const account=input.account===null ? null : address(input.account);
  return Object.freeze({schema:input.schema,nodeUrl:nodeUrl.origin,relayPublicKey:input.relayPublicKey,
    publisherKeys:Object.freeze([...input.publisherKeys]),rpcUrls:Object.freeze(rpcUrls),request,account});
}
const safeError=error=>error instanceof Error && /^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'READONLY_OPERATION_FAILED';

/** This workflow is permanently read-only: no injected wallet, signing transport,
 * node-provided RPC, approval creation, configurable bytecode root or send path. */
export async function runReadOnlyRequest(input,{fetchImpl=globalThis.fetch,now=Date.now,signal}={}) {
  const config=parseReadOnlyConfig(structuredClone(input));
  const timeout=AbortSignal.timeout(60000),joined=signal ? AbortSignal.any([signal,timeout]) : timeout;
  const catalogue=new VerifiedCatalogue({relayPublicKey:config.relayPublicKey,publisherKeys:config.publisherKeys,now});
  const source=await catalogue.pull(config.nodeUrl,{fetchImpl,signal:joined});joined.throwIfAborted();
  const candidates=source.candidates.filter(value=>value.chainId===config.request.chainId);
  need(candidates.length>0,'NO_CHAIN_CANDIDATES');
  const readers=config.rpcUrls.map(url=>createReadOnlyRpc(url,{fetchImpl,signal:joined}));
  const session=await openPinnedReadSession({readers,chainId:config.request.chainId,now,signal:joined});
  // Never accept a runtime-code hash from the config or catalogue.
  const observation=await observeLocalPools(session,candidates,config.request);
  const simulations=[],simulationErrors=[];
  if(config.account) for(const pool of observation.pools) {
    try { simulations.push(await simulateObservedPool(observation,pool.routeId,{account:config.account,recipient:config.account})); }
    catch(error){ simulationErrors.push({routeId:pool.routeId,code:safeError(error)}); }
  }
  await recheckObservation(observation);joined.throwIfAborted();
  const comparison=compareObservedPools(observation,{simulations});
  return Object.freeze({schema:'realdex.readonly-report.v1',status:observation.pools.length?'observed-no-execution':'no-verified-pools',
    observation:JSON.parse(observationJson(observation)),catalogue:{relayPublicKey:config.relayPublicKey,candidateCount:candidates.length,rejected:source.rejected},
    simulations,simulationErrors,comparison,executable:false,walletSigning:false,usage:'READ_ONLY_EVIDENCE_NOT_A_TRANSACTION_OR_RELEASE_APPROVAL'});
}
