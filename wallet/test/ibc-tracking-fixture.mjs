import {keyInfo} from '../lib/keys.mjs';
import {validateIbcRoute} from '../bridge/ibc-config.mjs';
import {ibcUser,makeIbcIntent,signIbc} from '../bridge/ibc-codec.mjs';
export function trackingVector(){
 const secret=Buffer.alloc(32,0x31),key=keyInfo('cosmos',secret),account={id:'12345678-1234-1234-1234-123456789abc',family:'cosmos',kind:'local',address:key.address,publicKeyHex:key.publicKeyHex};
 const receiver=keyInfo('cosmos',Buffer.alloc(32,0x32)).address;
 const n=side=>({family:'cosmos',id:'cosmos:realdex-local-track-'+side+'-1',chainId:'realdex-local-track-'+side+'-1',name:'Local '+side,hrp:'cosmos',endpoints:[{rpcUrl:`http://127.0.0.1:${side==='a'?1001:2001}/`,restUrl:`http://127.0.0.1:${side==='a'?1002:2002}/`},{rpcUrl:`http://127.0.0.1:${side==='a'?1003:2003}/`,restUrl:`http://127.0.0.1:${side==='a'?1004:2004}/`}],checkpoint:{height:1,hash:(side==='a'?'AB':'CD').repeat(32)},denom:'stake',decimals:6,symbol:'TEST',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'1000000000',maxFeeAtomic:'1000000',maxGasLimit:'2000000',timeoutBlocks:100,minConfirmations:1,broadcastEnabled:false});
 const route=validateIbcRoute({schema:'realdex.ibc-route.v1',id:'ibc-tracking-a-b',name:'Tracking A B',source:{network:n('a'),channel:'channel-0',connection:'connection-0',client:'07-tendermint-0'},destination:{network:n('b'),channel:'channel-1',connection:'connection-1',client:'07-tendermint-1'},asset:{baseDenom:'stake',originChainId:n('a').chainId,decimals:6,symbol:'TEST'},maxTransferAtomic:'1000000',minTimeoutSeconds:30,maxTimeoutSeconds:600});
 const now=1788650000000,user=ibcUser(route,account,{requestKey:'tracking-vector',receiver,amountAtomic:'1000000',feeAtomic:'50000',gasLimit:'2000000',timeoutSeconds:120});
 const intent=makeIbcIntent(route,account,user,{sourceHead:{height:2},destinationHead:{time:now},account:{accountNumber:'1',sequence:'0'}},now);
 const record={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',intentId:intent.id,requestKey:user.requestKey,paymentHash:intent.payment.paymentHash,accountId:account.id,family:'cosmos',state:'signed',createdAt:now,summary:intent.summary,signed:signIbc(secret,intent.payment)};
 const packet={sequence:'1',source_port:'transfer',source_channel:'channel-0',destination_port:'transfer',destination_channel:'channel-1',timeout_height:{revision_number:'0',revision_height:'0'},timeout_timestamp:intent.payment.timeoutTimestamp,data:Buffer.from(JSON.stringify({denom:'stake',amount:'1000000',sender:account.address,receiver})).toString('base64')};
 return {account,route,record,packet,now,intent};
}
