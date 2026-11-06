/** Explicit owner-configured REGTEST only. RPC credentials never enter API results. */
import fs from 'node:fs';
import path from 'node:path';
import {need,shape,text,uint,freeze,canonical} from '../lib/guard.mjs';
import {fingerprint} from './solana-codec.mjs';
export const BITCOIN_REGTEST_GENESIS='0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export const bitcoinHash=s=>{need(typeof s==='string'&&/^[0-9a-f]{64}$/.test(s),'BITCOIN_HASH_INVALID');return s;};
export function rpcInteger(s,max=Number.MAX_SAFE_INTEGER){need(typeof s==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(s)&&BigInt(s)<=BigInt(max),'BITCOIN_RPC_INTEGER_INVALID');return Number(s);}
/** Raw JSON numeric text -> satoshis. Handles scientific notation without Number conversion. */
export function btcSatoshis(s){
  need(typeof s==='string'&&s.length<=64,'BITCOIN_RPC_AMOUNT_INVALID');
  const m=/^(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]{1,3}))?$/.exec(s);need(m,'BITCOIN_RPC_AMOUNT_INVALID');
  const fraction=m[2]??'',scale=8+Number(m[3]??0)-fraction.length;need(Math.abs(scale)<=32,'BITCOIN_RPC_AMOUNT_RANGE');
  let n=BigInt(m[1]+fraction);
  if(scale>=0)n*=10n**BigInt(scale);else {const d=10n**BigInt(-scale);need(n%d===0n,'BITCOIN_SUBSATOSHI_AMOUNT');n/=d;}
  need(n<=2100000000000000n,'BITCOIN_RPC_AMOUNT_RANGE');return String(n);
}
export function satoshisBtc(n){const v=uint(String(n),2100000000000000n);return (v/100000000n)+'.'+String(v%100000000n).padStart(8,'0');}
/** Preserve ALL JSON number lexemes, including amounts and large counters. */
export function parseBitcoinJson(textValue){
  need(typeof textValue==='string'&&Buffer.byteLength(textValue)<=2097152,'BITCOIN_RPC_RESPONSE_LIMIT');let result='',p=0;
  while(p<textValue.length){const c=textValue[p];
    if(c==='"'){const start=p++;let closed=false;while(p<textValue.length){if(textValue[p]==='\\'){p+=2;continue;}if(textValue[p++]==='"'){closed=true;break;}}need(closed,'BITCOIN_RPC_JSON_INVALID');result+=textValue.slice(start,p);}
    else if(c==='-'||/[0-9]/.test(c)){const m=/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(textValue.slice(p));need(m,'BITCOIN_RPC_JSON_INVALID');result+=JSON.stringify(m[0]);p+=m[0].length;}
    else {result+=c;p++;}
  }
  try{return JSON.parse(result);}catch{throw Error('BITCOIN_RPC_JSON_INVALID');}
}
export function validateBitcoinNetwork(n){
  shape(n,['family','id','name','chain','genesisHash','checkpoint','rpcUrls','cookieFile','broadcastEnabled','maxTransferSats','maxFeeSats','maxFeeRateSatVb','minConfirmations']);
  need(n.family==='bitcoin'&&n.id==='bitcoin:regtest'&&n.chain==='regtest'&&n.genesisHash===BITCOIN_REGTEST_GENESIS,'BITCOIN_REGTEST_ONLY');text(n.name);
  shape(n.checkpoint,['height','hash']);need(Number.isSafeInteger(n.checkpoint.height)&&n.checkpoint.height>=1&&n.checkpoint.height<=2147483647,'BITCOIN_CHECKPOINT_REQUIRED');bitcoinHash(n.checkpoint.hash);need(!/^0{64}$/.test(n.checkpoint.hash),'BITCOIN_CHECKPOINT_REQUIRED');
  need(Array.isArray(n.rpcUrls)&&n.rpcUrls.length>=2&&n.rpcUrls.length<=4,'BITCOIN_TWO_TO_FOUR_RPC_REQUIRED');
  const rpcUrls=n.rpcUrls.map(s=>{text(s,256);let u;try{u=new URL(s);}catch{throw Error('BITCOIN_RPC_URL_INVALID');}
    need(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash,'BITCOIN_LOOPBACK_ROOT_RPC_REQUIRED');return u.href;});
  need(new Set(rpcUrls).size===rpcUrls.length,'BITCOIN_DUPLICATE_RPC');text(n.cookieFile,1024);need(path.isAbsolute(n.cookieFile),'BITCOIN_COOKIE_ABSOLUTE_PATH_REQUIRED');
  need(typeof n.broadcastEnabled==='boolean','BROADCAST_FLAG_INVALID');
  const caps=Object.fromEntries([['maxTransferSats',2100000000000000n],['maxFeeSats',1000000n],['maxFeeRateSatVb',10000n]].map(([k,max])=>{const v=uint(n[k],max);need(v>0n,'BITCOIN_CAP_INVALID');return [k,String(v)];}));
  need(Number.isInteger(n.minConfirmations)&&n.minConfirmations>=1&&n.minConfirmations<=10000,'BITCOIN_CONFIRMATION_POLICY_INVALID');
  return freeze({family:'bitcoin',id:n.id,name:n.name,chain:'regtest',genesisHash:n.genesisHash,checkpoint:{...n.checkpoint},rpcUrls,cookieFile:n.cookieFile,broadcastEnabled:n.broadcastEnabled,...caps,minConfirmations:n.minConfirmations});
}
export const bitcoinNetworkFingerprint=n=>fingerprint(validateBitcoinNetwork(n));
const METHODS=new Set(['getblockchaininfo','getblockhash','getblockheader','getblock','gettxout','getrawtransaction','getindexinfo','scantxoutset','testmempoolaccept','sendrawtransaction']);
function cookie(pathname){let fd,bytes;try{
  const st=fs.lstatSync(pathname);need(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&st.size>2&&st.size<=512,'BITCOIN_COOKIE_UNSAFE');
  if(process.platform!=='win32')need((st.mode&0o077)===0&&st.uid===process.getuid(),'BITCOIN_COOKIE_PERMISSIONS');
  fd=fs.openSync(pathname,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const opened=fs.fstatSync(fd);need(opened.ino===st.ino&&opened.dev===st.dev&&opened.size===st.size,'BITCOIN_COOKIE_CHANGED');
  bytes=fs.readFileSync(fd);need(bytes.length<=512,'BITCOIN_COOKIE_UNSAFE');const value=bytes.toString('utf8').replace(/\n$/,'');need(/^[A-Za-z0-9_]+:[A-Za-z0-9]+$/.test(value),'BITCOIN_COOKIE_INVALID');return 'Basic '+Buffer.from(value).toString('base64');
}catch(e){if(e?.message?.startsWith('BITCOIN_'))throw e;throw Error('BITCOIN_COOKIE_UNAVAILABLE');}finally{bytes?.fill(0);if(fd!==undefined)fs.closeSync(fd);}}
export class BitcoinRpc {
  constructor({fetchImpl=globalThis.fetch,timeoutMs=15000}={}){this.fetchImpl=fetchImpl;this.timeoutMs=timeoutMs;this.sequence=0;}
  async call(network,index,method,params){const n=validateBitcoinNetwork(network);need(METHODS.has(method),'BITCOIN_RPC_METHOD_FORBIDDEN');need(Number.isInteger(index)&&index>=0&&index<n.rpcUrls.length,'BITCOIN_RPC_INDEX');
    const id=++this.sequence;let res;const authorization=cookie(n.cookieFile);
    try{res=await this.fetchImpl(n.rpcUrls[index],{method:'POST',redirect:'error',credentials:'omit',headers:{'content-type':'application/json',authorization},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(this.timeoutMs)});}catch{throw Error('BITCOIN_RPC_TRANSPORT_UNCERTAIN');}
    need(res.status!==401&&res.status!==403,'BITCOIN_RPC_AUTH_FAILED');
    const reader=res.body?.getReader();need(reader,'BITCOIN_RPC_EMPTY_RESPONSE');const chunks=[];let size=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;need(size<=2097152,'BITCOIN_RPC_RESPONSE_LIMIT');chunks.push(Buffer.from(value));}}catch(e){if(e.message==='BITCOIN_RPC_RESPONSE_LIMIT')throw e;throw Error('BITCOIN_RPC_TRANSPORT_UNCERTAIN');}finally{await reader.cancel().catch(()=>{});}
    const r=parseBitcoinJson(Buffer.concat(chunks).toString('utf8'));need(r&&r.jsonrpc==='2.0'&&r.id===String(id),'BITCOIN_RPC_ID_MISMATCH');
    if(r.error){const e=Error('BITCOIN_RPC_REJECTED');e.rpcCode=r.error.code;throw e;}
    need(res.ok&&Object.hasOwn(r,'result'),'BITCOIN_RPC_HTTP_ERROR');return r.result;
  }
  async all(n,m,p){return Promise.all(n.rpcUrls.map((_,i)=>this.call(n,i,m,p)));}
  async agree(n,m,p){const values=await this.all(n,m,p);need(values.every(x=>canonical(x)===canonical(values[0])),'BITCOIN_RPC_DISAGREEMENT');return values[0];}
}
