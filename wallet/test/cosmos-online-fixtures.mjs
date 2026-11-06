/** Synthetic Cosmos state, independent wire parsing and OpenSSL signature verification.
 * The HTTP endpoints share this synthetic state; this is NOT a consensus engine. */
import http from 'node:http';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {keyInfo} from '../lib/keys.mjs';
import {Vault} from '../lib/vault.mjs';
import {WalletServer} from '../lib/server.mjs';
import {storeFixture,PASSWORD} from './fixtures.mjs';
import {validateCosmosNetwork} from '../non-evm/cosmos-network.mjs';
export const sha=b=>createHash('sha256').update(b).digest();
const ok=(v,m)=>{if(!v)throw Error(m);};
function varint(n){n=BigInt(n);const a=[];do{a.push(Number(n&127n)|(n>=128n?128:0));n>>=7n;}while(n);return Buffer.from(a);}
const bytes=(n,b)=>Buffer.concat([varint(n*8+2),varint(b.length),b]);
const num=(n,b)=>BigInt(b)===0n?Buffer.alloc(0):Buffer.concat([varint(n*8),varint(b)]);
function fields(b){let i=0;const out=new Map();function read(){let n=0n;for(let s=0;s<70;s+=7){ok(i<b.length,'short varint');const c=b[i++];n|=BigInt(c&127)<<BigInt(s);if(!(c&128))return n;}throw Error('long varint');}
 while(i<b.length){const tag=read(),f=Number(tag>>3n),w=Number(tag&7n);let x;if(w===0)x=read();else{ok(w===2,'wire');const n=Number(read());ok(n<=16384&&i+n<=b.length,'wire length');x=b.subarray(i,i+n);i+=n;}ok(!out.has(f),'duplicate field');out.set(f,x);}return out;}
const str=(f,n)=>f.get(n)?.toString('utf8')??'';
const int=(f,n)=>String(f.get(n)??0n);
export function decodeCosmos(bytesRaw,chainId,accountNumber,{simulation=false}={}){
 const raw=Buffer.from(bytesRaw),f=fields(raw);ok(f.size===3&&f.has(1)&&f.has(2)&&f.has(3),'TxRaw');
 const body=fields(f.get(1)),any=fields(body.get(1));ok(str(any,1)==='/cosmos.bank.v1beta1.MsgSend','MsgSend only');
 const msg=fields(any.get(2)),coin=fields(msg.get(3)),auth=fields(f.get(2)),signer=fields(auth.get(1)),pubAny=fields(signer.get(1));
 ok(str(pubAny,1)==='/cosmos.crypto.secp256k1.PubKey','secp only');const pub=fields(pubAny.get(2)).get(1),mode=fields(fields(signer.get(2)).get(1));ok(int(mode,1)==='1','direct only');
 const fee=fields(auth.get(2)),feeCoin=fields(fee.get(1));
 const doc=Buffer.concat([bytes(1,f.get(1)),bytes(2,f.get(2)),bytes(3,Buffer.from(chainId)),num(4,accountNumber)]),sig=f.get(3);
 ok(pub.length===33&&sig.length===64,'key signature length');
 if(simulation)ok(sig.equals(Buffer.alloc(64)),'simulation leaked a signature');
 else{const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('3036301006072a8648ce3d020106052b8104000a032200','hex'),pub]),format:'der',type:'spki'});ok(verify('sha256',doc,{key:publicKey,dsaEncoding:'ieee-p1363'},sig),'signature invalid');}
 return {from:str(msg,1),to:str(msg,2),denom:str(coin,1),amountAtomic:str(coin,2),feeDenom:str(feeCoin,1),feeAtomic:str(feeCoin,2),gasLimit:int(fee,2),sequence:int(signer,3),timeoutHeight:int(body,3),memo:str(body,2),pub:pub.toString('base64'),hash:sha(raw).toString('hex').toUpperCase(),raw:raw.toString('base64')};
}
export function cosmosFixtureNetwork(endpoints,overrides={}){return validateCosmosNetwork({family:'cosmos',id:'cosmos:realdex-local-synthetic',name:'SYNTHETIC TEST',chainId:'realdex-local-synthetic',hrp:'cosmos',endpoints,checkpoint:{height:1,hash:'11'.repeat(32)},denom:'stake',decimals:6,symbol:'TEST',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'1000000000',maxFeeAtomic:'100000',maxGasLimit:'1000000',timeoutBlocks:20,minConfirmations:1,broadcastEnabled:true,...overrides});}
export async function cosmosFixture(overrides={}){
 const store=storeFixture(),now={value:Date.now()},vault=new Vault(store.store,{now:()=>now.value});await vault.create(PASSWORD);
 const account=await vault.addAccount({family:'cosmos',label:'PUBLIC TEST KEY',secretHex:'31'.repeat(32)}),to=keyInfo('cosmos',Buffer.alloc(32,0x32)).address;
 const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);
 const state={height:10,sourceBalance:10000000000n,feeBalance:10000000000n,toBalance:100000000n,sequence:'0',accountNumber:'1',publicKey:null,sent:0,simulations:0,signaturesVerified:0,calls:[],record:null,drop:false,hide:false,failed:false,mutate:null,delay:null,omitHeight:false,gasUsed:'65000',nodeSynced:true};
 const headHash=h=>sha(Buffer.from('syntheticblock'+h)).toString('hex').toUpperCase();
 const makeAccount=a=>({account:{'@type':'/cosmos.auth.v1beta1.BaseAccount',address:a,pub_key:a===account.address?state.publicKey:null,account_number:a===account.address?state.accountNumber:'2',sequence:a===account.address?state.sequence:'0'}});
 const servers=[];
 for(let peer=0;peer<2;peer++){
  const server=http.createServer(async(req,res)=>{let chunks=[];for await(const c of req)chunks.push(c);let bytesRaw=Buffer.concat(chunks);const url=new URL(req.url,'http://127.0.0.1'),path=url.pathname,body=bytesRaw.length?JSON.parse(bytesRaw):undefined,info={peer,path,method:body?.method??req.method,body};state.calls.push(info);
   try{if(state.delay)await state.delay(info);let v,status=200;
    if(path==='/'){
     const {id,method,params}=body;let result;
     if(method==='status')result={node_info:{network:'realdex-local-synthetic'},sync_info:{catching_up:!state.nodeSynced,latest_block_height:String(state.height)}};
     else if(method==='block'){const h=Number(params.height),root=state.record&&h===state.record.height?state.record.proof.root_hash:sha(Buffer.alloc(0)).toString('hex').toUpperCase();result={block_id:{hash:h===1?'11'.repeat(32):headHash(h)},block:{header:{chain_id:'realdex-local-synthetic',height:String(h),time:new Date(now.value).toISOString(),data_hash:root,app_hash:headHash(1000+h)}}};}
     else if(method==='tx'){if(!state.record||state.hide||Buffer.from(params.hash,'base64').toString('hex').toUpperCase()!==state.record.hash)throw Error('tx not found');const t=state.record;result={hash:t.hash,height:String(t.height),index:0,tx:t.raw,proof:t.proof,tx_result:{code:state.failed?5:0,gas_used:state.gasUsed,events:[{type:'transfer',attributes:[{key:'sender',value:t.from},{key:'recipient',value:t.to},{key:'amount',value:t.amountAtomic+t.denom}]}]}};}
     else throw Error('unknown comet method');v={jsonrpc:'2.0',id,result};
    }else if(path.includes('/accounts/'))v=makeAccount(path.split('/').at(-1));
    else if(path.includes('/spendable_balances/')){const denom=url.searchParams.get('denom'),a=path.split('/')[5];v={balance:{denom,amount:String(a===account.address?(denom==='stake'?state.sourceBalance:state.feeBalance):state.toBalance)}};}
    else if(path.endsWith('/simulate')){const t=decodeCosmos(Buffer.from(body.tx_bytes,'base64'),'realdex-local-synthetic',state.accountNumber,{simulation:true});ok(t.sequence===state.sequence,'simulation sequence');state.simulations++;v={gas_info:{gas_used:state.gasUsed,gas_wanted:t.gasLimit},result:{events:[]}};}
    else if(path.endsWith('/txs')){ok(body.mode==='BROADCAST_MODE_SYNC','mode');const t=decodeCosmos(Buffer.from(body.tx_bytes,'base64'),'realdex-local-synthetic',state.accountNumber);ok(t.sequence===state.sequence&&t.from===account.address,'sequence/from');ok(BigInt(t.timeoutHeight)>BigInt(state.height),'expired');state.sent++;state.signaturesVerified++;state.sequence=String(BigInt(state.sequence)+1n);state.publicKey={'@type':'/cosmos.crypto.secp256k1.PubKey',key:t.pub};state.height++;
     state.sourceBalance-=BigInt(t.amountAtomic)+(t.feeDenom===t.denom?BigInt(t.feeAtomic):0n);if(t.feeDenom!==t.denom)state.feeBalance-=BigInt(t.feeAtomic);state.toBalance+=BigInt(t.amountAtomic);
     const leaf=sha(Buffer.concat([Buffer.from([0]),Buffer.from(t.hash,'hex')]));state.record={...t,height:state.height,proof:{root_hash:leaf.toString('hex').toUpperCase(),data:t.raw,proof:{total:'1',index:'0',leaf_hash:leaf.toString('base64'),aunts:[]}}};if(state.drop){req.socket.destroy();return;}v={tx_response:{txhash:t.hash,code:0}};
    }else throw Error('unknown rest path');
    v=structuredClone(v);if(state.mutate)v=state.mutate(v,info)??v;
    const headers={'content-type':'application/json'};if(req.headers['x-cosmos-block-height']&&!state.omitHeight)headers['x-cosmos-block-height']=req.headers['x-cosmos-block-height'];res.writeHead(status,headers);res.end(JSON.stringify(v));
   }catch(e){if(res.destroyed)return;res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({fixtureError:e.message}));}
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
 }
 const urls=servers.map(s=>`http://127.0.0.1:${s.address().port}/`),network=cosmosFixtureNetwork(urls.map(u=>({rpcUrl:u,restUrl:u})),overrides);
 const app=new WalletServer({store:store.store,vault,settings:{schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[],cosmosNetworks:[network]},now:()=>now.value});const started=await app.start(0);
 const request=(route,body={},headers={})=>fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 const call=async(route,body={})=>{const r=await request(route,body),v=await r.json();if(!r.ok)throw Error(v.error);return v;};
 const payment=(extra={})=>({requestKey:'cosmos-payment',to,amountAtomic:'1000000',feeAtomic:'500',gasLimit:'200000',memo:'',...extra});
 const prepare=(extra={})=>call('non-evm/cosmos-online/prepare',{accountId:account.id,networkId:network.id,payment:payment(extra)});
 const approve=async(p,broadcast=false)=>(await call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:to,broadcast})).record;
 const reconcile=r=>call('non-evm/cosmos-online/reconcile',{id:r.id});
 const close=async()=>{await app.close();await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));store.close();};
 return {state,now,account,to,network,vault,app,store,started,request,call,payment,prepare,approve,reconcile,close};
}
