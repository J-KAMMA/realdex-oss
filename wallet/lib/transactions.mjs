/** Canonical transaction encoders. No network IO, no approval decisions here. */
import {createPublicKey} from 'node:crypto';
import {need,shape,uint,hex,hex0,canonical} from './guard.mjs';
import {keyInfo,signDigest,signEd25519,sha256,base58Decode,base58Encode,edKey,recoverDigest} from './keys.mjs';
import {address,keccak256,selector} from '../../node/verified/keccak.mjs';
import {principalBytes,canisterPrincipal,icrcAccount} from '../../node/icp/principal.mjs';
import {candidLabel,uleb} from '../../node/icp/candid.mjs';
import {encodeCbor} from '../../node/icp/cbor.mjs';
const U64=(1n<<64n)-1n;
export function integerBytes(n){need(typeof n==='bigint'&&n>=0n,'RLP_INTEGER_INVALID');if(!n)return Buffer.alloc(0);let h=n.toString(16);if(h.length%2)h='0'+h;return Buffer.from(h,'hex');}
export function rlp(x){
  if(typeof x==='bigint')return rlp(integerBytes(x));
  const list=Array.isArray(x),b=list?Buffer.concat(x.map(rlp)):Buffer.from(x);need(b.length<=131072,'RLP_SIZE_LIMIT');
  if(!list&&b.length===1&&b[0]<128)return b;
  const offset=list?0xc0:0x80;return b.length<=55?Buffer.concat([Buffer.from([offset+b.length]),b]):Buffer.concat([Buffer.from([offset+55+integerBytes(BigInt(b.length)).length]),integerBytes(BigInt(b.length)),b]);
}
export function evmTransaction(raw){
  shape(raw,['type','chainId','nonce','gasLimit','to','value','data'],['maxPriorityFeePerGas','maxFeePerGas','gasPrice']);need(raw.type===0||raw.type===2,'TRANSACTION_TYPE_UNSUPPORTED');
  const t={type:raw.type,chainId:String(uint(raw.chainId)),nonce:String(uint(raw.nonce,U64-1n)),gasLimit:String(uint(raw.gasLimit,U64)),to:address(raw.to),value:String(uint(raw.value)),data:hex0(hex(raw.data))};
  need(BigInt(t.chainId)>0n&&BigInt(t.gasLimit)>=21000n&&t.data.length<=32770,'TRANSACTION_RANGE_INVALID');
  if(t.type===2){need(raw.gasPrice===undefined,'FEE_FIELDS_CONFLICT');t.maxPriorityFeePerGas=String(uint(raw.maxPriorityFeePerGas));t.maxFeePerGas=String(uint(raw.maxFeePerGas));need(BigInt(t.maxPriorityFeePerGas)<=BigInt(t.maxFeePerGas)&&BigInt(t.maxFeePerGas)>0n,'FEE_INVALID');}
  else{need(raw.maxPriorityFeePerGas===undefined&&raw.maxFeePerGas===undefined,'FEE_FIELDS_CONFLICT');t.gasPrice=String(uint(raw.gasPrice));need(BigInt(t.gasPrice)>0n,'FEE_INVALID');}
  return Object.freeze(t);
}
export function evmSigningPayload(raw){const t=evmTransaction(raw),d=hex(t.data),to=hex(t.to,20);
  const fields=t.type===2?[BigInt(t.chainId),BigInt(t.nonce),BigInt(t.maxPriorityFeePerGas),BigInt(t.maxFeePerGas),BigInt(t.gasLimit),to,BigInt(t.value),d,[]]:[BigInt(t.nonce),BigInt(t.gasPrice),BigInt(t.gasLimit),to,BigInt(t.value),d,BigInt(t.chainId),0n,0n];
  const bytes=t.type===2?Buffer.concat([Buffer.from([2]),rlp(fields)]):rlp(fields);return {transaction:t,fields,bytes,digest:keccak256(bytes)};
}
export function signEvmTransaction(secret,raw,options){const p=evmSigningPayload(raw),s=signDigest(secret,hex(p.digest,32),options),t=p.transaction;
  const fields=t.type===2?[...p.fields,BigInt(s.recovery),s.r,s.s]:[...p.fields.slice(0,6),BigInt(t.chainId)*2n+35n+BigInt(s.recovery),s.r,s.s];
  const signed=t.type===2?Buffer.concat([Buffer.from([2]),rlp(fields)]):rlp(fields);
  return {format:t.type===2?'eip-1559':'eip-155',from:keyInfo('evm',secret).address,rawTransaction:hex0(signed),transactionHash:keccak256(signed),signingDigest:p.digest};
}
/** Bounded parser used for restored journals and re-broadcast integrity. */
export function parseSignedEvmTransaction(raw) {
  const bytes=hex(raw);need(bytes.length>0&&bytes.length<=17000,'SIGNED_TRANSACTION_SIZE');const type=bytes[0]===2?2:0,body=type===2?bytes.subarray(1):bytes;let cursor=0,nodes=0;
  const take=n=>{need(Number.isSafeInteger(n)&&n>=0&&cursor+n<=body.length,'RLP_TRUNCATED');const b=body.subarray(cursor,cursor+n);cursor+=n;return b;};
  function read(depth=0){need(depth<=2&&++nodes<=32,'RLP_STRUCTURE_LIMIT');const tag=take(1)[0];if(tag<128)return Buffer.from([tag]);
    const list=tag>=192,short=tag<(list?248:184);let n;
    if(short)n=tag-(list?192:128);else {const len=take(tag-(list?247:183));need(len.length<=3&&len[0]!==0,'RLP_LENGTH_NONCANONICAL');n=Number(BigInt('0x'+len.toString('hex')));need(n>55,'RLP_LENGTH_NONCANONICAL');}
    if(!list){const value=take(n);need(!(n===1&&value[0]<128),'RLP_SINGLE_BYTE_NONCANONICAL');return value;}
    const end=cursor+n;need(end<=body.length,'RLP_TRUNCATED');const out=[];while(cursor<end)out.push(read(depth+1));need(cursor===end,'RLP_LENGTH_INVALID');return out;
  }
  const f=read();need(cursor===body.length&&Array.isArray(f)&&f.length===(type===2?12:9),'SIGNED_TRANSACTION_STRUCTURE');
  const number=x=>{need(Buffer.isBuffer(x)&&x.length<=32&&(x.length===0||x[0]!==0),'RLP_INTEGER_NONCANONICAL');return x.length?BigInt('0x'+x.toString('hex')):0n;};
  const destination=x=>{need(Buffer.isBuffer(x)&&x.length===20,'TRANSACTION_DESTINATION_INVALID');return address(hex0(x));};
  let t,recovery;
  if(type===2){need(Array.isArray(f[8])&&f[8].length===0,'ACCESS_LIST_UNSUPPORTED');recovery=Number(number(f[9]));t=evmTransaction({type,chainId:String(number(f[0])),nonce:String(number(f[1])),maxPriorityFeePerGas:String(number(f[2])),maxFeePerGas:String(number(f[3])),gasLimit:String(number(f[4])),to:destination(f[5]),value:String(number(f[6])),data:hex0(f[7])});}
  else {const v=number(f[6]);need(v>=37n,'UNPROTECTED_LEGACY_SIGNATURE');recovery=Number((v-35n)%2n);t=evmTransaction({type,chainId:String((v-35n)/2n),nonce:String(number(f[0])),gasPrice:String(number(f[1])),gasLimit:String(number(f[2])),to:destination(f[3]),value:String(number(f[4])),data:hex0(f[5])});}
  const r=number(f.at(-2)),s=number(f.at(-1)),p=evmSigningPayload(t),compact=Buffer.from(abiWord(r)+abiWord(s),'hex'),signer=recoverDigest(hex(p.digest,32),compact,recovery);
  need((type===2?Buffer.concat([Buffer.from([2]),rlp(f)]):rlp(f)).equals(bytes),'SIGNED_TRANSACTION_NONCANONICAL');
  return {transaction:t,from:signer.address,transactionHash:keccak256(bytes),signingDigest:p.digest};
}
function word(data,i){const s=data.slice(10+i*64,10+(i+1)*64);need(s.length===64,'CALLDATA_TRUNCATED');return s;}
const wordAddress=(data,i)=>{const s=word(data,i);need(/^0{24}/.test(s),'ABI_ADDRESS_PADDING_INVALID');return address('0x'+s.slice(24));};
const wordUint=(data,i)=>BigInt('0x'+word(data,i));
export const POOL_SWAP_SELECTOR=selector('swapExactIn(address,uint256,uint256,address,uint256)');
export const POOL_ADD_SELECTOR=selector('addLiquidity(uint256,uint256,uint256,address,uint256)');
export const POOL_REMOVE_SELECTOR=selector('removeLiquidity(uint256,uint256,uint256,address,uint256)');
export const ROUTER_ADD_SELECTOR=selector('addLiquidity(address,uint256,uint256,uint256,uint256,uint256,address,uint256)');
export const FACTORY_CREATE_SELECTOR=selector('createPool(address,address,uint256)');
export const SWAP_SELECTOR=selector('swapExactIn(address[],address,uint256,uint256,address,uint256)');
/** Resolve only owner-configured, acyclic routes. No RPC or trust promotion. */
export function resolveLocalRoute(network, routerAddress, poolAddresses, tokenInAddress) {
  const contracts=network.contracts??[],router=contracts.find(c=>c.kind==='router'&&c.address===address(routerAddress));
  need(router,'ROUTER_NOT_IN_LOCAL_POLICY');
  need(Array.isArray(poolAddresses)&&poolAddresses.length>=1&&poolAddresses.length<=4,'PATH_LENGTH_INVALID');
  const addresses=poolAddresses.map(a=>address(a));need(new Set(addresses).size===addresses.length,'REPEATED_POOL');
  const input=address(tokenInAddress),visited=new Set([input]),pools=[];let current=input;
  for(const a of addresses){
    const pool=contracts.find(c=>c.kind==='pool'&&c.address===a);need(pool,'POOL_NOT_IN_LOCAL_POLICY');
    need([pool.token0,pool.token1].includes(current),'POOL_PATH_INVALID');
    current=current===pool.token0?pool.token1:pool.token0;need(!visited.has(current),'REPEATED_TOKEN');
    visited.add(current);pools.push(pool);
  }
  const tokens=[...visited].map(a=>contracts.find(c=>c.kind==='erc20'&&c.address===a));
  need(tokens.every(Boolean),'TOKEN_NOT_IN_LOCAL_POLICY');
  return {router,pools,tokens,tokenIn:tokens[0],tokenOut:tokens.at(-1),contractPins:[router,...pools,...tokens]};
}
export function classifyEvmCall(t,network,{now=Date.now()}={}){
  const data=t.data.toLowerCase(),to=t.to,contracts=network.contracts??[];
  if(data==='0x'){need(BigInt(t.value)>0n,'ZERO_TRANSFER');return {kind:'native-transfer',recipient:to,amountAtomic:t.value,asset:network.symbol,contractPins:[],minimumOutputAtomic:null};}
  need(t.value==='0','NATIVE_VALUE_WITH_TOKEN_CALL_FORBIDDEN');const target=contracts.find(c=>c.address===to);need(target,'CONTRACT_NOT_IN_LOCAL_POLICY');
  const token=target.kind==='erc20';
  if(token&&['0xa9059cbb','0x095ea7b3'].includes(data.slice(0,10))){need(data.length===138,'CALLDATA_LENGTH_INVALID');const recipient=wordAddress(data,0),amount=wordUint(data,1);
    if(data.startsWith('0xa905')){need(amount>0n,'ZERO_TRANSFER');return {kind:'erc20-transfer',recipient,amountAtomic:String(amount),asset:target.symbol,contractPins:[target],minimumOutputAtomic:null};}
    need(amount<(1n<<255n)&&amount<=BigInt(target.approvalCapAtomic),'APPROVAL_EXCEEDS_LOCAL_CAP');const spender=contracts.find(c=>c.address===recipient&&(c.kind==='router'||c.kind==='pool'&&[c.token0,c.token1].includes(target.address)));need(spender,'SPENDER_NOT_IN_LOCAL_POLICY');
    return {kind:amount===0n?'erc20-revoke':'erc20-approve',recipient,amountAtomic:String(amount),asset:target.symbol,contractPins:[target,spender],minimumOutputAtomic:null};
  }
  const deadlineCheck=value=>{const sec=BigInt(Math.floor(now/1000));need(value>sec&&value<=sec+600n,'TRANSACTION_DEADLINE_INVALID');return String(value);};
  const poolTokens=pool=>{const tokens=[pool.token0,pool.token1].map(a=>contracts.find(c=>c.kind==='erc20'&&c.address===a));need(tokens.every(Boolean),'TOKEN_NOT_IN_LOCAL_POLICY');return tokens;};
  if(target.kind==='factory'&&data.startsWith(FACTORY_CREATE_SELECTOR)){
    need(data.length===10+3*64,'CALLDATA_LENGTH_INVALID');const a=wordAddress(data,0),b=wordAddress(data,1),fee=wordUint(data,2);need(a!==b&&fee>=1n&&fee<=100n,'FACTORY_PARAMETERS_INVALID');const tokens=[a,b].map(x=>contracts.find(c=>c.kind==='erc20'&&c.address===x));need(tokens.every(Boolean),'TOKEN_NOT_IN_LOCAL_POLICY');
    return {kind:'local-factory-create-pool',recipient:to,amountAtomic:'0',asset:'No token transfer',minimumOutputAtomic:null,contractPins:[target,...tokens],details:{tokenA:a,tokenB:b,feeBps:String(fee),createdPoolAutomaticallyTrusted:false}};
  }
  if(target.kind==='pool'&&data.startsWith(POOL_SWAP_SELECTOR)){
    need(data.length===10+5*64,'CALLDATA_LENGTH_INVALID');const tokenIn=wordAddress(data,0),amount=wordUint(data,1),minimum=wordUint(data,2),recipient=wordAddress(data,3),deadline=deadlineCheck(wordUint(data,4)),tokens=poolTokens(target);need(tokens.some(t=>t.address===tokenIn)&&amount>0n&&minimum>0n,'SWAP_AMOUNT_OR_ASSET_INVALID');const input=tokens.find(t=>t.address===tokenIn),output=tokens.find(t=>t.address!==tokenIn);
    return {kind:'local-pool-swap',recipient,amountAtomic:String(amount),asset:input.symbol,outputAsset:output.symbol,minimumOutputAtomic:String(minimum),tokenIn,tokenOut:output.address,pools:[to],deadline,contractPins:[target,...tokens]};
  }
  if((target.kind==='pool'&&[POOL_ADD_SELECTOR,POOL_REMOVE_SELECTOR].includes(data.slice(0,10)))||(target.kind==='router'&&data.startsWith(ROUTER_ADD_SELECTOR))){
    const routed=target.kind==='router',remove=data.startsWith(POOL_REMOVE_SELECTOR);need(data.length===10+(routed?8:5)*64,'CALLDATA_LENGTH_INVALID');const pool=routed?contracts.find(c=>c.kind==='pool'&&c.address===wordAddress(data,0)):target;need(pool,'POOL_NOT_IN_LOCAL_POLICY');const tokens=poolTokens(pool),values=Array.from({length:routed?5:3},(_,i)=>wordUint(data,i+(routed?1:0)));need(values.every(v=>v>0n),'LIQUIDITY_MINIMUMS_REQUIRED');if(routed)need(values[2]<=values[0]&&values[3]<=values[1],'LIQUIDITY_MINIMUM_ABOVE_MAXIMUM');
    const recipient=wordAddress(data,routed?6:3),deadline=deadlineCheck(wordUint(data,routed?7:4));
    const details=remove?{pool:pool.address,burnShares:String(values[0]),minimum0:String(values[1]),minimum1:String(values[2]),token0:pool.token0,token1:pool.token1}:
      {pool:pool.address,maximum0:String(values[0]),maximum1:String(values[1]),minimum0:routed?String(values[2]):null,minimum1:routed?String(values[3]):null,minimumShares:String(values[routed?4:2]),token0:pool.token0,token1:pool.token1};
    return {kind:remove?'local-pool-remove-liquidity':routed?'local-router-add-liquidity':'local-pool-add-liquidity',recipient,amountAtomic:remove?String(values[0]):String(values[0])+' + '+String(values[1]),asset:remove?'LP shares':tokens[0].symbol+' + '+tokens[1].symbol,minimumOutputAtomic:null,deadline,details,contractPins:[target,pool,...tokens]};
  }
  if(target.kind==='router'&&data.startsWith(SWAP_SELECTOR)){
    need(wordUint(data,0)===192n,'ABI_OFFSET_INVALID');const count=wordUint(data,6);need(count>=1n&&count<=4n&&data.length===10+(7+Number(count))*64,'PATH_LENGTH_INVALID');
    const input=wordAddress(data,1),amount=wordUint(data,2),minimum=wordUint(data,3),recipient=wordAddress(data,4),deadline=wordUint(data,5);
    need(amount>0n&&minimum>0n,'SWAP_AMOUNT_INVALID');const sec=BigInt(Math.floor(now/1000));need(deadline>sec&&deadline<=sec+600n,'SWAP_DEADLINE_INVALID');
    const pools=Array.from({length:Number(count)},(_,i)=>wordAddress(data,7+i));
    const route=resolveLocalRoute(network,to,pools,input),inputToken=route.tokenIn,outputToken=route.tokenOut,current=outputToken.address,pins=route.contractPins;
    return {kind:'local-router-swap',recipient,amountAtomic:String(amount),asset:inputToken.symbol,outputAsset:outputToken.symbol,tokenIn:input,tokenOut:current,pools,deadline:String(deadline),minimumOutputAtomic:String(minimum),contractPins:pins,details:{router:to,pools,tokenPath:route.tokens.map(t=>t.address)}};
  }
  throw Error('BLIND_SIGNING_FORBIDDEN');
}
export const abiWord=n=>BigInt(n).toString(16).padStart(64,'0');
export const abiAddress=a=>address(a).slice(2).padStart(64,'0');
export function erc20TransferData(recipient,amount){need(uint(amount)>0n,'ZERO_TRANSFER');return '0xa9059cbb'+abiAddress(recipient)+abiWord(amount);}
export function routerQuoteData(info){return selector('quoteExactIn(address[],address,uint256)')+abiWord(96)+abiAddress(info.tokenIn)+abiWord(info.amountAtomic)+abiWord(info.pools.length)+info.pools.map(abiAddress).join('');}
/** Offline Solana legacy native-transfer codec; no SPL, address tables or blind instruction signing. */
export function solanaTransferMessage(raw){shape(raw,['from','to','lamports','recentBlockhash']);const from=base58Decode(raw.from,32),to=base58Decode(raw.to,32),block=base58Decode(raw.recentBlockhash,32),amount=uint(raw.lamports,U64);need(amount>0n&&!from.equals(to),'SOLANA_TRANSFER_INVALID');
  need(from.some(Boolean)&&to.some(Boolean),'SOLANA_SYSTEM_ADDRESS_FORBIDDEN');const instruction=Buffer.alloc(12);instruction.writeUInt32LE(2,0);instruction.writeBigUInt64LE(amount,4);
  // Header + compact-u16 lengths (all counts < 128) + account keys + blockhash + instruction.
  return Buffer.concat([Buffer.from([1,0,1,3]),from,to,Buffer.alloc(32),block,Buffer.from([1,2,2,0,1,12]),instruction]);
}
export function signSolanaTransfer(secret,raw){need(keyInfo('solana',secret).address===raw.from,'SIGNER_ADDRESS_MISMATCH');const message=solanaTransferMessage(raw),signature=signEd25519(secret,message),signed=Buffer.concat([Buffer.from([1]),signature,message]);
  return {format:'solana-legacy-native-transfer',signature:base58Encode(signature),transactionBase64:signed.toString('base64'),messageHex:message.toString('hex'),networkNotBoundByChainId:true};
}
function sleb(value){let n=BigInt(value);const out=[];for(;;){const b=Number(n&127n);n>>=7n;const done=n===0n&&!(b&64)||n===-1n&&(b&64);out.push(done?b:b|128);if(done)return out;}}
const blobValue=b=>[...uleb(BigInt(b.length)),...b];
function recordType(fields){return [...sleb(-20),...uleb(BigInt(fields.length)),...fields.flatMap(f=>[...uleb(BigInt(f.id)),...sleb(f.type)])];}
export function encodeIcrcTransfer(raw){
  shape(raw,['fromSubaccount','to','amountAtomic','feeAtomic','memoHex','createdAtTimeNs']);const from=hex(raw.fromSubaccount,32,false),to=icrcAccount(raw.to),owner=principalBytes(to.owner),sub=hex(to.subaccount,32,false),memo=hex(raw.memoHex,32,false),amount=uint(raw.amountAtomic),fee=uint(raw.feeAtomic),time=uint(raw.createdAtTimeNs,U64);need(amount>0n&&time>0n,'ICRC_TRANSFER_AMOUNT_OR_TIME_INVALID');
  const fieldsAccount=[{id:candidLabel('owner'),type:-24,value:[1,...blobValue(owner)]},{id:candidLabel('subaccount'),type:1,value:[1,...blobValue(sub)]}].sort((a,b)=>a.id-b.id);
  const timeBytes=Buffer.alloc(8);timeBytes.writeBigUInt64LE(time);
  const fields=[{name:'from_subaccount',type:1,value:[1,...blobValue(from)]},{name:'to',type:2,value:fieldsAccount.flatMap(f=>f.value)},
    {name:'amount',type:-3,value:uleb(amount)},{name:'fee',type:3,value:[1,...uleb(fee)]},{name:'memo',type:1,value:[1,...blobValue(memo)]},{name:'created_at_time',type:4,value:[1,...timeBytes]}].map(f=>({...f,id:candidLabel(f.name)})).sort((a,b)=>a.id-b.id);
  // 0 vec nat8; 1 opt vec; 2 Account; 3 opt nat; 4 opt nat64; 5 TransferArg.
  const table=[...sleb(-19),...sleb(-5),...sleb(-18),0,...recordType(fieldsAccount),...sleb(-18),...sleb(-3),...sleb(-18),...sleb(-8),...recordType(fields)];
  return Buffer.from([68,73,68,76,6,...table,1,5,...fields.flatMap(f=>f.value)]);
}
export function icRequestId(content){
  const hashValue=v=>{if(typeof v==='string')return sha256(Buffer.from(v));if(typeof v==='bigint')return sha256(Buffer.from(uleb(v)));if(v instanceof Uint8Array)return sha256(v);if(Array.isArray(v))return sha256(Buffer.concat(v.map(hashValue)));throw Error('IC_REQUEST_VALUE_UNSUPPORTED');};
  const fields=Object.entries(content).map(([k,v])=>[sha256(Buffer.from(k)),hashValue(v)]).sort((a,b)=>Buffer.compare(a[0],b[0]));return sha256(Buffer.concat(fields.flat()));
}
export function signIcrcTransfer(secret,{ledger,transfer,ingressExpiryNs,nonceHex}){
  const id=keyInfo('icp',secret),content={request_type:'call',canister_id:principalBytes(canisterPrincipal(ledger)),method_name:'icrc1_transfer',arg:encodeIcrcTransfer(transfer),sender:principalBytes(id.address),ingress_expiry:uint(ingressExpiryNs,U64),nonce:hex(nonceHex,32,false)};
  const requestId=icRequestId(content),der=createPublicKey(edKey(secret)).export({format:'der',type:'spki'}),signature=signEd25519(secret,Buffer.concat([Buffer.from([10]),Buffer.from('ic-request'),requestId]));
  const body=Buffer.from(encodeCbor({content,sender_pubkey:der,sender_sig:signature}));
  return {format:'icrc1-transfer-call-envelope',sender:id.address,requestId:requestId.toString('hex'),envelopeBase64:body.toString('base64'),certifiedResponseVerifierImplemented:false};
}
