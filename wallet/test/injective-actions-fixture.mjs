import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
import {createHash} from 'node:crypto';import * as secp from '../vendor/noble-secp256k1.mjs';
import {PrivateStore} from '../lib/storage.mjs';import {Vault} from '../lib/vault.mjs';import {WalletServer} from '../lib/server.mjs';
import {preflightInjectiveLimitOrder as preflight} from '../../node/external/injective-preflight.mjs';import {demoSnapshot,demoInputs,DEMO_MARKET} from '../../node/external/demo.mjs';
import {injectiveIdentity,verifyInjectiveSigned} from '../injective/codec.mjs';import {PASSWORD,KEY,storeFixture} from './fixtures.mjs';
export const CHAIN='injective-888',BLOCK='11'.repeat(32),secret=Buffer.from(KEY,'hex'),PUBLIC=Buffer.from(secp.getPublicKey(secret)).toString('hex'),IDENTITY=injectiveIdentity(PUBLIC),NOW=1788726000000;
function snapshot(now){const s=demoSnapshot('injective',now);s.market.network=CHAIN;for(const a of ['base','quote'])s.market[a].id=s.market[a].id.replace('synthetic-demo',CHAIN);return s;}
export function policy(){return {gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:'500000000000000',maxTradingFeeBps:50,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000};}
export async function chainFixture(t){
 const state={height:100,sequence:0n,accountNumber:'7',sent:0,drop:false,checkTxCode:0,txs:new Map(),calls:[],gasUsed:'200000',gasWanted:'150000000',orders:[],orderHash:'0x'+'ab'.repeat(32),available:'1000000000000000000.75',total:'2000000000000000000.75',bank:'100000000000000000000',gas:'100000000000000000000',mutate:null};const p=policy(),snap=snapshot(NOW),input={requestKey:'owner-order-1',sender:IDENTITY.injectiveAddress,subaccountId:'0x'+Buffer.from((await import('../codec/bech32.mjs')).decodeAccountAddress(IDENTITY.injectiveAddress,'inj')).toString('hex')+'0'.repeat(24),side:'buy',quantity:'1.25',limitPrice:'11'};
 const server=http.createServer(async(req,res)=>{const parts=[];for await(const x of req)parts.push(x);const body=Buffer.concat(parts),url=new URL(req.url,'http://127.0.0.1'),route=url.pathname+url.search;state.calls.push({method:req.method,route,body:body.toString()});const height=req.headers['x-cosmos-block-height'];const headers={'content-type':'application/json',...(height?{'grpc-metadata-x-cosmos-block-height':height}:{})};let out,status=200;
  if(route.includes('/blocks/'))out={block_id:{hash:BLOCK},block:{header:{chain_id:CHAIN,height:route.endsWith('/latest')?String(state.height):route.split('/').at(-1),time:new Date(NOW).toISOString()}}};
  else if(route.includes('/accounts/'))out={account:{'@type':'/injective.types.v1beta1.EthAccount',base_account:{address:IDENTITY.injectiveAddress,pub_key:state.sequence===0n?null:{'@type':'/injective.crypto.v1beta1.ethsecp256k1.PubKey',key:Buffer.from(PUBLIC,'hex').toString('base64')},account_number:state.accountNumber,sequence:String(state.sequence)}}};
  else if(route.includes('/spot/markets/')){const m=demoInputs(NOW).market;out={market:{market_id:DEMO_MARKET,status:'Active',ticker:'DEMO/QUOTE',base_denom:'udemo',quote_denom:'uusdx',base_decimals:'18',quote_decimals:'6',min_price_tick_size:'1',min_quantity_tick_size:'0.01',min_notional:'0.000001',maker_fee_rate:'-0.001',taker_fee_rate:m.takerFeeRate}};}
  else if(route.includes('/spot/orders/'))out={orders:state.orders};
  else if(route.includes('/subaccountDeposit'))out={deposits:{available_balance:state.available,total_balance:state.total}};
  else if(route.includes('/spendable_balances/'))out={balance:{denom:url.searchParams.get('denom'),amount:url.searchParams.get('denom')==='inj'?state.gas:state.bank}};
  else if(route==='/cosmos/tx/v1beta1/simulate')out={gas_info:{gas_wanted:state.gasWanted,gas_used:state.gasUsed},result:{events:[]}};
  else if(route==='/cosmos/tx/v1beta1/txs'&&req.method==='POST'){
    const parsed=JSON.parse(body),raw=Buffer.from(parsed.tx_bytes,'base64'),hash=createHash('sha256').update(raw).digest('hex').toUpperCase();state.sent++;if(state.checkTxCode!==0){out={tx_response:{txhash:hash,code:state.checkTxCode}};}else{state.sequence++;const msgType=(await import('../../node/external/protobuf.mjs'));const f=msgType.fields(raw),bodyFields=msgType.fields(msgType.one(f,1,2)),any=msgType.fields(msgType.one(bodyFields,1,2)),type=msgType.text(any,1);
    if(type.endsWith('MsgCreateSpotLimitOrder'))state.orders=[{price:'11.000000000000000000',quantity:'1.250000000000000000',fillable:'1.000000000000000000',isBuy:true,order_hash:state.orderHash,cid:'rdx-'+createHash('sha256').update(JSON.stringify([CHAIN,IDENTITY.injectiveAddress,'seed-order'])).digest('hex').slice(0,32)}];
    if(type.endsWith('MsgCancelSpotOrder'))state.orders=[];state.txs.set(hash,{tx_response:{txhash:hash,height:String(++state.height),code:0,raw_log:''}});if(state.drop){state.drop=false;req.socket.destroy();return;}out={tx_response:{txhash:hash,code:0}};}
  } else if(route.startsWith('/cosmos/tx/v1beta1/txs/')){const hash=route.split('/').at(-1);if(!state.txs.has(hash)){status=404;out={code:5,message:'not found'};}else out=state.txs.get(hash);}
  else {status=404;out={error:'unknown'};}
  if(state.mutate)state.mutate(out,route,headers);res.writeHead(status,headers);res.end(JSON.stringify(out));
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const endpoint='http://127.0.0.1:'+server.address().port;
 async function review(key='owner-order-1'){const s=structuredClone(snap),i={...input,requestKey:key};return preflight({snapshot:s,input:i,chainId:CHAIN,endpoint,publicKeyHex:PUBLIC,policy:p},{now:()=>NOW});}
 return {state,endpoint,review,input};
}
export async function walletFixture(t,chain){const f=storeFixture(),clock={value:NOW},vault=new Vault(f.store,{now:()=>clock.value});await vault.create(PASSWORD);const account=await vault.addAccount({family:'evm',label:'Dedicated Injective test key',secretHex:KEY});const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);const app=new WalletServer({store:f.store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[]},now:()=>clock.value});const started=await app.start(0);const call=async(route,body={})=>{const r=await fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json'},body:JSON.stringify(body)}),v=await r.json();if(!r.ok)throw Error(v.error);return v;};let closed=false;const shutdown=async()=>{if(!closed){closed=true;await app.close();}};const cleanup=()=>fs.rmSync(f.directory,{recursive:true,force:true});t.after(async()=>{try{await shutdown();}catch{}cleanup();});return {f,clock,vault,account,app,started,call,shutdown,cleanup};}

export const actionPolicy=()=>{const {maxTradingFeeBps,...p}=policy();return p;};
export async function createSource(w,chain){
 const review=await chain.review('seed-order'),p=await w.call('non-evm/injective/prepare',{accountId:w.account.id,review});
 const record=(await w.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:review.reviewSha256,broadcast:false})).record;
 await w.call('non-evm/injective/submit',{id:record.id,confirmation:record.signed.requestId});
 return w.call('non-evm/injective/reconcile',{id:record.id});
}
export function cancelBody(w,chain,source,extra={}){return {accountId:w.account.id,sourceRecordId:source.id,payment:{requestKey:'cancel-one',orderHash:chain.state.orderHash,policy:actionPolicy(),...extra}};}
export function withdrawBody(w,chain,extra={}){return {accountId:w.account.id,payment:{requestKey:'withdraw-one',endpoint:chain.endpoint,subaccountId:chain.input.subaccountId.slice(0,-1)+'1',denom:'udemo',amountAtomic:'500000000000000000',policy:actionPolicy(),...extra}};}
export async function approve(w,p){return (await w.call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:p.summary.reviewSha256,broadcast:false})).record;}
