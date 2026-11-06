/** ICP Principal binary/text conversion (CRC32 + unpadded RFC4648 base32).
 * This validates identifiers, not ownership, canister code or ledger honesty. */
import {check,keys,freeze} from '../extended/guard.mjs';
const ALPHABET='abcdefghijklmnopqrstuvwxyz234567';
export function crc32(bytes){check(bytes instanceof Uint8Array,'BYTES_REQUIRED');let c=0xffffffff;
 for(const b of bytes){c^=b;for(let j=0;j<8;j++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
export function principalText(bytes){check(bytes instanceof Uint8Array&&bytes.length<=29,'PRINCIPAL_LENGTH_INVALID');
 const checksum=crc32(bytes),input=new Uint8Array(4+bytes.length);new DataView(input.buffer).setUint32(0,checksum);input.set(bytes,4);
 let acc=0,bits=0,out='';for(const b of input){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;out+=ALPHABET[(acc>>>bits)&31];}acc&=(1<<bits)-1;}
 if(bits)out+=ALPHABET[(acc<<(5-bits))&31];return out.match(/.{1,5}/g).join('-');
}
export function principalBytes(value){
 check(typeof value==='string'&&value.length<=63&&/^[a-z2-7]{1,5}(?:-[a-z2-7]{1,5})*$/i.test(value),'PRINCIPAL_INVALID');
 const s=value.toLowerCase().replaceAll('-','');let acc=0,bits=0;const out=[];
 for(const c of s){acc=(acc<<5)|ALPHABET.indexOf(c);bits+=5;if(bits>=8){bits-=8;out.push((acc>>>bits)&255);}acc&=(1<<bits)-1;}
 check(acc===0&&out.length>=4&&out.length<=33,'PRINCIPAL_PADDING_INVALID');const all=Uint8Array.from(out),bytes=all.slice(4);
 check(new DataView(all.buffer).getUint32(0)===crc32(bytes),'PRINCIPAL_CHECKSUM_INVALID');
 check(principalText(bytes)===value.toLowerCase(),'PRINCIPAL_NONCANONICAL');return bytes;
}
export function normalizePrincipal(value){return principalText(principalBytes(value));}
export function canisterPrincipal(value){const bytes=principalBytes(value);
 check(bytes.length>0&&bytes.at(-1)===1,'CANISTER_PRINCIPAL_REQUIRED');return principalText(bytes);}
export function icrcAccount(raw){keys(raw,['owner'],['subaccount']);const owner=normalizePrincipal(raw.owner);
 const sub=raw.subaccount??'0'.repeat(64);check(typeof sub==='string'&&/^[0-9a-fA-F]{64}$/.test(sub),'SUBACCOUNT_32_BYTES_REQUIRED');
 return freeze({owner,subaccount:sub.toLowerCase(),key:JSON.stringify([owner,sub.toLowerCase()])});
}
export function icrcAsset(network,ledger){check(typeof network==='string'&&/^icp:(?:mainnet|local-[a-z0-9-]{1,48})$/.test(network),'ICP_NETWORK_INVALID');
 const canister=canisterPrincipal(ledger);return freeze({network,kind:'icrc-ledger',canister,key:JSON.stringify([network,'icrc-ledger',canister]),executable:false});}
