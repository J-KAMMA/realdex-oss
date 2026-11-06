import {observeIcrcLedger,createIcrcReader,observeExtended,privateEvmProfile,quoteIcrcPool,transferIntent,newSettlementRecord,advanceSettlement,screenRoute,extendedRegistry} from '../extended/index.mjs';
import type {RouteClaim,IcpNetwork} from '../extended/index.mjs';
const id='ryjl3-tyaaa-aaaaa-aaaba-cai',id2='mxzaz-hqaaa-aaaar-qaada-cai';
const p=privateEvmProfile({slug:'lab',chainId:'9007199254740992',genesisHash:'a'.repeat(64)});
const r=await observeExtended({profile:p,endpoints:['http://127.0.0.1:8545']});const execution:false=r.executable;
const m=await observeIcrcLedger({network:'icp:mainnet',ledger:id,endpoints:['http://127.0.0.1:4943']});const proof:false=m.assurance.certifiedLedgerState;
const reader=createIcrcReader({network:'icp:mainnet',ledger:id,endpoint:'http://127.0.0.1:4943'});const f:string=await reader.query('icrc1_fee');const d:number=await reader.query('icrc1_decimals');
const q=quoteIcrcPool({network:'icp:mainnet',ledgerIn:id,ledgerOut:id2,reserveInAtomic:'1000000',reserveOutAtomic:'1000000',inputBudgetAtomic:'100000',inputTransferFeeAtomic:f,outputTransferFeeAtomic:'10',poolFeeBps:30,slippageBps:50});const modelOnly:true=q.modelOnly;
const i=await transferIntent({network:'icp:mainnet',ledger:id,from:{owner:'2vxsx-fae'},to:{owner:id2},amountAtomic:'10000',feeAtomic:f,memoHex:'00'.repeat(32),createdAtTimeNs:1n});const s=advanceSettlement(newSettlementRecord(i),{intentId:i.id,kind:'begin'});const unverified:false=s.settlementVerified;
const claim:RouteClaim={id:'x',amountInAtomic:'10',minimumOutAtomic:'9',additionalCostOutAtomic:null,expiresAt:Date.now()+10000,steps:[{id:'s',kind:'swap',from:{networkId:'x:y',assetKey:'a',visibility:'shielded'},to:{networkId:'x:y',assetKey:'b',visibility:'shielded'},disclosure:'none'}]};const route=screenRoute(claim,{inputAssetKey:'a',outputAssetKey:'b',amountInAtomic:'10'});const stillFalse:false=route.executable;
// @ts-expect-error There is no transaction send method in the read-only API.
await reader.query('icrc1_transfer');
// @ts-expect-error EVM is not an ICP ledger namespace.
const bad:IcpNetwork='eip155:1';
// @ts-expect-error Ledger success responses cannot be promoted to verified authority.
const mustNotBeTrue:true=s.settlementVerified;
void [execution,proof,d,modelOnly,unverified,stillFalse,bad,mustNotBeTrue,extendedRegistry];
