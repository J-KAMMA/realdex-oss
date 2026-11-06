/** Canonical ABI subset for the immutable RealDEX account. No generic user-supplied ABI. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {need,shape,text,uint,hex,canonical} from '../lib/guard.mjs';
import {abiWord,abiAddress} from '../lib/transactions.mjs';
import {address,selector,keccak256} from '../../node/verified/keccak.mjs';
import {sha256,signDigest,recoverDigest} from '../lib/keys.mjs';
import {CURRENT_ARTIFACT,CURRENT_ARTIFACT_ID,LEGACY_ARTIFACT_ID,artifactForDescriptor,artifactIdForBuild,descriptorArtifactId,verifyArtifactRegistry} from './artifacts.mjs';
export const ZERO='0x'+'0'.repeat(40), U48=(1n<<48n)-1n, U128=(1n<<128n)-1n;
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const BUILD=CURRENT_ARTIFACT;
export {CURRENT_ARTIFACT_ID,LEGACY_ARTIFACT_ID,artifactForDescriptor,descriptorArtifactId};
export function verifyBuildSources(build=BUILD){
  verifyArtifactRegistry();artifactIdForBuild(build);need(build?.contracts?.RealDexSmartAccount&&build?.contracts?.RealDexSmartAccountFactory&&build?.sources,'SMART_BUILD_INVALID');
  for(const [name,hash] of Object.entries(build.sources)) need(sha256(fs.readFileSync(path.join(ROOT,name))).toString('hex')===hash,'SMART_SOURCE_BUILD_MISMATCH');
  return true;
}
const addressWord=a=>a===ZERO?'0'.repeat(64):abiAddress(a);
const bytesPart=data=>{const b=hex(data);return abiWord(b.length)+b.toString('hex').padEnd(Math.ceil(b.length/32)*64,'0');};
export function normalizeCalls(calls){
  need(Array.isArray(calls)&&calls.length>0&&calls.length<=8,'SMART_BATCH_LIMIT');
  return calls.map(c=>{shape(c,['target','value','data']);return {target:address(c.target),value:String(uint(c.value)),data:'0x'+hex(c.data).toString('hex')};});
}
export function callsTail(raw){
  const calls=normalizeCalls(raw),parts=calls.map(c=>abiAddress(c.target)+abiWord(c.value)+abiWord(96)+bytesPart(c.data));
  let offset=calls.length*32;
  const offsets=parts.map(p=>{const out=abiWord(offset);offset+=p.length/2;return out;});
  return abiWord(calls.length)+offsets.join('')+parts.join('');
}
export const callsHash=calls=>keccak256('0x'+abiWord(32)+callsTail(calls));
export function encodeOperation(raw){
  need(raw&&typeof raw.type==='string','SMART_OPERATION_REQUIRED');
  switch(raw.type){
    case 'deploy':shape(raw,['type','owner','salt']);hex(raw.salt,32);return selector('createAccount(address,bytes32)')+abiAddress(raw.owner)+raw.salt.slice(2).toLowerCase();
    case 'fund':shape(raw,['type','amountAtomic']);need(uint(raw.amountAtomic)>0n,'ZERO_TRANSFER');return '0x';
    case 'batch':shape(raw,['type','calls','expectedNonce','validUntil']);uint(raw.expectedNonce);uint(raw.validUntil,U48);return selector('executeBatch((address,uint256,bytes)[],uint256,uint48)')+abiWord(96)+abiWord(raw.expectedNonce)+abiWord(raw.validUntil)+callsTail(raw.calls);
    case 'grant-session':{
      shape(raw,['type','key','recipient','token','perCall','daily','total','validUntil']);
      const per=uint(raw.perCall,U128),daily=uint(raw.daily,U128),total=uint(raw.total,U128);uint(raw.validUntil,U48);
      need(per>0n&&per<=daily&&daily<=total,'SMART_SESSION_LIMITS_INVALID');
      return selector('grantSession(address,address,address,uint128,uint128,uint128,uint48)')+abiAddress(raw.key)+abiAddress(raw.recipient)+addressWord(raw.token)+abiWord(per)+abiWord(daily)+abiWord(total)+abiWord(raw.validUntil);
    }
    case 'revoke-session':shape(raw,['type','key']);return selector('revokeSession(address)')+abiAddress(raw.key);
    case 'revoke-all':shape(raw,['type']);return selector('revokeAllSessions()');
    case 'invalidate-signatures':shape(raw,['type']);return selector('invalidateSignatures()');
    case 'session-transfer':shape(raw,['type','key','generation','sessionNonce','amountAtomic']);address(raw.key);uint(raw.generation);uint(raw.sessionNonce);need(uint(raw.amountAtomic)>0n,'ZERO_TRANSFER');return selector('sessionTransfer(uint256,uint256,uint256)')+abiWord(raw.generation)+abiWord(raw.sessionNonce)+abiWord(raw.amountAtomic);
    default:throw Error('SMART_OPERATION_UNSUPPORTED');
  }
}
export function predictAddress(factory,owner,salt,build=BUILD){
  hex(salt,32);const derived=keccak256('0x'+abiAddress(owner)+salt.slice(2).toLowerCase());
  const initHash=keccak256(build.contracts.RealDexSmartAccount.creationCode+abiAddress(owner));
  return address('0x'+keccak256('0xff'+address(factory).slice(2)+derived.slice(2)+initHash.slice(2)).slice(-40));
}
export const factoryCode=(build=BUILD)=>build.contracts.RealDexSmartAccountFactory.runtimeTemplate;
export const factoryHash=(build=BUILD)=>keccak256(factoryCode(build));
export function accountCode(owner,factory,build=BUILD){
  const c=build.contracts.RealDexSmartAccount,b=Buffer.from(hex(c.runtimeTemplate));
  need(Object.keys(c.immutableReferences).sort().join(',')==='factory,owner','SMART_IMMUTABLE_NAMES_INVALID');
  for(const [name,refs] of Object.entries(c.immutableReferences)){
    const value=Buffer.from(abiAddress(name==='owner'?owner:factory),'hex');
    for(const {start,length} of refs){need(Number.isSafeInteger(start)&&length===32&&start>=0&&start+32<=b.length,'SMART_IMMUTABLE_RANGE');value.copy(b,start);}
  }
  return '0x'+b.toString('hex');
}
export function normalizeDescriptor(raw){
  shape(raw,['id','label','ownerAccountId','chainId','genesisHash','factory','address','salt'],['artifactId']);
  text(raw.id,80);text(raw.ownerAccountId,80);text(raw.label,80);uint(raw.chainId);hex(raw.genesisHash,32);hex(raw.salt,32);descriptorArtifactId(raw);
  return {...raw,factory:address(raw.factory),address:address(raw.address),salt:raw.salt.toLowerCase(),genesisHash:raw.genesisHash.toLowerCase()};
}
export function validateSmartData(data){
  const accounts=data.smartAccounts??[],messages=data.smartMessages??[];
  need(Array.isArray(accounts)&&accounts.length<=32&&Array.isArray(messages)&&messages.length<=128,'SMART_DATA_LIMIT');
  const ids=new Set(),addresses=new Set();
  for(const value of accounts){const d=normalizeDescriptor(value);need(canonical(d)===canonical(value),'SMART_DESCRIPTOR_NONCANONICAL');
    const owner=data.accounts.find(a=>a.id===d.ownerAccountId);need(owner?.kind==='local'&&owner.family==='evm','SMART_OWNER_REQUIRED');
    need(!ids.has(d.id)&&!addresses.has(`${d.chainId}:${d.genesisHash}:${d.address}`),'SMART_DUPLICATE_ACCOUNT');ids.add(d.id);addresses.add(`${d.chainId}:${d.genesisHash}:${d.address}`);
    const build=artifactForDescriptor(d);verifyBuildSources(build);need(predictAddress(d.factory,owner.address,d.salt,build)===d.address,'SMART_DERIVATION_MISMATCH');
  }
  const messageIds=new Set();for(const m of messages){
    shape(m,['id','smartAccountId','hash','message','validUntil','epoch','signature','digest']);
    const d=accounts.find(a=>a.id===m.smartAccountId),owner=d&&data.accounts.find(a=>a.id===d.ownerAccountId);need(d&&owner&&!messageIds.has(m.id),'SMART_MESSAGE_BINDING');messageIds.add(m.id);text(m.id,80);validateMessage(m.message);
    need(keccak256(Buffer.from(m.message))===m.hash&&messageDigest(d.chainId,d.address,m.hash,m.validUntil,m.epoch)===m.digest,'SMART_MESSAGE_CONTENT_MISMATCH');
    need(verifyMessage(m.signature,m.digest,m.validUntil,m.epoch)===owner.address,'SMART_MESSAGE_SIGNATURE_MISMATCH');
  }
  for(const r of data.journal){if(r.summary.smart){const s=r.summary.smart;shape(s,['descriptor','owner','operation','callsHash','request']);const d=normalizeDescriptor(s.descriptor);
    const account=accounts.find(a=>a.id===d.id);need(account&&canonical(account)===canonical(d),'SMART_JOURNAL_ACCOUNT_MISMATCH');
    const owner=data.accounts.find(a=>a.id===d.ownerAccountId);need(owner.address===s.owner,'SMART_OWNER_CHANGED');
    encodeOperation(s.operation);need(s.callsHash===(s.operation.type==='batch'?callsHash(s.operation.calls):null),'SMART_CALLS_HASH_MISMATCH');
  }}
}
export function assertSmartTransaction(record,decoded){
  const s=record.summary.smart;need(s,'SMART_RECORD_REQUIRED');
  const op=s.operation,d=s.descriptor,t=decoded.transaction;
  need(t.to===(op.type==='deploy'?d.factory:d.address)&&t.data===encodeOperation(op)&&t.value===(op.type==='fund'?op.amountAtomic:'0'),'SMART_SIGNED_CONTENT_MISMATCH');
  need(decoded.from===(op.type==='session-transfer'?op.key:s.owner)&&t.chainId===d.chainId,'SMART_SIGNER_MISMATCH');
}
/** Preserve exact signed UTF-8 bytes; permit line breaks but reject invisible direction controls. */
export function validateMessage(value){
  need(typeof value==='string'&&value.length>0&&value.length<=2048&&Buffer.byteLength(value)<=8192,'SMART_MESSAGE_INVALID');
  need(!/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value)&&Buffer.from(value).toString('utf8')===value,'SMART_MESSAGE_CONTROL_CHARACTER');
  return value;
}
export function messageDigest(chainId,account,hash,validUntil,epoch){
  uint(chainId);hex(hash,32);uint(validUntil,U48);uint(epoch);
  const type=s=>keccak256(Buffer.from(s)).slice(2);
  const domain=keccak256('0x'+type('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')+type('RealDEX Smart Account')+type('1')+abiWord(chainId)+abiAddress(account));
  const struct=keccak256('0x'+type('SmartAccountMessage(bytes32 hash,uint48 validUntil,uint256 epoch)')+hash.slice(2)+abiWord(validUntil)+abiWord(epoch));
  return keccak256('0x1901'+domain.slice(2)+struct.slice(2));
}
export function signMessage(secret,digest,validUntil,epoch){
  const s=signDigest(secret,hex(digest,32));
  return '0x'+BigInt(validUntil).toString(16).padStart(12,'0')+abiWord(epoch)+Buffer.from(s.toCompactRawBytes()).toString('hex')+(s.recovery+27).toString(16).padStart(2,'0');
}
export function verifyMessage(signature,digest,validUntil,epoch){
  const b=hex(signature,103);need(BigInt('0x'+b.subarray(0,6).toString('hex'))===uint(validUntil,U48)&&BigInt('0x'+b.subarray(6,38).toString('hex'))===uint(epoch),'SMART_SIGNATURE_ENVELOPE_INVALID');
  return recoverDigest(hex(digest,32),b.subarray(38,102),b[102]-27).address;
}
export function signatureCall(hash,signature){hex(hash,32);return selector('isValidSignature(bytes32,bytes)')+hash.slice(2)+abiWord(64)+bytesPart(signature);}
export function decodeBytesArray(raw,expected){
  const b=hex(raw);const read=o=>{need(o>=0&&o+32<=b.length,'SMART_RETURN_TRUNCATED');return BigInt('0x'+b.subarray(o,o+32).toString('hex'));};
  need(read(0)===32n&&read(32)===BigInt(expected)&&expected>0&&expected<=8,'SMART_RETURN_ARRAY_INVALID');let end=64+32*expected;const results=[];
  for(let i=0;i<expected;i++){const offset=read(64+32*i);need(offset===BigInt(end-64),'SMART_RETURN_OFFSET_INVALID');const n=read(end);need(n<=65536n,'SMART_RETURN_LIMIT');const start=end+32,length=Number(n);end=start+Math.ceil(length/32)*32;need(end<=b.length,'SMART_RETURN_TRUNCATED');need(b.subarray(start+length,end).every(x=>x===0),'SMART_RETURN_PADDING');results.push('0x'+b.subarray(start,start+length).toString('hex'));}
  need(end===b.length,'SMART_RETURN_TRAILING');return results;
}
