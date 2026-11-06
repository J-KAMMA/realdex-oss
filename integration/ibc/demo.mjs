#!/usr/bin/env node
/** Disposable real IBC two-chain demo. No mainnet RPC, no user keys, no background service. */
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {receivePacket,acknowledgePacket,timeoutPacket,until} from './devnet.mjs';
import {routeAssets} from '../../wallet/bridge/ibc-config.mjs';
let f;
try{
 f=await ibcWalletFixture(process.env.REALDEX_IBC_LOG_DIRECTORY);
 const a=f.accounts[0],b=f.accounts[1],denom=routeAssets(f.route).destinationDenom,initial={source:String(await f.a.balance(a.address)),destinationVoucher:String(await f.b.balance(b.address,denom))};
 const bridge=async(reverse,key)=>{const route=reverse?f.reverse:f.route,account=reverse?b:a,receiver=reverse?a:b;
  const p=await f.call('ibc/prepare',{routeId:route.id,accountId:account.id,payment:f.payment(receiver.address,{requestKey:key})});
  const r=(await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true})).record;
  const source=await until(async()=>{const x=await f.call('ibc/reconcile',{id:r.id});return x.report.packet?x:false;});
  const from=reverse?f.b:f.a,to=reverse?f.a:f.b,dc=reverse?f.lane.aClient:f.lane.bClient,sc=reverse?f.lane.bClient:f.lane.aClient;
  const d=await receivePacket(from,to,dc,source.report.packet),s=await acknowledgePacket(from,to,sc,source.report.packet,d.acknowledgement);
  const out=await f.call('ibc/reconcile',{id:r.id,destinationTxHash:d.result.hash,settlementTxHash:s.hash});if(!out.report.received)throw Error(out.report.reason);return out;};
 const outbound=await bridge(false,'demo-outbound');const afterOutbound={source:String(await f.a.balance(a.address)),destinationVoucher:String(await f.b.balance(b.address,denom))};
 const returned=await bridge(true,'demo-return');const afterReturn={source:String(await f.a.balance(a.address)),destinationVoucher:String(await f.b.balance(b.address,denom))};
 const p=await f.call('ibc/prepare',{routeId:f.route.id,accountId:a.id,payment:f.payment(b.address,{requestKey:'demo-timeout',timeoutSeconds:30})});
 const r=(await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true})).record;
 const src=await until(async()=>{const x=await f.call('ibc/reconcile',{id:r.id});return x.report.packet?x:false;});
 await until(async()=>{const h=await f.b.head(),x=await f.b.rpc('block',{height:String(h)});return BigInt(Date.parse(x.block.header.time))*1000000n>=BigInt(src.report.packet.timeout_timestamp);},45000);
 const elapsed=await f.call('ibc/reconcile',{id:r.id});if(elapsed.report.refunded)throw Error('FALSE_TIMEOUT_REFUND');
 const timeout=await timeoutPacket(f.a,f.b,f.lane.aClient,src.report.packet);const refunded=await f.call('ibc/reconcile',{id:r.id,settlementTxHash:timeout.hash});if(!refunded.report.refunded)throw Error(refunded.report.reason);
 const duplicate=await f.call('ibc/prepare',{routeId:f.route.id,accountId:a.id,payment:f.payment(b.address,{requestKey:'demo-timeout',timeoutSeconds:30})});if(!duplicate.alreadyRecorded)throw Error('IDEMPOTENCY_FAILED');
 console.log(JSON.stringify({schema:'realdex.ibc-demo.v1',success:true,separateChains:2,validatorsPerChain:1,asset:'stake (worthless local test asset)',amountAtomic:'1000000',sourceFeeAtomic:'50000',initial,afterOutbound,afterReturn,afterRefund:{source:String(await f.a.balance(a.address)),destinationVoucher:String(await f.b.balance(b.address,denom))},stages:[outbound.report.stage,returned.report.stage,elapsed.report.stage,refunded.report.stage],duplicateSubmittedAgain:duplicate.submittedAgain,desktopFinalityProven:false,productionReady:false},null,2));
}catch(e){console.error('IBC_DEMO_FAILED: '+e.message);process.exitCode=1;}finally{await f?.close();}
