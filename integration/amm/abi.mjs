/** Minimal TEST-ONLY ABI writer, for actual local EVM calls. Not a wallet signing API. */
import assert from 'node:assert/strict';
import {selector, address} from '../../node/verified/keccak.mjs';
import {abiWord, abiAddress} from '../../wallet/lib/transactions.mjs';
const dynamic = t => ['string','bytes','address[]'].includes(t);
const staticWord = (type,value) => {
  if(type==='address') return abiAddress(value);
  if(type==='bytes32') {assert.match(value,/^0x[0-9a-f]{64}$/i);return value.slice(2);}
  if(type==='bool') {assert.equal(typeof value,'boolean');return abiWord(value?1:0);}
  const m=/^uint(8|16|32|64|112|128|256)$/.exec(type);assert.ok(m,'Unsupported test ABI type '+type);
  const n=BigInt(value);assert.ok(n>=0n&&n<(1n<<BigInt(m[1])));return abiWord(n);
};
function tail(type,value) {
  if(type==='address[]') {assert.ok(Array.isArray(value)&&value.length<=16);return abiWord(value.length)+value.map(abiAddress).join('');}
  const b=type==='string'?Buffer.from(value,'utf8'):Buffer.from(value.slice(2),'hex');
  if(type==='bytes') assert.match(value,/^0x(?:[0-9a-f]{2})*$/i);
  return abiWord(b.length)+b.toString('hex').padEnd(Math.ceil(b.length/32)*64,'0');
}
export function encode(types,values) {
  assert.equal(types.length,values.length);const head=[],parts=[];let offset=32*types.length;
  for(let i=0;i<types.length;i++)if(dynamic(types[i])) {const t=tail(types[i],values[i]);head.push(abiWord(offset));parts.push(t);offset+=t.length/2;}else head.push(staticWord(types[i],values[i]));
  return head.join('')+parts.join('');
}
export function callData(signature,values=[]) {
  const types=signature.slice(signature.indexOf('(')+1,-1);return selector(signature)+encode(types?types.split(','):[],values);
}
export function uints(raw,count=1) {assert.match(raw,new RegExp('^0x[0-9a-fA-F]{'+count*64+'}$'));return Array.from({length:count},(_,i)=>BigInt('0x'+raw.slice(2+i*64,66+i*64)));}
export function addr(raw) {assert.match(raw,/^0x0{24}[0-9a-fA-F]{40}$/);return address('0x'+raw.slice(26));}
export async function read(chain,to,signature,values=[],ref='latest') {return chain.call('eth_call',[{to,data:callData(signature,values)},ref]);}
export async function number(chain,to,signature,values=[]) {return uints(await read(chain,to,signature,values))[0];}
export const DEPLOYER='0x1111222233334444555566667777888899990000';
export async function receipt(chain,hash) {
  for(let i=0;i<120;i++) {const r=await chain.call('eth_getTransactionReceipt',[hash]);if(r)return r;await new Promise(r=>setTimeout(r,25));}throw Error('AMM_MINING_TIMEOUT');
}
export async function prepareDeployer(chain) {
  assert.equal(await chain.call('eth_chainId',[]),'0x7a69');
  await chain.call('anvil_setBalance',[DEPLOYER,'0x56bc75e2d63100000']);
  await chain.call('anvil_impersonateAccount',[DEPLOYER]);
}
export async function send(chain,to,signature,values=[],{status='0x1'}={}) {
  const hash=await chain.call('eth_sendTransaction',[{from:DEPLOYER,to,data:callData(signature,values),gas:'0x989680'}]);
  const r=await receipt(chain,hash);assert.equal(r.status,status,'Actual EVM transaction status');return r;
}
export async function deploy(chain,build,source,name,args=[]) {
  const c=build.output.contracts?.[source]?.[name];assert.ok(c?.evm?.bytecode?.object,'compiled contract missing');
  const constructor=c.abi.find(v=>v.type==='constructor');const types=constructor?.inputs.map(v=>v.type)??[];
  const hash=await chain.call('eth_sendTransaction',[{from:DEPLOYER,data:'0x'+c.evm.bytecode.object+encode(types,args),gas:'0x989680'}]);
  const r=await receipt(chain,hash);assert.equal(r.status,'0x1','Contract deploy failed');assert.ok(r.contractAddress);return address(r.contractAddress);
}
