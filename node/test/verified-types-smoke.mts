// Compile-only API contract. Does not authenticate data, deploy or execute a transaction.
import {createReadOnlyRpc,openPinnedReadSession,PinnedReadSession} from '../verified/rpc.mjs';
import {observeLocalPools,compareObservedPools,planObservedGrossSplit,parseDiscoveryRequest,type PoolObservation} from '../verified/evm.mjs';
import {VerifiedCatalogue} from '../verified/catalogue.mjs';
import {runReadOnlyRequest,type ReadOnlyConfig} from '../verified/workflow.mjs';
const reader=createReadOnlyRpc('https://read-only.example');
await reader.send('eth_chainId',[]);
// @ts-expect-error the API cannot express transaction submission
await reader.send('eth_sendRawTransaction',['0x']);
// @ts-expect-error only a verified open function can issue a session
new PinnedReadSession();
const session=await openPinnedReadSession({readers:[reader,createReadOnlyRpc('https://second.example')],chainId:'eip155:84532'});
const request=parseDiscoveryRequest({requestId:'type-check',chainId:'eip155:84532',tokenIn:'0x'+'1'.repeat(40),tokenOut:'0x'+'2'.repeat(40),amountIn:100n,slippageBps:50,feeTiers:[5]});
// @ts-expect-error amounts cannot be Number
parseDiscoveryRequest({...request,amountIn:100});
const catalogue=new VerifiedCatalogue({relayPublicKey:'0'.repeat(64),publisherKeys:['0'.repeat(64)]});
const c=await catalogue.pull('http://127.0.0.1:8787');
const observation=await observeLocalPools(session,c.candidates,request);
const readOnly:false=observation.executable;
// @ts-expect-error observation data is immutable
observation.pools[0].minimumOut=1n;
// @ts-expect-error untrusted plain data cannot structurally impersonate issued evidence
const forged:PoolObservation={schema:'realdex.pool-observation.v1',request};
const ranked=compareObservedPools(observation);const noGuarantee:false=ranked.futureFeeGuarantee;
const gross=planObservedGrossSplit(observation);const notNet:false=gross.netOptimality;
// @ts-expect-error former boolean does not count as bound fee evidence
compareObservedPools(observation,{additionalNetworkFeesComplete:true});
const config:ReadOnlyConfig={schema:'realdex.readonly-request.v1',nodeUrl:'http://127.0.0.1:8787',relayPublicKey:'0'.repeat(64),publisherKeys:['0'.repeat(64)],rpcUrls:['https://one.example','https://two.example'],request:{...request,amountIn:'100'},account:null};
const report=await runReadOnlyRequest(config);const decimal:string=report.observation.request.amountIn;
void readOnly;void noGuarantee;void notNet;void decimal;void forged;

import {deriveCreate2Address,deriveLocalPoolAddress} from '../verified/create2.mjs';
const derived=deriveLocalPoolAddress({chainId:'eip155:84532',factory:'0x'+'a'.repeat(40),tokenA:request.tokenIn,tokenB:request.tokenOut,feeBps:5,poolCreationCode:'0x00'});
const stillUnproven:false=derived.creationCodeAuthenticated;const notDeployed:false=derived.deploymentProven;
const derivedAddress:string=deriveCreate2Address('0x'+'0'.repeat(40),'0x'+'0'.repeat(64),'0x00');
void stillUnproven;void notDeployed;void derivedAddress;
