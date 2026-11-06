import type {AccountNetwork,AccountOnlinePrepare,AccountOnlineReport} from '../non-evm/account-api.js';
const network: AccountNetwork = {
 family:'stellar',id:'stellar:standalone',name:'Development',rpcUrls:['http://127.0.0.1:8000/','http://127.0.0.1:8001/'],
 checkpoint:{height:1,hash:'11'.repeat(32)},broadcastEnabled:false,maxTransferAtomic:'10000000',
 maxFeeAtomic:'1000',minConfirmations:1,networkPassphrase:'Standalone Network ; February 2017'
};
const prepare: AccountOnlinePrepare={accountId:'id',networkId:network.id,payment:{requestKey:'payment',to:'G…',amount:'0.1',feeAtomic:'100'}};
const report: AccountOnlineReport={observedAt:0,received:false,reason:'pending',assurance:'RPC observation only; no consensus/finality proof',finalityProven:false};
void [prepare,report];
