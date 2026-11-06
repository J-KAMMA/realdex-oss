/** Independent encrypted relay journal. Never opens the user's wallet or wallet API. */
import path from 'node:path';
import {randomBytes,randomUUID,scrypt as scryptCallback,createCipheriv,createDecipheriv} from 'node:crypto';
import {promisify} from 'node:util';
import {PrivateStore} from '../wallet/lib/storage.mjs';
import {need,shape,canonical,uint} from '../wallet/lib/guard.mjs';
import {generateSecret,keyInfo} from '../wallet/lib/keys.mjs';
import {cosmosAddress} from '../wallet/non-evm/cosmos-offline.mjs';
import {validatePolicy,relayNetworks,hashObject,jobId,validatePacketForRoute,feeStatus} from './policy.mjs';
import {verifyAction} from './codec.mjs';
const scrypt=promisify(scryptCallback);
const SCHEMA='realdex.relay-vault.v1';
const KDF=Object.freeze({name:'scrypt',N:131072,r:8,p:1});
const MAX_PLAIN=450000;
const STATES=['signed','broadcast-unknown','broadcast','included','failed'];
async function derive(password,salt){
  need(typeof password==='string'&&Buffer.byteLength(password)>=12&&Buffer.byteLength(password)<=1024,'RELAY_PASSWORD_LENGTH');
  const p=Buffer.from(password);try{return await scrypt(p,Buffer.from(salt,'hex'),32,{N:KDF.N,r:KDF.r,p:KDF.p,maxmem:256<<20});}finally{p.fill(0);}
}
function envelope(raw){
  shape(raw,['schema','kdf','salt','iv','tag','ciphertext']);
  need(raw.schema===SCHEMA&&canonical(raw.kdf)===canonical(KDF)&&/^[a-f0-9]{32}$/.test(raw.salt)&&/^[a-f0-9]{24}$/.test(raw.iv)&&/^[a-f0-9]{32}$/.test(raw.tag),'RELAY_ENVELOPE');
  need(typeof raw.ciphertext==='string'&&raw.ciphertext.length>0&&raw.ciphertext.length<=MAX_PLAIN*2&&/^(?:[a-f0-9]{2})+$/.test(raw.ciphertext),'RELAY_CIPHERTEXT');
  return {schema:SCHEMA,kdf:KDF,salt:raw.salt,iv:raw.iv};
}
function encrypted(data,key,salt){
  const h={schema:SCHEMA,kdf:KDF,salt,iv:randomBytes(12).toString('hex')},p=Buffer.from(canonical(data));
  try{need(p.length<=MAX_PLAIN,'RELAY_JOURNAL_FULL');const c=createCipheriv('aes-256-gcm',key,Buffer.from(h.iv,'hex'));c.setAAD(Buffer.from(canonical(h)));
    const out=Buffer.concat([c.update(p),c.final()]);return JSON.stringify({...h,tag:c.getAuthTag().toString('hex'),ciphertext:out.toString('hex')})+'\n';
  }finally{p.fill(0);}
}
export function validateData(d){
  shape(d,['schema','id','revision','policy','policyHash','keys','jobs','actions','lastClock']);
  need(d.schema==='realdex.relay-data.v1'&&/^[a-f0-9-]{36}$/.test(d.id)&&Number.isSafeInteger(d.revision)&&d.revision>=0&&Number.isSafeInteger(d.lastClock)&&d.lastClock>=0,'RELAY_DATA');
  const policy=validatePolicy(d.policy);need(d.policyHash===hashObject(policy),'RELAY_POLICY_CHANGED');
  const networks=relayNetworks(policy);need(Array.isArray(d.keys)&&d.keys.length===networks.length,'RELAY_KEYS');
  const networkIds=new Set(),publicKeys=new Set();
  for(const k of d.keys){shape(k,['networkId','secretHex','publicKeyHex','address']);const n=networks.find(n=>n.id===k.networkId);
    need(n&&!networkIds.has(n.id)&&/^[a-f0-9]{64}$/.test(k.secretHex),'RELAY_KEY_IDENTITY');networkIds.add(n.id);
    const secret=Buffer.from(k.secretHex,'hex');let info;try{info=keyInfo('cosmos',secret);}finally{secret.fill(0);}
    need(info.publicKeyHex===k.publicKeyHex&&cosmosAddress(k.publicKeyHex,n.hrp)===k.address&&!publicKeys.has(k.publicKeyHex),'RELAY_DISTINCT_KEYS_REQUIRED');publicKeys.add(k.publicKeyHex);
  }
  need(Array.isArray(d.jobs)&&d.jobs.length<=policy.maxJobs&&Array.isArray(d.actions)&&d.actions.length<=256,'RELAY_DATA_LIMIT');
  const jobs=new Map();
  for(const j of d.jobs){
    shape(j,['id','routeId','sourceTxHash','packet','status','lastError','failures','nextAt','createdAt']);
    const r=policy.routes.find(r=>r.id===j.routeId);need(r&&j.id===jobId(r,j.sourceTxHash)&&!jobs.has(j.id),'RELAY_JOB_IDENTITY');jobs.set(j.id,j);
    if(j.packet)validatePacketForRoute(j.packet,r);
    need(['queued','active','settled-observed','blocked'].includes(j.status),'RELAY_JOB_STATE');
    need(j.lastError===null||/^[A-Z0-9_-]{1,100}$/.test(j.lastError),'RELAY_ERROR_TEXT');
    for(const v of [j.failures,j.nextAt,j.createdAt])need(Number.isSafeInteger(v)&&v>=0,'RELAY_JOB_TIME');
  }
  const ids=new Set(),nonces=new Set();
  for(const a of d.actions){
    shape(a,['id','jobId','kind','networkId','chainId','accountNumber','sequence','timeoutHeight','feeAtomic','feeDenom','gasLimit','bodyBase64','txRawBase64','txHash','state','createdAt','evidence']);
    need(/^[a-f0-9-]{36}$/.test(a.id)&&!ids.has(a.id)&&STATES.includes(a.state)&&Number.isSafeInteger(a.createdAt)&&a.createdAt>=0,'RELAY_ACTION');ids.add(a.id);
    const j=jobs.get(a.jobId),r=policy.routes.find(r=>r.id===j?.routeId),k=d.keys.find(k=>k.networkId===a.networkId),f=policy.fees.find(f=>f.networkId===a.networkId);
    need(j?.packet&&r&&k&&f,'RELAY_ACTION_BINDING');
    for(const v of [a.accountNumber,a.sequence,a.timeoutHeight,a.gasLimit,a.feeAtomic])uint(v,(1n<<64n)-1n);
    need(a.feeAtomic===f.feeAtomic&&a.gasLimit===f.gasLimit&&BigInt(a.timeoutHeight)>0n,'RELAY_ACTION_POLICY');
    const nonce=canonical([a.networkId,a.accountNumber,a.sequence]);need(!nonces.has(nonce),'RELAY_NONCE_REUSED');nonces.add(nonce);
    verifyAction(a,r,j.packet,k.publicKeyHex);
    if(a.evidence!==null){shape(a.evidence,['height','blockHash','code','inclusionVerified']);need(Number.isSafeInteger(a.evidence.height)&&a.evidence.height>0&&/^[A-F0-9]{64}$/.test(a.evidence.blockHash)&&/^\d+$/.test(a.evidence.code)&&a.evidence.inclusionVerified===true,'RELAY_EVIDENCE');}
    need((a.state==='included'||a.state==='failed')===(a.evidence!==null),'RELAY_EVIDENCE_STATE');
  }
  for(const n of networks){const f=feeStatus(d,n.id);need(f.signedTransactions<=f.maxTransactions&&BigInt(f.remainingFeeAtomic)>=0n,'RELAY_BUDGET_EXCEEDED');}
  return d;
}
export class RelayVault {
  constructor(directory){this.store=new PrivateStore(directory);this.store.file=path.join(this.store.directory,'relay-vault.json');this.key=null;this.data=null;this.salt=null;}
  check(){need(this.key&&this.data,'RELAY_LOCKED');this.store.assertOwned();}
  async create(policy,password,{now=Date.now}={}){
    need(!this.store.exists(),'RELAY_ALREADY_EXISTS');policy=validatePolicy(policy);const clock=now();need(policy.expiresAt>clock&&policy.expiresAt<=clock+7*86400000,'RELAY_EXPIRY_MAX_7_DAYS');
    const salt=randomBytes(16).toString('hex'),key=await derive(password,salt),keys=[];
    try{
      for(const n of relayNetworks(policy)){const secret=generateSecret('cosmos');try{const i=keyInfo('cosmos',secret);keys.push({networkId:n.id,secretHex:secret.toString('hex'),publicKeyHex:i.publicKeyHex,address:cosmosAddress(i.publicKeyHex,n.hrp)});}finally{secret.fill(0);}}
      const d=validateData({schema:'realdex.relay-data.v1',id:randomUUID(),revision:0,policy,policyHash:hashObject(policy),keys,jobs:[],actions:[],lastClock:clock});
      this.store.write(encrypted(d,key,salt),{create:true});this.data=d;this.key=key;this.salt=salt;return this.publicState();
    }catch(e){key.fill(0);throw e;}
  }
  async unlock(password){
    need(!this.key,'RELAY_ALREADY_UNLOCKED');const raw=JSON.parse(this.store.read()),h=envelope(raw),key=await derive(password,raw.salt);let plain;
    try{const c=createDecipheriv('aes-256-gcm',key,Buffer.from(raw.iv,'hex'));c.setAAD(Buffer.from(canonical(h)));c.setAuthTag(Buffer.from(raw.tag,'hex'));plain=Buffer.concat([c.update(Buffer.from(raw.ciphertext,'hex')),c.final()]);
      const d=validateData(JSON.parse(plain.toString('utf8')));this.data=d;this.key=key;this.salt=raw.salt;return this.publicState();
    }catch{key.fill(0);throw Error('RELAY_AUTHENTICATION_OR_JOURNAL_FAILED');}finally{plain?.fill(0);}
  }
  update(fn){
    this.check();const next=structuredClone(this.data);
    try{fn(next);next.revision++;validateData(next);this.store.write(encrypted(next,this.key,this.salt));this.data=next;}
    catch(e){this.lock();throw e;}
  }
  enqueue(routeId,sourceTxHash,now=Date.now()){
    this.check();const r=this.data.policy.routes.find(r=>r.id===routeId);need(r,'RELAY_ROUTE_NOT_ALLOWED');sourceTxHash=sourceTxHash.toUpperCase();const id=jobId(r,sourceTxHash);
    if(this.data.jobs.some(j=>j.id===id))return id;need(this.data.jobs.length<this.data.policy.maxJobs,'RELAY_JOB_LIMIT');
    this.update(d=>d.jobs.push({id,routeId,sourceTxHash,packet:null,status:'queued',lastError:null,failures:0,nextAt:0,createdAt:now}));return id;
  }
  publicState(){this.check();return {schema:'realdex.relay-status.v1',policyHash:this.data.policyHash,expiresAt:this.data.policy.expiresAt,keys:this.data.keys.map(({secretHex,...k})=>k),budgets:this.data.keys.map(k=>feeStatus(this.data,k.networkId)),jobs:this.data.jobs.map(({packet,...j})=>({...j,packetSequence:packet?.sequence??null})),actions:this.data.actions.map(({bodyBase64,txRawBase64,...a})=>a),assetWalletAccess:false,productionReady:false};}
  lock(){this.key?.fill(0);this.key=null;if(this.data)for(const k of this.data.keys)k.secretHex=null;this.data=null;this.salt=null;}
  close(){this.lock();this.store.close();}
}
