/** BIP-173 Bech32; v0 P2WPKH and standard Cosmos account addresses only. */
import {need} from '../lib/guard.mjs';
const CHARS='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const G=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
function polymod(v){let chk=1;for(const x of v){const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^x;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=G[i];}return chk>>>0;}
const expand=h=>[...h].map(c=>c.charCodeAt(0)>>>5).concat([0],[...h].map(c=>c.charCodeAt(0)&31));
export function convertBits(data,from,to,pad){need(Number.isInteger(from)&&from>=1&&from<=8&&Number.isInteger(to)&&to>=1&&to<=8,'BIT_WIDTH_INVALID');let acc=0,bits=0;const out=[],mask=(1<<to)-1,accMask=(1<<(from+to-1))-1;
  for(const v of data){need(Number.isInteger(v)&&v>=0&&(v>>>from)===0,'BECH32_DATA_INVALID');acc=((acc<<from)|v)&accMask;bits+=from;while(bits>=to){bits-=to;out.push((acc>>>bits)&mask);}}
  if(pad){if(bits)out.push((acc<<(to-bits))&mask);}else need(bits<from&&((acc<<(to-bits))&mask)===0,'BECH32_PADDING_INVALID');return out;
}
export function bech32Encode(hrp,words){need(typeof hrp==='string'&&hrp.length>=1&&hrp.length<=83&&/^[\x21-\x7e]+$/.test(hrp)&&hrp===hrp.toLowerCase(),'BECH32_HRP_INVALID');need(Array.isArray(words)&&words.every(v=>Number.isInteger(v)&&v>=0&&v<32),'BECH32_DATA_INVALID');
  const mod=(polymod([...expand(hrp),...words,0,0,0,0,0,0])^1)>>>0,check=Array.from({length:6},(_,i)=>(mod>>>(5*(5-i)))&31),out=hrp+'1'+[...words,...check].map(v=>CHARS[v]).join('');need(out.length<=90,'BECH32_LENGTH_INVALID');return out;
}
export function bech32Decode(value){need(typeof value==='string'&&value.length>=8&&value.length<=90&&/^[\x21-\x7e]+$/.test(value)&&(value===value.toLowerCase()||value===value.toUpperCase()),'BECH32_CASE_OR_LENGTH');const s=value.toLowerCase(),index=s.lastIndexOf('1');need(index>=1&&index+7<=s.length,'BECH32_SEPARATOR_INVALID');const hrp=s.slice(0,index),words=[...s.slice(index+1)].map(c=>CHARS.indexOf(c));need(words.every(v=>v>=0)&&polymod([...expand(hrp),...words])===1,'BECH32_CHECKSUM_INVALID');return {hrp,words:words.slice(0,-6)};}
export function accountAddress(hrp,payload){need(/^[a-z][a-z0-9]{1,20}$/.test(hrp)&&Buffer.from(payload).length===20,'COSMOS_ADDRESS_INPUT');return bech32Encode(hrp,convertBits(payload,8,5,true));}
export function decodeAccountAddress(s,expectedHrp){const r=bech32Decode(s);need(r.hrp===expectedHrp,'ADDRESS_NETWORK_PREFIX_MISMATCH');const payload=Buffer.from(convertBits(r.words,5,8,false));need(payload.length===20,'COSMOS_ADDRESS_LENGTH');return payload;}
export function witnessAddress(hrp,payload){need(['bc','tb','bcrt'].includes(hrp)&&Buffer.from(payload).length===20,'P2WPKH_ADDRESS_INPUT');return bech32Encode(hrp,[0,...convertBits(payload,8,5,true)]);}
export function decodeWitnessAddress(s,expectedHrp='bcrt'){const r=bech32Decode(s);need(r.hrp===expectedHrp&&r.words[0]===0,'BITCOIN_NETWORK_OR_WITNESS_VERSION');const p=Buffer.from(convertBits(r.words.slice(1),5,8,false));need(p.length===20,'BITCOIN_P2WPKH_ONLY');return p;}
