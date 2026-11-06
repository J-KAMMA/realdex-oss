/** Stellar StrKey account IDs only (G..., Ed25519 public keys); no seed/muxed parsing. */
import {need} from '../lib/guard.mjs';
const ALPHABET='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16(data){let crc=0;for(const b of data){crc^=b<<8;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;}return crc;}
function base32(data){let acc=0,bits=0,s='';for(const n of data){acc=((acc<<8)|n)&65535;bits+=8;while(bits>=5){bits-=5;s+=ALPHABET[(acc>>>bits)&31];}}if(bits)s+=ALPHABET[(acc<<(5-bits))&31];return s;}
export function stellarAddress(pub){const p=Buffer.from(pub);need(p.length===32,'STELLAR_PUBLIC_KEY_LENGTH');const data=Buffer.concat([Buffer.from([48]),p]),c=crc16(data),b=Buffer.from([c&255,c>>>8]);return base32(Buffer.concat([data,b]));}
export function decodeStellarAddress(s){need(typeof s==='string'&&/^G[A-Z2-7]{55}$/.test(s),'STELLAR_G_ADDRESS_REQUIRED');let acc=0,bits=0;const out=[];for(const c of s){acc=((acc<<5)|ALPHABET.indexOf(c))&65535;bits+=5;if(bits>=8){bits-=8;out.push((acc>>>bits)&255);}}const b=Buffer.from(out);need(b.length===35&&b[0]===48&&crc16(b.subarray(0,33))===b.readUInt16LE(33),'STELLAR_STRKEY_CHECKSUM');need(stellarAddress(b.subarray(1,33))===s,'STELLAR_STRKEY_NONCANONICAL');return b.subarray(1,33);}
