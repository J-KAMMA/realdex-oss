/** Disposable single-node diagnostic chain. No peer discovery, public orders or imported keys. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';
import {spawn,spawnSync} from 'node:child_process';import {createHash,randomBytes} from 'node:crypto';
import * as secp from '../../wallet/vendor/noble-secp256k1.mjs';
import {signDigest} from '../../wallet/lib/keys.mjs';
import {accountAddress} from '../../wallet/codec/bech32.mjs';import {keccak256} from '../../node/verified/keccak.mjs';
import {fieldBytes as bytes,fieldText as text,fieldUint as num,anyMessage} from '../../wallet/codec/protobuf.mjs';
const PIN=JSON.parse(fs.readFileSync(new URL('./pin.json',import.meta.url)));
const sha=x=>createHash('sha256').update(x).digest('hex');
export async function waitFor(fn,timeout=30000){let last;for(const end=Date.now()+timeout;Date.now()<end;){try{const x=await fn();if(x)return x;}catch(e){last=e;}await new Promise(r=>setTimeout(r,100));}throw last??Error('INJ_LOCAL_TIMEOUT');}
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;}
export function verifiedRuntime(directory){
 if(process.platform!=='linux'||process.arch!=='x64'||typeof directory!=='string')throw Error('INJ_LOCAL_RUNTIME_REQUIRED');
 const p=path.resolve(directory);if(fs.realpathSync(p)!==p)throw Error('INJ_LOCAL_RUNTIME_PATH');
 for(const [name,pin] of Object.entries(PIN.files)){const file=path.join(p,name),s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==pin.bytes||sha(fs.readFileSync(file))!==pin.sha256)throw Error('INJ_LOCAL_RUNTIME_HASH');}
 return p;
}
export async function startInjective({actorSecretHexes=[]}={}){
 if(!Array.isArray(actorSecretHexes)||actorSecretHexes.length>3||actorSecretHexes.some(x=>typeof x!=='string'||!/^[0-9a-f]{64}$/.test(x)))throw Error('INJ_LOCAL_ACTOR_SECRETS');
 const tools=verifiedRuntime(process.env.REALDEX_INJECTIVE_DIRECTORY),binary=path.join(tools,'injectived'),home=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-injective-'));
 const env={PATH:process.env.PATH,HOME:home,LANG:'C.UTF-8',LD_LIBRARY_PATH:tools,GOMAXPROCS:'2'},chainId='injective-888';
 let child,fd;const actors=[];
 function run(args){const p=spawnSync(binary,[...args,'--home',home],{env,encoding:'utf8',timeout:30000,maxBuffer:4194304,shell:false});if(p.status!==0)throw Error('INJ_SETUP_FAILED '+args.slice(0,3).join(' ')+' '+p.stderr.slice(-1800));return p.stdout;}
 const close=async()=>{if(child&&child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');try{await waitFor(()=>child.exitCode!==null||child.signalCode!==null,8000);}catch{child.kill('SIGKILL');await waitFor(()=>child.exitCode!==null||child.signalCode!==null,5000);}}if(fd!==undefined){fs.closeSync(fd);fd=undefined;}for(const a of actors)a.secret.fill(0);fs.rmSync(home,{recursive:true,force:true});};
 try{
 run(['init','realdex-isolated-diagnostic','--chain-id',chainId]);
 const gfile=path.join(home,'config/genesis.json'),g=JSON.parse(fs.readFileSync(gfile)),a=g.app_state;
 a.staking.params.bond_denom='inj';a.crisis.constant_fee.denom='inj';a.mint.params.mint_denom='inj';
 for(const kind of ['min_deposit','expedited_min_deposit'])a.gov.params[kind][0].denom='inj';
 a.txfees.params.mempool1559_enabled=false;a.exchange.denom_min_notionals=[{denom:'uquote',min_notional:'1'}];a.exchange.auction_exchange_transfer_denom_decimals=[{denom:'inj',decimals:'18'},{denom:'ubase',decimals:'18'},{denom:'uquote',decimals:'6'}];g.consensus.params.block.max_gas='150000000';
 fs.writeFileSync(gfile,JSON.stringify(g));
 const validator=JSON.parse(run(['keys','add','validator','--no-backup','--keyring-backend','test','--output','json']));
 const configured=JSON.parse(fs.readFileSync(gfile));configured.app_state.exchange.params.exchange_admins=[validator.address];fs.writeFileSync(gfile,JSON.stringify(configured));
 run(['genesis','add-genesis-account',validator.address,'100000000000000000000000inj','--chain-id',chainId]);
 run(['genesis','gentx','validator','1000000000000000000000inj','--chain-id',chainId,'--keyring-backend','test']);run(['genesis','collect-gentxs']);
 for(let i=0;i<3;i++){
  const secret=actorSecretHexes[i]===undefined?randomBytes(32):Buffer.from(actorSecretHexes[i],'hex'),publicKeyHex=Buffer.from(secp.getPublicKey(secret)).toString('hex'),raw=Buffer.from(keccak256(secp.getPublicKey(secret,false).slice(1)).slice(-40),'hex'),address=accountAddress('inj',raw);
  const actor={secret,publicKeyHex,address,subaccountId:'0x'+raw.toString('hex')+'0'.repeat(24)};actors.push(actor);
  run(['genesis','add-genesis-account',address,'10000000000000000000000inj,1000000000000000000000ubase,1000000000000uquote','--chain-id',chainId]);
 }
 const [rpcPort,restPort,p2pPort]=await Promise.all([port(),port(),port()]);
 const config=path.join(home,'config/config.toml');let s=fs.readFileSync(config,'utf8');s=s.replace('tcp://127.0.0.1:26657',`tcp://127.0.0.1:${rpcPort}`).replace('tcp://0.0.0.0:26656',`tcp://127.0.0.1:${p2pPort}`).replace('pex = true','pex = false').replace('pprof_laddr = "localhost:6060"','pprof_laddr = ""');fs.writeFileSync(config,s);
 fd=fs.openSync(path.join(home,'runtime.log'),'w',0o600);
 child=spawn(binary,['start','--home',home,'--chain-id',chainId,'--api.enable','--api.address',`tcp://127.0.0.1:${restPort}`,'--api.enabled-unsafe-cors=false','--grpc.enable=false','--grpc-web.enable=false','--json-rpc.enable=false','--minimum-gas-prices','1inj','--log-level','error'],{env,stdio:['ignore',fd,fd],shell:false});
 const rpc=`http://127.0.0.1:${rpcPort}`,rest=`http://127.0.0.1:${restPort}`;
 const get=async route=>{const r=await fetch(rest+route,{signal:AbortSignal.timeout(5000)}),v=await r.json();if(!r.ok)throw Error('INJ_LOCAL_HTTP '+JSON.stringify(v));return v;};
 await waitFor(async()=>{if(child.exitCode!==null||child.signalCode!==null)throw Error('INJ_NODE_EXIT '+fs.readFileSync(path.join(home,'runtime.log'),'utf8').slice(-3500));const r=await fetch(rpc+'/status',{signal:AbortSignal.timeout(1000)});return Number((await r.json()).result.sync_info.latest_block_height)>=3;});
 const included=hash=>waitFor(async()=>{const v=await get('/cosmos/tx/v1beta1/txs/'+hash);return Number(v.tx_response?.height)>0?v.tx_response:false;});
 const launch=JSON.parse(run(['tx','exchange','instant-spot-market-launch','BASE/QUOTE','ubase','uquote','--min-price-tick-size','0.01','--min-quantity-tick-size','0.01','--min-notional','1','--base-decimals','18','--quote-decimals','6','--from','validator','--keyring-backend','test','--chain-id',chainId,'--node',rpc,'--fees','1000000000000000inj','--gas','1000000','--yes','--output','json']));
 if(launch.code!==0)throw Error('INJ_MARKET_CHECKTX '+launch.raw_log);const launched=await included(launch.txhash);if(launched.code!==0)throw Error('INJ_MARKET_DELIVERTX '+launched.raw_log);
 const cancelBoot=JSON.parse(run(['tx','exchange','cancel-post-only-mode','--from','validator','--keyring-backend','test','--chain-id',chainId,'--node',rpc,'--fees','1000000000000000inj','--gas','1000000','--yes','--output','json']));if(cancelBoot.code!==0)throw Error('INJ_SETUP_POST_ONLY');const bootReceipt=await included(cancelBoot.txhash);if(bootReceipt.code!==0)throw Error('INJ_SETUP_POST_ONLY '+bootReceipt.raw_log);
 const markets=await get('/injective/exchange/v1beta1/spot/markets');const market=markets.markets.find(m=>m.base_denom==='ubase'&&m.quote_denom==='uquote');if(!market)throw Error('INJ_MARKET_MISSING');
 async function broadcast(raw){const r=await fetch(rest+'/cosmos/tx/v1beta1/txs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx_bytes:Buffer.from(raw).toString('base64'),mode:'BROADCAST_MODE_SYNC'}),signal:AbortSignal.timeout(10000)});return r.json();}
 function sign(transaction,index=0,{sha256Instead=false}={}){const actor=actors[index];if(!actor)throw Error('INJ_LOCAL_ACTOR');const digest=sha256Instead?createHash('sha256').update(Buffer.from(transaction.signDocBase64,'base64')).digest():Buffer.from(keccak256(Buffer.from(transaction.signDocBase64,'base64')).slice(2),'hex'),sig=signDigest(actor.secret,digest);return Buffer.concat([bytes(1,Buffer.from(transaction.bodyBytesBase64,'base64')),bytes(2,Buffer.from(transaction.authInfoBytesBase64,'base64')),bytes(3,Buffer.concat([sig.toCompactRawBytes(),Buffer.from([sig.recovery])]))]);}
 return {home,chainId,rpc,rest,get,market,included,broadcast,sign,close,actors:actors.map(({secret,...publicPart})=>publicPart),launch:launched,bootReceipt,version:run(['version']).trim(),genesisSha256:sha(fs.readFileSync(gfile))};
 }catch(e){await close();throw e;}
}

// This adapter maps REAL on-chain v2 market/book observations into the existing
// legacy indexer atom representation. It does not emulate an independent indexer.
import {injectiveMarket,normalizeBook} from '../../node/external/market.mjs';
import {decimal,shift} from '../../node/external/math.mjs';
export function decimalText(r){let d=r.d,k=0;while(d>1n&&d%10n===0n){d/=10n;k++;}
 // Reduced denominators can include powers of two/five other than ten.
 if(d!==1n){for(k=0;k<=72;k++)if((10n**BigInt(k))%r.d===0n)break;}
 if(k>72)throw Error('INJ_LOCAL_DECIMAL');const n=r.n*10n**BigInt(k)/r.d,s=n.toString().padStart(k+1,'0');return k?s.slice(0,-k)+'.'+s.slice(-k):s;
}
export async function orderRequest(chain,index,{side='sell',quantity='2',limitPrice='11',requestKey='local-order',subaccountId}={}){
 const m=(await chain.get('/injective/exchange/v2/spot/markets/'+chain.market.market_id)).market;
 const book=await chain.get('/injective/exchange/v2/spot/orderbook/'+m.market_id+'?limit=20');
 const scale=(v,p)=>decimalText(shift(decimal(v),p));
 const market=injectiveMarket({marketId:m.market_id,marketStatus:'active',ticker:m.ticker,baseDenom:m.base_denom,quoteDenom:m.quote_denom,
 baseTokenMeta:{symbol:'BASE',decimals:m.base_decimals},quoteTokenMeta:{symbol:'QUOTE',decimals:m.quote_decimals},takerFeeRate:m.taker_fee_rate,
 minPriceTickSize:scale(m.min_price_tick_size,m.quote_decimals-m.base_decimals),minQuantityTickSize:scale(m.min_quantity_tick_size,m.base_decimals),minNotional:scale(m.min_notional,m.quote_decimals)},chain.chainId,m.market_id);
 const level=xs=>xs.map(x=>({price:scale(x.p,m.quote_decimals-m.base_decimals),quantity:scale(x.q,m.base_decimals)}));
 const now=Date.now(),snapshot=normalizeBook(market,{buys:level(book.buys_price_level??[]),sells:level(book.sells_price_level??[]),timestamp:String(now),height:'0',sequence:'0'},{receivedAt:now});
 snapshot.evidence='local-node-v2-market-and-book; no independent indexer or book sequence';
 const actor=chain.actors[index];return {snapshot,input:{requestKey,sender:actor.address,subaccountId:subaccountId??actor.subaccountId,side,quantity,limitPrice},chainId:chain.chainId,endpoint:chain.rest,publicKeyHex:actor.publicKeyHex,
 policy:{gasLimit:'1000000',gasPriceAtomic:'500000000',maxGasFeeAtomic:'500000000000000',maxTradingFeeBps:50,gasMarginBps:12500,timeoutBlocks:40,maxAgeMs:30000}};
}
/** Only test setup's fixed cancel/deposit/withdraw messages; never used by the wallet. */
export async function localTransaction(chain,index,message){
 if(!['/injective.exchange.v1beta1.MsgCancelSpotOrder','/injective.exchange.v1beta1.MsgDeposit','/injective.exchange.v1beta1.MsgWithdraw'].includes(message.typeUrl))throw Error('INJ_LOCAL_MESSAGE');
 const actor=chain.actors[index],account=(await chain.get('/cosmos/auth/v1beta1/accounts/'+actor.address)).account.base_account;
 const latest=await chain.get('/cosmos/base/tendermint/v1beta1/blocks/latest');const height=BigInt((latest.block??latest.sdk_block).header.height)+40n;
 const body=Buffer.concat([bytes(1,Buffer.from(message.anyBase64,'base64')),num(3,height)]),coin=Buffer.concat([text(1,'inj'),text(2,'500000000000000')]);
 const pub=anyMessage('/injective.crypto.v1beta1.ethsecp256k1.PubKey',bytes(1,Buffer.from(actor.publicKeyHex,'hex')));
 const signer=Buffer.concat([bytes(1,pub),bytes(2,bytes(1,num(1,1n))),num(3,BigInt(account.sequence))]);
 const auth=Buffer.concat([bytes(1,signer),bytes(2,Buffer.concat([bytes(1,coin),num(2,1000000n)]))]);
 const signDoc=Buffer.concat([bytes(1,body),bytes(2,auth),text(3,chain.chainId),num(4,BigInt(account.account_number))]);
 return {bodyBytesBase64:body.toString('base64'),authInfoBytesBase64:auth.toString('base64'),signDocBase64:signDoc.toString('base64')};
}
export function movement(chain,index,kind,subaccountId,amount){
 if(!['Deposit','Withdraw'].includes(kind)||!/^0x[0-9a-f]{64}$/.test(subaccountId)||!/^\d+$/.test(amount))throw Error('INJ_LOCAL_MOVEMENT');
 const typeUrl='/injective.exchange.v1beta1.Msg'+kind;
 const value=Buffer.concat([text(1,chain.actors[index].address),text(2,subaccountId),bytes(3,Buffer.concat([text(1,'ubase'),text(2,amount)]))]);
 return {typeUrl,anyBase64:anyMessage(typeUrl,value).toString('base64')};
}
