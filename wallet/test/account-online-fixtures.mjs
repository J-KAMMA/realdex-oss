/**
 * SYNTHETIC ledger API. Real Ed25519 verification, synthetic ledger application.
 * Both HTTP endpoints share one state. This is not a Stellar/Aptos VM or consensus.
 */
import http from 'node:http';
import {createHash,createPublicKey,verify} from 'node:crypto';
import {keyInfo} from '../lib/keys.mjs';
import {stellarAddress} from '../codec/strkey.mjs';
import {Vault} from '../lib/vault.mjs';
import {WalletServer} from '../lib/server.mjs';
import {storeFixture,PASSWORD} from './fixtures.mjs';
import {validateAccountNetwork} from '../non-evm/account-network.mjs';
import {STELLAR_LOCAL_PASSPHRASE} from '../non-evm/stellar-offline.mjs';
const sha=(s,a='sha256')=>createHash(a).update(s).digest();
const publicKey=b=>createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),b]),type:'spki',format:'der'});
const decimal=(s,d)=>{s=String(s).padStart(d+1,'0');return s.slice(0,-d)+'.'+s.slice(-d);};
const assert=(v,m)=>{if(!v)throw Error(m);};
function decodeStellar(bytes,passphrase){
  let pos=0;const take=n=>{const v=bytes.subarray(pos,pos+n);assert(v.length===n,'short');pos+=n;return v;};
  const u32=()=>take(4).readUInt32BE(),i64=()=>take(8).readBigUInt64BE();
  const account=()=>{assert(u32()===0,'mux unsupported');return stellarAddress(take(32));};
  assert(u32()===2,'envelope');const start=pos,from=account(),fee=i64; // fee is u32, not i64
  const feeAtomic=String(u32()),sequence=String(i64());assert(u32()===1,'bounds');assert(i64()===0n,'min');
  const maxTime=String(i64()),memoType=u32();let memo='';
  if(memoType===1){const n=u32();memo=take(n).toString('utf8');take((4-n%4)%4);}else assert(memoType===0,'memo');
  assert(u32()===1&&u32()===0&&u32()===1,'operation');
  const to=account();assert(u32()===0,'native only');const amountAtomic=String(i64());assert(u32()===0,'ext');const end=pos;
  assert(u32()===1,'one signature');const hint=take(4);assert(u32()===64,'sig size');const sig=take(64);assert(pos===bytes.length,'trailing');
  const tx=bytes.subarray(start,end),pub=bytes.subarray(8,40);assert(hint.equals(pub.subarray(-4)),'hint');
  const hash=sha(Buffer.concat([sha(Buffer.from(passphrase)),Buffer.from([0,0,0,2]),tx]));
  assert(verify(null,hash,publicKey(pub),sig),'signature');
  return {from,to,amountAtomic,feeAtomic,sequence,maxTime,memo,hash:hash.toString('hex'),envelope:bytes.toString('base64')};
}
function decodeAptos(bytes,simulation=false){
  let pos=0;const take=n=>{const v=bytes.subarray(pos,pos+n);assert(v.length===n,'short');pos+=n;return v;};
  const byte=()=>take(1)[0],u64=()=>String(take(8).readBigUInt64LE()),blob=()=>take(byte()),address=()=> '0x'+take(32).toString('hex');
  const from=address(),sequence=u64();assert(byte()===2,'payload');
  assert(address()==='0x'+'0'.repeat(63)+'1'&&blob().toString()==='aptos_account'&&blob().toString()==='transfer','function');
  assert(byte()===0&&byte()===2,'typeargs args');const to='0x'+blob().toString('hex'),amount=blob();assert(amount.length===8,'u64 amount');
  const amountAtomic=String(amount.readBigUInt64LE()),maxGasAmount=u64(),gasUnitPrice=u64(),expirationTimestampSecs=u64();assert(byte()===4,'chain');
  const raw=bytes.subarray(0,pos);assert(byte()===0,'auth');const pub=blob(),sig=blob();assert(pub.length===32&&sig.length===64&&pos===bytes.length,'auth data');
  assert('0x'+sha(Buffer.concat([pub,Buffer.from([0])]),'sha3-256').toString('hex')===from,'authkey');
  if(simulation)assert(sig.equals(Buffer.alloc(64)),'simulation must not carry real signature');
  else assert(verify(null,Buffer.concat([sha(Buffer.from('APTOS::RawTransaction'),'sha3-256'),raw]),publicKey(pub),sig),'signature');
  const hash='0x'+sha(Buffer.concat([sha(Buffer.from('APTOS::Transaction'),'sha3-256'),Buffer.from([0]),bytes]),'sha3-256').toString('hex');
  return {from,to,sequence,amountAtomic,maxGasAmount,gasUnitPrice,expirationTimestampSecs,pub:'0x'+pub.toString('hex'),sig:'0x'+sig.toString('hex'),hash};
}
export async function accountOnlineFixture(family){
  const store=storeFixture(),now={value:Date.now()},vault=new Vault(store.store,{now:()=>now.value});await vault.create(PASSWORD);
  const account=await vault.addAccount({family,label:'PUBLIC TEST KEY',secretHex:'31'.repeat(32)});
  const to=keyInfo(family,Buffer.alloc(32,0x32)).address;
  const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
  const stellar=family==='stellar',state={family,now,height:10,version:'100',sourceBalance:10000000000n,toBalance:2000000000n,sequence:'7',sent:0,signaturesVerified:0,simulations:0,calls:[],record:null,pending:false,failed:false,drop:false,hide:false,delay:null,mutate:null,authKey:account.address,memoRequired:false,threshold:1,masterWeight:1,liability:'0',subentries:0,sponsoring:0,sponsored:0};
  const pinHash=(stellar?'':'0x')+'11'.repeat(32),headHash=height=>(stellar?'':'0x')+height.toString(16).padStart(64,'0');
  const ledger=height=>({sequence:height,hash:height===1?pinHash:headHash(height),closed_at:new Date(now.value).toISOString(),base_fee_in_stroops:100,base_reserve_in_stroops:5000000});
  const block=(height,version)=>({block_height:String(height),block_hash:height===1?pinHash:headHash(height),first_version:String(version),last_version:String(version),block_timestamp:String(BigInt(now.value)*1000n)});
  function stellarAccount(address){const isFrom=address===account.address;return {account_id:address,sequence:isFrom?state.sequence:'0',subentry_count:isFrom?state.subentries:0,num_sponsoring:isFrom?state.sponsoring:0,num_sponsored:isFrom?state.sponsored:0,last_modified_ledger:state.height,thresholds:{med_threshold:state.threshold},signers:[{key:address,type:'ed25519_public_key',weight:state.masterWeight}],balances:[{asset_type:'native',balance:decimal(isFrom?state.sourceBalance:state.toBalance,7),selling_liabilities:isFrom?state.liability:'0',buying_liabilities:'0'}],data:!isFrom&&state.memoRequired?{'config.memo_required':'MQ=='}:{}};}
  function aptosResult(t){return {type:'user_transaction',hash:t.hash,sender:t.from,sequence_number:t.sequence,max_gas_amount:t.maxGasAmount,gas_unit_price:t.gasUnitPrice,expiration_timestamp_secs:t.expirationTimestampSecs,gas_used:state.gasUsed??'5',success:!state.failed,vm_status:state.failed?'Move abort synthetic':'Executed successfully',version:state.version,timestamp:String(BigInt(now.value)*1000n),signature:{type:'ed25519_signature',public_key:t.pub,signature:t.sig},payload:{type:'entry_function_payload',function:'0x1::aptos_account::transfer',type_arguments:[],arguments:[t.to,t.amountAtomic]}};}
  function history(address,version){const before=state.record&&BigInt(version)<BigInt(state.record.version);return {balance:address===account.address?(before?state.priorFrom:state.sourceBalance):(before?state.priorTo:state.toBalance),sequence:address===account.address?(before?state.priorSequence:state.sequence):'0'};}
  const servers=[];
  for(let peer=0;peer<2;peer++){
    const server=http.createServer(async(req,res)=>{
      let bytes=[];for await(const c of req)bytes.push(c);bytes=Buffer.concat(bytes);
      const u=new URL(req.url,'http://127.0.0.1'),path=u.pathname.replace(/^\/v1/,'')||'/';
      state.calls.push({peer,path,method:req.method,bodyHex:bytes.toString('hex')});
      try{
        if(state.delay)await state.delay({path,peer,method:req.method});
        let v,status=200;
        if(stellar){
          if(path==='/')v={network_passphrase:STELLAR_LOCAL_PASSPHRASE,history_latest_ledger:state.height,core_latest_ledger:state.height};
          else if(path.startsWith('/ledgers/'))v=ledger(Number(path.split('/').at(-1)));
          else if(path.startsWith('/accounts/'))v=stellarAccount(path.split('/').at(-1));
          else if(path==='/transactions'&&req.method==='POST'){
            const t=decodeStellar(Buffer.from(new URLSearchParams(bytes.toString()).get('tx'),'base64'),STELLAR_LOCAL_PASSPHRASE);
            assert(t.from===account.address&&BigInt(t.sequence)===BigInt(state.sequence)+1n,'sequence');
            assert(BigInt(t.maxTime)>BigInt(Math.floor(now.value/1000)),'expired');
            state.sent++;state.signaturesVerified++;
            state.sourceBalance-=BigInt(t.feeAtomic)+(state.failed?0n:BigInt(t.amountAtomic));state.toBalance+=state.failed?0n:BigInt(t.amountAtomic);state.sequence=t.sequence;state.height++;
            const result=Buffer.alloc(32);result.writeBigUInt64BE(BigInt(t.feeAtomic),0);result.writeInt32BE(state.failed?-1:0,8);
            result.writeUInt32BE(1,12);result.writeInt32BE(1,20);if(state.failed)result.writeInt32BE(-2,24);
            state.record={hash:t.hash,envelope_xdr:t.envelope,source_account:t.from,source_account_sequence:t.sequence,fee_account:t.from,fee_charged:t.feeAtomic,max_fee:t.feeAtomic,operation_count:1,successful:!state.failed,ledger:state.height,result_xdr:result.toString('base64'),decoded:t};
            if(state.drop){req.socket.destroy();return;}v={hash:t.hash};
          }else if(path.endsWith('/operations')){
            const t=state.record?.decoded;v={_embedded:{records:t?[{type:'payment',type_i:1,asset_type:'native',from:t.from,to:t.to,amount:decimal(t.amountAtomic,7),transaction_hash:t.hash,transaction_successful:true}]:[]}};
          }else if(path.startsWith('/transactions/')){if(!state.record||state.hide){status=404;v={error:'missing'};}else {const {decoded,...rest}=state.record;v=rest;}}
          else {status=404;v={error:'endpoint'};}
        }else{
          if(path==='/')v={chain_id:4,ledger_version:state.version,oldest_ledger_version:'0',ledger_timestamp:String(BigInt(now.value)*1000n),block_height:String(state.height)};
          else if(path.startsWith('/blocks/by_height/')){const h=Number(path.split('/').at(-1));v=block(h,h===1?'1':state.version);}
          else if(path.startsWith('/blocks/by_version/')){const ver=path.split('/').at(-1);v=block(BigInt(ver)<101n?10:state.height,ver);}
          else if(path.startsWith('/accounts/')){const a=path.split('/').at(-1),h=history(a,u.searchParams.get('ledger_version'));v={sequence_number:h.sequence,authentication_key:a===account.address?state.authKey:a};}
          else if(path==='/view'){const request=JSON.parse(bytes);assert(request.function==='0x1::coin::balance'&&request.type_arguments[0]==='0x1::aptos_coin::AptosCoin','view');v=[String(history(request.arguments[0],u.searchParams.get('ledger_version')).balance)];}
          else if(path==='/transactions/simulate'){const t=decodeAptos(bytes,true);state.simulations++;v=[aptosResult(t)];}
          else if(path==='/transactions'&&req.method==='POST'){
            const t=decodeAptos(bytes);assert(t.from===account.address&&t.sequence===state.sequence,'sequence');assert(BigInt(t.expirationTimestampSecs)>BigInt(Math.floor(now.value/1000)),'expired');
            state.sent++;state.signaturesVerified++;state.priorFrom=state.sourceBalance;state.priorTo=state.toBalance;state.priorSequence=state.sequence;
            const fee=BigInt(state.gasUsed??'5')*BigInt(t.gasUnitPrice),amount=state.failed?0n:BigInt(t.amountAtomic);
            state.sourceBalance-=fee+amount;state.toBalance+=amount;state.sequence=String(BigInt(state.sequence)+1n);state.version=String(BigInt(state.version)+1n);state.height++;state.record=aptosResult(t);
            if(state.drop){req.socket.destroy();return;}v={type:'pending_transaction',hash:t.hash};
          }else if(path.startsWith('/transactions/by_')){
            if(!state.record||state.hide){status=404;v={error_code:'transaction_not_found'};}
            else v=state.pending?{type:'pending_transaction',hash:state.record.hash}:state.record;
          }else {status=404;v={error_code:'endpoint'};}
        }
        v=JSON.parse(JSON.stringify(v));if(state.mutate)v=state.mutate(v,{path,peer,method:req.method})??v;
        res.writeHead(status,{'content-type':'application/json',...(!stellar?{'x-aptos-chain-id':'4','x-aptos-ledger-version':state.version,'x-aptos-ledger-oldest-version':'0'}:{})});res.end(JSON.stringify(v));
      }catch(e){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({fixtureError:e.message}));}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
  }
  const network=validateAccountNetwork({family,id:stellar?'stellar:standalone':'aptos:local-4',name:'SYNTHETIC '+family,rpcUrls:servers.map(s=>`http://127.0.0.1:${s.address().port}/${stellar?'':'v1/'}`),checkpoint:{height:1,hash:pinHash},broadcastEnabled:true,maxTransferAtomic:'1000000000',maxFeeAtomic:'1000000',minConfirmations:1,...(stellar?{networkPassphrase:STELLAR_LOCAL_PASSPHRASE}:{chainId:4})});
  const app=new WalletServer({store:store.store,vault,now:()=>now.value,settings:{schema:'realdex.wallet-settings.v1',allowedAppOrigins:['http://127.0.0.1:5173'],networks:[],accountNetworks:[network]}});
  const started=await app.start(0);
  const request=(route,body={},headers={})=>fetch(started.origin+'/api/'+route,{method:'POST',headers:{origin:started.origin,authorization:'Bearer '+app.uiToken,'content-type':'application/json',...headers},body:JSON.stringify(body)});
  const call=async(route,body={})=>{const r=await request(route,body),b=await r.json();if(!r.ok)throw Error(b.error);return b;};
  const payment=(extra={})=>({requestKey:'account-payment',to,amountAtomic:'1000000',...(stellar?{feeAtomic:'100',memo:''}:{maxGasAmount:'1000',gasUnitPrice:'100'}),...extra});
  const prepare=(extra={})=>call('non-evm/account-online/prepare',{accountId:account.id,networkId:network.id,payment:payment(extra)});
  const approve=(p,broadcast=false)=>call('non-evm/approve',{id:p.id,intentId:p.intentId,confirmation:to,broadcast});
  const reconcile=r=>call('non-evm/account-online/reconcile',{id:r.id});
  const close=async()=>{await app.close();await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));store.close();};
  return {state,now,account,to,network,vault,store,app,started,request,call,payment,prepare,approve,reconcile,close};
}
