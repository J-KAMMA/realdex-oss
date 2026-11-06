#!/usr/bin/env node
/** Disposable chain pair and independent fee keys. Never connects to public chains. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {ibcWalletFixture} from './wallet-fixture.mjs';import {until} from './devnet.mjs';
import {RelayVault} from '../../relay/store.mjs';import {RelayWorker} from '../../relay/engine.mjs';
import {POLICY_SCHEMA,relayNetworks} from '../../relay/policy.mjs';import {PASSWORD as WALLET_PASSWORD} from '../../wallet/test/fixtures.mjs';
import {need,safeError} from '../../wallet/lib/guard.mjs';
let f,v,w,dir;
try{
 f=await ibcWalletFixture();dir=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-relay-demo-'));
 const routes=[f.route],policy={schema:POLICY_SCHEMA,mode:'local-development',routes,fees:relayNetworks({routes}).map(n=>({networkId:n.id,feeAtomic:'50000',gasLimit:'5000000',maxTotalFeeAtomic:'100000',maxTransactions:2})),maxJobs:4,intervalMs:1000,expiresAt:Date.now()+3600000};
 v=new RelayVault(dir);await v.create(policy,'Disposable demonstration relay password');
 for(const k of v.publicState().keys){const c=k.networkId===f.route.source.network.id?f.a:f.b;await c.tx([{'@type':'/cosmos.bank.v1beta1.MsgSend',from_address:c.relay,to_address:k.address,amount:[{denom:'stake',amount:'100000'}]}]);}
 const p=await f.call('ibc/prepare',{routeId:f.route.id,accountId:f.accounts[0].id,payment:f.payment(f.accounts[1].address,{requestKey:'independent-relay-demo'})});
 const record=(await f.call('ibc/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.confirmationText,broadcast:true})).record,id=v.enqueue(f.route.id,record.signed.requestId);
 await f.call('lock');w=new RelayWorker(v);w.start();
 await until(async()=>{await w.tick();const j=v.data.jobs.find(j=>j.id===id);need(j.status!=='blocked','RELAY_DEMO_BLOCKED');return j.status==='settled-observed';},60000);
 const walletStayedLocked=f.vault.status().locked;await f.vault.unlock(WALLET_PASSWORD);const result=await f.call('ibc/track',{id:record.id});need(result.report.received,'RELAY_DEMO_NOT_OBSERVED');
 console.log(JSON.stringify({schema:'realdex.relay-demo.v1',separateChains:2,validatorsPerChain:1,walletStayedLocked,receivedAtomic:record.summary.amountAtomic,relayActions:v.publicState().actions.map(a=>({kind:a.kind,txHash:a.txHash,state:a.state,feeAtomic:a.feeAtomic})),budgets:v.publicState().budgets,assetWalletAccess:false,desktopFinalityProven:false,productionReady:false},null,2));
}catch(e){console.error(safeError(e));process.exitCode=1;}
finally{w?.interrupt();v?.close();await f?.close();if(dir)fs.rmSync(dir,{recursive:true,force:true});}
