import {SETTINGS_SCHEMA,settingsRecord,settingsDigest,emptySettingsRecord,normalizedSettings,settingsTransition} from '../protected/settings.mjs';
import {validateStorageProtection,requireStorageProtection,validateStorageMigration} from '../protected/binding.mjs';
import {RETIRED,SUBMISSION_EXPIRED,retirementTarget,injectiveResolved,assertInjectiveSequenceAvailable} from '../injective/retirement.mjs';
import {IBC_OPERATION} from '../bridge/ibc-config.mjs';
import {isAuthzOperation} from '../non-evm/cosmos-authz-codec.mjs';
import {validateSmartData,assertSmartTransaction} from '../smart-account/codec.mjs';
import {validateNonEvmJournal,validateNonEvmRecord,NON_EVM_STATES} from '../non-evm/records.mjs';
import {validateInjectiveJournal,validateInjectiveRecord,INJECTIVE_STATES} from '../injective/records.mjs';
import {validateAgentData} from './agent-policy.mjs';
import {scrypt as scryptCallback, randomBytes, randomUUID, createCipheriv, createDecipheriv, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {need, shape, text, canonical, clone, hex} from './guard.mjs';
import {parseSignedEvmTransaction} from './transactions.mjs';
import {keyInfo, generateSecret, normalizePublicAccount, importSecret, sha256} from './keys.mjs';
const scrypt = promisify(scryptCallback);
export const KDF = Object.freeze({name:'scrypt', N:131072, r:8, p:1, length:32});
const SCHEMA='realdex.wallet-vault.v1';
// Ciphertext is hex encoded; the writer must obey the reader's stricter limit.
export const MAX_VAULT_PLAINTEXT_BYTES = 450000;
export const MAX_VAULT_PENDING_OPERATIONS = 32;
function passwordBytes(password) { need(typeof password==='string' && Buffer.byteLength(password)>=12 && Buffer.byteLength(password)<=1024,'PASSWORD_LENGTH_12_TO_1024_BYTES'); return Buffer.from(password,'utf8'); }
function header(raw) {
  shape(raw,['schema','kdf','cipher','salt','iv','tag','ciphertext']); need(raw.schema===SCHEMA && raw.cipher==='aes-256-gcm','VAULT_FORMAT_UNSUPPORTED');
  shape(raw.kdf,['name','N','r','p','length']); need(canonical(raw.kdf)===canonical(KDF),'KDF_PARAMETERS_UNSUPPORTED');
  hex(raw.salt,16,false);hex(raw.iv,12,false);hex(raw.tag,16,false); need(typeof raw.ciphertext==='string' && /^[0-9a-f]+$/.test(raw.ciphertext) && raw.ciphertext.length%2===0 && raw.ciphertext.length<=MAX_VAULT_PLAINTEXT_BYTES*2,'VAULT_CIPHERTEXT_INVALID');
  return {schema:raw.schema,kdf:raw.kdf,cipher:raw.cipher,salt:raw.salt,iv:raw.iv};
}
function parseEnvelope(s) { need(typeof s==='string' && Buffer.byteLength(s)<=1048576,'VAULT_SIZE_LIMIT'); let raw;try{raw=JSON.parse(s);}catch{throw Error('VAULT_FORMAT_INVALID');} header(raw);return raw; }
async function derive(password,salt) { const p=passwordBytes(password); try {return await scrypt(p,Buffer.from(salt,'hex'),32,{N:KDF.N,r:KDF.r,p:KDF.p,maxmem:256*1024*1024});}finally{p.fill(0);} }
function encrypt(payload,key,salt) {
  const h={schema:SCHEMA,kdf:KDF,cipher:'aes-256-gcm',salt,iv:randomBytes(12).toString('hex')};
  const cipher=createCipheriv('aes-256-gcm',key,Buffer.from(h.iv,'hex'),{authTagLength:16});cipher.setAAD(Buffer.from(canonical(h)));
  const plain=Buffer.from(canonical(payload));try {need(plain.length<=MAX_VAULT_PLAINTEXT_BYTES,'VAULT_PLAINTEXT_SIZE_LIMIT');const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);return JSON.stringify({...h,tag:cipher.getAuthTag().toString('hex'),ciphertext:ciphertext.toString('hex')})+'\n';}finally{plain.fill(0);}
}
function decrypt(raw,key) {
  let p;try{const d=createDecipheriv('aes-256-gcm',key,Buffer.from(raw.iv,'hex'),{authTagLength:16});d.setAAD(Buffer.from(canonical(header(raw))));d.setAuthTag(Buffer.from(raw.tag,'hex'));p=Buffer.concat([d.update(Buffer.from(raw.ciphertext,'hex')),d.final()]);return validatePayload(JSON.parse(p.toString('utf8')));}catch{throw Error('VAULT_AUTHENTICATION_FAILED');}finally{p?.fill(0);}
}
function validatePayload(p) {
  shape(p,['schema','id','revision','accountsVersion','backupVersion','accounts','journal'],['agentPolicies','agentRequests','nonEvmJournal','injectiveJournal','smartAccounts','smartMessages','storageProtection','protectedOwnerSettings','storageMigration']);if(p.storageProtection!==undefined)validateStorageProtection(p.storageProtection);need(p.schema==='realdex.wallet-data.v1' && /^[0-9a-f-]{36}$/.test(p.id),'VAULT_DATA_INVALID');
  for(const k of ['revision','accountsVersion','backupVersion'])need(Number.isSafeInteger(p[k])&&p[k]>=0,'VAULT_DATA_INVALID');
  need(p.backupVersion<=p.accountsVersion && p.accountsVersion<=p.revision,'VAULT_DATA_INVALID');
  need(Array.isArray(p.accounts)&&p.accounts.length<=64&&Array.isArray(p.journal)&&p.journal.length<=1000,'VAULT_DATA_LIMIT');const ids=new Set(),refs=new Set();
  for(const a of p.accounts){shape(a,['id','label','family','kind','address','secretHex']);need(/^[0-9a-f-]{36}$/.test(a.id)&&!ids.has(a.id),'ACCOUNT_ID_INVALID');ids.add(a.id);text(a.label);need(['local','watch'].includes(a.kind),'ACCOUNT_KIND_INVALID');
    if(a.kind==='local'){const b=importSecret(a.family,a.secretHex);try{need(keyInfo(a.family,b).address===a.address,'ACCOUNT_ADDRESS_MISMATCH');}finally{b.fill(0);}}
    else {need(a.secretHex===null,'WATCH_SECRET_FORBIDDEN');need(normalizePublicAccount(a.family,a.address)===a.address,'WATCH_ADDRESS_INVALID');}
    const r=a.family+':'+a.address;need(!refs.has(r),'DUPLICATE_ACCOUNT');refs.add(r);
  }
  const journalIds=new Set(),nonceKeys=new Set();
  for(const r of p.journal){
    shape(r,['id','intentId','nonceKey','accountId','family','state','createdAt','summary','signed'],['report','agent']);need(typeof r.id==='string'&&!journalIds.has(r.id)&&typeof r.intentId==='string'&&typeof r.nonceKey==='string'&&!nonceKeys.has(r.nonceKey),'JOURNAL_ID_INVALID');journalIds.add(r.id);nonceKeys.add(r.nonceKey);
    need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(r.state),'JOURNAL_STATE_INVALID');need(r.family==='evm'&&Number.isSafeInteger(r.createdAt)&&r.createdAt>=0,'JOURNAL_INVALID');
    const a=p.accounts.find(a=>a.id===r.accountId);need(a?.kind==='local'&&a.family==='evm','JOURNAL_ACCOUNT_INVALID');
    const decoded=parseSignedEvmTransaction(r.signed.rawTransaction);need(decoded.from===a.address&&decoded.from===r.signed.from&&decoded.transactionHash===r.signed.transactionHash&&decoded.signingDigest===r.signed.signingDigest,'JOURNAL_SIGNATURE_BINDING_INVALID');
    need(decoded.transaction.chainId===r.summary.chainId,'JOURNAL_CHAIN_BINDING_INVALID');if(r.summary.smart)assertSmartTransaction(r,decoded);
  }
  if(p.protectedOwnerSettings!==undefined){need(p.storageProtection!==undefined,'CP_SETTINGS_PROTECTION_REQUIRED');const record=settingsRecord(p.protectedOwnerSettings);need(record.revision<=p.revision,'CP_SETTINGS_REVISION');}
  if(p.storageMigration!==undefined){const migration=validateStorageMigration(p.storageMigration);need(p.storageProtection!==undefined&&migration.targetPairId===p.storageProtection.pairId,'VAULT_STORAGE_MIGRATION_INVALID');}
  validateSmartData(p);
  validateAgentData(p);
  validateNonEvmJournal(p);
  validateInjectiveJournal(p);
  return p;
}
export class Vault {
  constructor(store,{now=Date.now,autoLockMs=300000}={}) {
    need(Number.isSafeInteger(autoLockMs)&&autoLockMs>=1000&&autoLockMs<=900000,'AUTOLOCK_INVALID');this.store=store;this.now=now;this.autoLockMs=autoLockMs;this.key=null;this.data=null;this.salt=null;this.expiresAt=0;this.lastTime=now();this.epoch=0;this.queue=Promise.resolve();this.pendingOperations=0;this.cooldownUntil=0;this.failures=0;this.storageSession=null;
  }
  serial(fn) {
    // Capture authority when the operation is requested, not when the queue runs it.
    // Otherwise a queued unlock can reopen a vault AFTER an explicit owner lock.
    if (this.pendingOperations >= MAX_VAULT_PENDING_OPERATIONS) return Promise.reject(Error('VAULT_QUEUE_LIMIT'));
    const epoch = this.epoch;
    this.pendingOperations++;
    const execute = () => { need(epoch === this.epoch, 'LOCK_INTERRUPTED_OPERATION'); return fn(); };
    const p = this.queue.then(execute, execute).finally(() => { this.pendingOperations--; });
    this.queue = p.catch(() => {});
    return p;
  }
  check(){const t=this.now();if(t<this.lastTime || (this.key&&t>=this.expiresAt))this.lock();this.lastTime=t;need(this.key&&this.data,'VAULT_LOCKED');try{requireStorageProtection(this.data,this.store);this.store.assertSession?.(this.storageSession);}catch(e){this.lock();throw e;}}
  touch(){this.check();this.expiresAt=this.now()+this.autoLockMs;}
  lock(){this.storageSession=null;this.epoch++;this.key?.fill(0);this.key=null;if(this.data)for(const a of this.data.accounts)a.secretHex=null;this.data=null;this.salt=null;this.expiresAt=0;}
  status(){try{this.check();}catch{}let protectedStorage,exists;if(this.store.protection){try{protectedStorage=this.store.info();exists=this.store.exists();}catch(e){this.lock();exists=true;protectedStorage={scheme:this.store.protection.scheme,failed:true,error:/^CP_[A-Z_]+$/.test(e.message)?e.message:'CP_STORAGE_FAULT'};}}else exists=this.store.exists();return {...(protectedStorage?{protectedStorage}:{}),exists,locked:!this.key,expiresAt:this.key?this.expiresAt:null,accounts:this.data?this.publicAccounts():[],backupRequired:this.data?this.data.backupVersion!==this.data.accountsVersion:true,storage:'scrypt-aes256gcm',nativeSecretZeroizationGuaranteed:false};}
  publicAccounts(){this.check();return this.data.accounts.map(({secretHex,...a})=>clone(a));}
  save(){this.check();this.data.revision++;try{this.store.write(encrypt(this.data,this.key,this.salt));this.storageSession=this.store.sessionToken?.()??null;}catch(e){this.lock();throw e;}}
  protectedSettings(){
    this.check();need(this.store.protection!==undefined,'CP_SETTINGS_PROTECTION_REQUIRED');
    return clone(this.data.protectedOwnerSettings===undefined?emptySettingsRecord():settingsRecord(this.data.protectedOwnerSettings));
  }
  assertSettingsQuiescent(){
    this.check();
    need(this.data.journal.every(r=>['reported-confirmed','reported-reverted'].includes(r.state)),'CP_SETTINGS_UNRESOLVED_TRANSACTION');
    need((this.data.nonEvmJournal??[]).every(r=>['reported-finalized','reported-confirmed','reported-reverted'].includes(r.state)),'CP_SETTINGS_UNRESOLVED_TRANSACTION');
    need((this.data.injectiveJournal??[]).every(r=>[RETIRED,SUBMISSION_EXPIRED].includes(r.state)||(['reported-confirmed','reported-reverted'].includes(r.state)&&r.report?.received===true&&typeof r.report.height==='string'&&/^[1-9][0-9]*$/.test(r.report.height))),'CP_SETTINGS_UNRESOLVED_TRANSACTION');
  }
  async saveProtectedSettings(settings,expectedDigest){
    const next=normalizedSettings(settings);
    return this.serial(()=>{
      const before=this.protectedSettings();this.assertSettingsQuiescent();
      need(settingsDigest(before)===expectedDigest,'CP_SETTINGS_STALE');
      settingsTransition(before.settings,next);
      need(canonical(before.settings)!==canonical(next),'CP_SETTINGS_UNCHANGED');
      need(before.revision<Number.MAX_SAFE_INTEGER&&this.data.revision<Number.MAX_SAFE_INTEGER,'CP_SETTINGS_REVISION');
      const record=settingsRecord({schema:SETTINGS_SCHEMA,revision:before.revision+1,settings:next});
      const candidate=clone(this.data);candidate.protectedOwnerSettings=clone(record);
      // Validate before changing the live payload. The ordinary save increments payload revision once.
      validatePayload({...candidate,revision:candidate.revision+1});
      this.data=candidate;this.save();
      return {revision:record.revision,settingsSha256:settingsDigest(record),checkpointGeneration:this.store.info().generation};
    });
  }
  async create(password){return this.serial(async()=>{need(!this.store.exists(),'VAULT_ALREADY_EXISTS');const epoch=this.epoch,salt=randomBytes(16).toString('hex'),key=await derive(password,salt);if(epoch!==this.epoch){key.fill(0);throw Error('LOCK_INTERRUPTED_OPERATION');}
    const data={schema:'realdex.wallet-data.v1',id:randomUUID(),revision:0,accountsVersion:0,backupVersion:0,accounts:[],journal:[]};if(this.store.protection)data.storageProtection=clone(this.store.protection);
    try{this.store.write(encrypt(data,key,salt),{create:true});this.storageSession=this.store.sessionToken?.()??null;}catch(e){key.fill(0);throw e;}this.key=key;this.salt=salt;this.data=data;this.expiresAt=this.now()+this.autoLockMs;return this.status();});}
  async unlock(password){return this.serial(async()=>{need(!this.key,'ALREADY_UNLOCKED');need(this.now()>=this.cooldownUntil,'UNLOCK_RATE_LIMITED');const raw=parseEnvelope(this.store.read()),session=this.store.sessionToken?.()??null,epoch=this.epoch,key=await derive(password,raw.salt);
    try{need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');const data=decrypt(raw,key);requireStorageProtection(data,this.store);this.store.assertSession?.(session);this.storageSession=session;this.data=data;this.key=key;this.salt=raw.salt;this.expiresAt=this.now()+this.autoLockMs;this.lastTime=this.now();this.failures=0;return this.status();}
    catch(e){key.fill(0);this.failures++;this.cooldownUntil=this.now()+Math.min(30000,1000*2**Math.min(this.failures-1,5));throw e;}});}
  async addAccount({family,label,secretHex,watchAddress}){return this.serial(async()=>{this.touch();text(label);need(!(secretHex!==undefined&&watchAddress!==undefined),'ACCOUNT_INPUT_CONFLICT');need(this.data.accounts.length<64,'ACCOUNT_LIMIT');let secret;
    try {const kind=watchAddress===undefined?'local':'watch';if(kind==='local')secret=secretHex===undefined?generateSecret(family):importSecret(family,secretHex);
      const account={id:randomUUID(),label,family,kind,address:secret?keyInfo(family,secret).address:normalizePublicAccount(family,watchAddress),secretHex:secret?secret.toString('hex'):null};
      need(!this.data.accounts.some(a=>a.family===family&&a.address===account.address),'DUPLICATE_ACCOUNT');this.data.accounts.push(account);this.data.accountsVersion++;this.save();return this.publicAccounts().find(a=>a.id===account.id);
    }finally{secret?.fill(0);}});}
  async backup(){return this.serial(async()=>{this.touch();const encrypted=this.store.read();return {encrypted,sha256:sha256(Buffer.from(encrypted)).toString('hex'),accountsVersion:this.data.accountsVersion};});}
  async verifyBackup(encrypted,password){return this.serial(async()=>{this.touch();const epoch=this.epoch,raw=parseEnvelope(encrypted),key=await derive(password,raw.salt);try {const other=decrypt(raw,key);requireStorageProtection(other,this.store);need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');this.check();need(other.id===this.data.id&&other.accountsVersion===this.data.accountsVersion&&canonical(other.accounts)===canonical(this.data.accounts)&&canonical(other.smartAccounts??[])===canonical(this.data.smartAccounts??[]),'BACKUP_ACCOUNT_SET_MISMATCH');if(this.store.protection){this.store.assertExactBackup(encrypted);need(canonical(other)===canonical(this.data),'BACKUP_NOT_CURRENT');if(this.data.backupVersion!==this.data.accountsVersion){this.data.backupVersion=this.data.accountsVersion;this.save();}const latest=this.store.read();return {verified:true,accounts:this.publicAccounts(),encrypted:latest,sha256:sha256(Buffer.from(latest)).toString('hex'),protectedStorage:this.store.info()};}this.data.backupVersion=this.data.accountsVersion;this.save();return {verified:true,accounts:this.publicAccounts()};}finally{key.fill(0);}});}
  async restore(encrypted,password){return this.serial(async()=>{if(this.store.protection){need(!this.key,'RESTORE_REQUIRES_LOCKED');this.store.assertExactBackup(encrypted);const raw=parseEnvelope(encrypted),epoch=this.epoch,key=await derive(password,raw.salt);try{const data=decrypt(raw,key);requireStorageProtection(data,this.store);need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');this.store.restoreExact(encrypted);return {restored:true,locked:true,exactCheckpointRestore:true,accounts:data.accounts.map(({secretHex,...a})=>a)};}finally{key.fill(0);}}need(!this.store.exists(),'RESTORE_REQUIRES_EMPTY_DIRECTORY');const raw=parseEnvelope(encrypted),epoch=this.epoch,key=await derive(password,raw.salt);try {const data=decrypt(raw,key);requireStorageProtection(data,this.store);need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');data.backupVersion=0;for(const policy of data.agentPolicies??[]){policy.status='revoked';policy.tokenHash=null;}data.revision++;this.store.write(encrypt(data,key,raw.salt),{create:true});return {restored:true,locked:true,accounts:data.accounts.map(({secretHex,...a})=>a)};}finally{key.fill(0);}});}
  async exportProtectedMigration(targetProtection,migration){return this.serial(async()=>{
    this.touch();need(this.store.protection!==undefined,'CP_MIGRATION_SOURCE_PROTECTION_REQUIRED');this.assertSettingsQuiescent();
    need(this.data.backupVersion===this.data.accountsVersion,'BACKUP_VERIFICATION_REQUIRED');
    const target=validateStorageProtection(targetProtection),record=validateStorageMigration(migration);
    need(record.sourcePairId===this.store.protection.pairId&&record.targetPairId===target.pairId,'VAULT_STORAGE_MIGRATION_INVALID');
    const candidate=clone(this.data);candidate.storageProtection=clone(target);candidate.storageMigration=clone(record);
    for(const policy of candidate.agentPolicies??[]){policy.status='revoked';policy.tokenHash=null;}
    need(candidate.revision<Number.MAX_SAFE_INTEGER,'VAULT_DATA_INVALID');candidate.revision++;candidate.backupVersion=candidate.accountsVersion;
    validatePayload(candidate);const encrypted=encrypt(candidate,this.key,this.salt);
    return {encrypted,sha256:sha256(Buffer.from(encrypted)).toString('hex'),vaultId:candidate.id,accountsVersion:candidate.accountsVersion,revision:candidate.revision};
  });}
  async importProtectedMigration(encrypted,password,expectedMigration,expectedMetadata){return this.serial(async()=>{
    need(this.store.protection!==undefined&&!this.key,'CP_MIGRATION_TARGET_NOT_EMPTY');
    shape(expectedMetadata,['vaultId','accountsVersion','revision']);
    const expected=validateStorageMigration(expectedMigration),raw=parseEnvelope(encrypted),epoch=this.epoch,key=await derive(password,raw.salt);
    try{const data=decrypt(raw,key);requireStorageProtection(data,this.store);const migration=validateStorageMigration(data.storageMigration);
      need(canonical(migration)===canonical(expected)&&migration.targetPairId===this.store.protection.pairId,'VAULT_STORAGE_MIGRATION_MISMATCH');
      need(data.id===expectedMetadata.vaultId&&data.accountsVersion===expectedMetadata.accountsVersion&&data.revision===expectedMetadata.revision,'CP_MIGRATION_METADATA_MISMATCH');
      need(data.backupVersion===data.accountsVersion,'CP_MIGRATION_BACKUP_REQUIRED');
      need((data.agentPolicies??[]).every(p=>p.status==='revoked'&&p.tokenHash===null),'CP_MIGRATION_AGENT_AUTHORITY');
      need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');
      const already=this.store.exists();
      if(already)need(this.store.read()===encrypted,'CP_MIGRATION_TARGET_NOT_EMPTY');else this.store.write(encrypted,{create:true});
      return {imported:true,alreadyImported:already,locked:true,vaultId:data.id,accountsVersion:data.accountsVersion,revision:data.revision,storageMigration:clone(migration),accounts:data.accounts.map(({secretHex,...a})=>a)};
    }finally{key.fill(0);}
  });}
  async changePassword(oldPassword,newPassword){return this.serial(async()=>{this.touch();const raw=parseEnvelope(this.store.read()),epoch=this.epoch,old=await derive(oldPassword,raw.salt);let next;try{decrypt(raw,old);const salt=randomBytes(16).toString('hex');next=await derive(newPassword,salt);need(epoch===this.epoch,'LOCK_INTERRUPTED_OPERATION');this.check();const data=clone(this.data);data.backupVersion=0;data.revision++;
      // The rename may already have committed when a durability error arrives.
      // Never keep the old in-memory key/session alive or retry a password change.
      try { this.store.write(encrypt(data,next,salt)); }
      catch (error) { this.lock(); throw error; }
      this.lock();return {changed:true,locked:true};}finally{old.fill(0);next?.fill(0);}});}
  account(id){this.check();const a=this.data.accounts.find(a=>a.id===id);need(a,'ACCOUNT_NOT_FOUND');return a;}
  async signAndRecord(accountId,intent,signer,{userActivity=true,commit=null}={}){return this.serial(async()=>{if(userActivity)this.touch();else this.check();need(this.data.backupVersion===this.data.accountsVersion,'BACKUP_VERIFICATION_REQUIRED');const a=this.account(accountId);need(a.kind==='local','WATCH_ONLY');need(this.data.journal.length<1000,'JOURNAL_CAPACITY_REQUIRES_ARCHIVE');need(!this.data.journal.some(r=>r.intentId===intent.id),'INTENT_ALREADY_SIGNED');
    if(intent.nonceKey)need(!this.data.journal.some(r=>r.nonceKey===intent.nonceKey),'NONCE_ALREADY_RESERVED');
    const secret=Buffer.from(a.secretHex,'hex');try{const signed=signer(secret);need(signed && typeof signed==='object' && !(signed instanceof Promise),'SYNCHRONOUS_SIGNER_REQUIRED');
      const record={id:randomUUID(),intentId:intent.id,nonceKey:intent.nonceKey??null,accountId:a.id,family:a.family,state:'signed',createdAt:this.now(),summary:clone(intent.summary),signed:clone(signed)};
      if(commit){const candidate=clone(this.data);candidate.journal.push(record);commit(candidate,record);this.data=candidate;}else this.data.journal.push(record);try{this.save();}catch(e){this.lock();throw e;}return clone(record);
    }finally{secret.fill(0);}});}
  async journal(){return this.serial(async()=>{this.check();return clone(this.data.journal);});}
  /** Compare-and-swap prevents a late RPC response overwriting a newer journal state. */
  async applyObservation(expected,state,report){return this.serial(async()=>{
    this.check();const r=this.data.journal.find(r=>r.id===expected.id);need(r,'RECORD_NOT_FOUND');
    need(canonical(r)===canonical(expected),'OBSERVATION_SUPERSEDED');
    need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(state),'JOURNAL_STATE_INVALID');
    r.state=state;r.report=clone(report);this.save();return clone(r);
  });}
  async updateRecord(id,state,details={}){return this.serial(async()=>{this.check();const r=this.data.journal.find(r=>r.id===id);need(r,'RECORD_NOT_FOUND');const allowed={signed:['broadcast-unknown'], 'broadcast-unknown':['broadcast-unknown','broadcast','reported-confirmed','reported-reverted'],broadcast:['broadcast-unknown','reported-confirmed','reported-reverted'],'reported-confirmed':[],'reported-reverted':[]};need(allowed[r.state].includes(state),'STATE_TRANSITION_FORBIDDEN');r.state=state;r.report=clone(details);this.save();return clone(r);});}
  async nonEvmRecords(){return this.serial(async()=>{this.check();return clone(this.data.nonEvmJournal??[]);});}
  async signNonEvmAndRecord(intent,signer){return this.serial(async()=>{
    this.touch();need(this.data.backupVersion===this.data.accountsVersion,'BACKUP_VERIFICATION_REQUIRED');
    const account=this.account(intent.accountId);need(account.kind==='local'&&account.family===intent.family,'NON_EVM_ACCOUNT_INVALID');
    const records=this.data.nonEvmJournal??[];need(records.length<128,'NON_EVM_JOURNAL_LIMIT');
    need(!records.some(r=>r.accountId===account.id&&r.summary.networkId===intent.networkId&&r.requestKey===intent.payment.requestKey),'PAYMENT_ALREADY_RECORDED');
    if(intent.family==='solana')need(!records.some(r=>r.accountId===account.id&&r.summary.networkId===intent.networkId&&!['reported-finalized','reported-reverted'].includes(r.state)),'SOLANA_UNRESOLVED_TRANSFER');
    if(['cosmos','stellar','aptos'].includes(intent.family)){
      const pending=records.filter(r=>r.family===intent.family&&r.summary.from===account.address&&r.summary.networkId===intent.networkId&&!['reported-confirmed','reported-reverted'].includes(r.state));
      if(intent.summary.operation.endsWith('-online')||pending.some(r=>r.summary.operation.endsWith('-online')))need(pending.length===0,'ACCOUNT_UNRESOLVED_TRANSFER');
    }
    if(['cosmos','stellar','aptos'].includes(intent.family))need(!records.some(r=>r.family===intent.family&&r.summary.sequenceKey===intent.summary.sequenceKey),intent.family.toUpperCase()+'_SEQUENCE_ALREADY_RESERVED');
    if(intent.family==='bitcoin')need(!records.some(r=>r.family==='bitcoin'&&r.summary.networkId===intent.networkId&&r.summary.outpoints.some(o=>intent.summary.outpoints.includes(o))),'BITCOIN_OUTPOINT_ALREADY_RESERVED');
    const secret=Buffer.from(account.secretHex,'hex');try{
      const signed=signer(secret);need(signed&&typeof signed==='object'&&!(signed instanceof Promise),'SYNCHRONOUS_SIGNER_REQUIRED');
      const record={id:randomUUID(),intentId:intent.id,requestKey:intent.payment.requestKey,paymentHash:intent.payment.paymentHash,accountId:account.id,family:intent.family,state:'signed',createdAt:this.now(),summary:clone(intent.summary),signed:clone(signed)};
      validateNonEvmRecord(record,this.data.accounts);
      need(!records.some(r=>(r.signed.signature??r.signed.requestId)===(signed.signature??signed.requestId)),'NON_EVM_SIGNATURE_ALREADY_RECORDED');
      this.data.nonEvmJournal=[...records,record];this.save();return clone(record);
    }finally{secret.fill(0);}
  });}
  async observeNonEvm(expected,state,report,{authorize=()=>{}}={}){return this.serial(async()=>{
    authorize();this.check();need((expected.family==='solana'||(expected.family==='bitcoin'&&expected.summary.operation==='bitcoin-p2wpkh-online')||(expected.family==='cosmos'&&(expected.summary.operation==='cosmos-bank-send-online'||expected.summary.operation===IBC_OPERATION||isAuthzOperation(expected.summary.operation)))||(['stellar','aptos'].includes(expected.family)&&expected.summary.operation===expected.family+'-native-'+(expected.family==='stellar'?'payment':'transfer')+'-online'))&&NON_EVM_STATES.includes(state),'NON_EVM_OBSERVATION_UNSUPPORTED');
    const record=(this.data.nonEvmJournal??[]).find(r=>r.id===expected.id);need(record&&canonical(record)===canonical(expected),'OBSERVATION_SUPERSEDED');
    record.state=state;record.report=clone(report);validateNonEvmRecord(record,this.data.accounts);this.save();return clone(record);
  });}

  async injectiveRecords(){return this.serial(async()=>{this.check();return clone(this.data.injectiveJournal??[]);});}
  async signInjectiveAndRecord(intent,signer){return this.serial(async()=>{
    this.touch();need(this.data.backupVersion===this.data.accountsVersion,'BACKUP_VERIFICATION_REQUIRED');const account=this.account(intent.accountId);need(account.kind==='local'&&account.family==='evm','INJECTIVE_OWNER_ACCOUNT_REQUIRED');const records=this.data.injectiveJournal??[];need(!records.some(r=>r.accountId===account.id&&!injectiveResolved(r)),'INJECTIVE_UNRESOLVED_TRANSACTION');need(records.length<64,'INJECTIVE_JOURNAL_LIMIT');
    need(!records.some(r=>r.accountId===account.id&&r.requestKey===intent.payment.requestKey),'INJECTIVE_REQUEST_ALREADY_RECORDED');assertInjectiveSequenceAvailable(records,intent.summary);
    const secret=Buffer.from(account.secretHex,'hex');try{const signed=signer(secret);need(signed&&typeof signed==='object'&&!(signed instanceof Promise),'SYNCHRONOUS_SIGNER_REQUIRED');
      const summary=clone(intent.summary);delete summary.review;const record={id:randomUUID(),intentId:intent.id,requestKey:intent.payment.requestKey,paymentHash:intent.payment.paymentHash,accountId:account.id,family:'injective',state:'signed',createdAt:this.now(),summary,signed:clone(signed)};validateInjectiveRecord(record,this.data.accounts);need(!records.some(r=>r.signed.requestId===record.signed.requestId),'INJECTIVE_TX_ALREADY_RECORDED');this.data.injectiveJournal=[...records,record];this.save();return clone(record);
    }finally{secret.fill(0);}
  });}
  async observeInjective(expected,state,report){return this.serial(async()=>{
    this.check();need(INJECTIVE_STATES.includes(state),'INJECTIVE_STATE_INVALID');const record=(this.data.injectiveJournal??[]).find(r=>r.id===expected.id);need(record&&canonical(record)===canonical(expected),'OBSERVATION_SUPERSEDED');
    const allowed={signed:['signed','broadcast-unknown','reported-confirmed','reported-reverted'],'broadcast-unknown':['broadcast-unknown','broadcast','reported-confirmed','reported-reverted'],broadcast:['broadcast-unknown','broadcast','reported-confirmed','reported-reverted'],'reported-confirmed':[],'reported-reverted':[],[RETIRED]:[],[SUBMISSION_EXPIRED]:[]};need(allowed[record.state].includes(state),'INJECTIVE_STATE_TRANSITION_FORBIDDEN');const updated={...clone(record),state,report:clone(report)};validateInjectiveRecord(updated,this.data.accounts);this.data.injectiveJournal=this.data.injectiveJournal.map(r=>r.id===record.id?updated:r);this.save();return clone(updated);
  });}

  /** Explicit retirement; never exposed through generic observation or a deletion API. */
  async retireInjective(expected,retirement,{authorize=()=>{}}={}){return this.serial(async()=>{
    authorize();this.check();const record=(this.data.injectiveJournal??[]).find(r=>r.id===expected.id);
    need(record&&canonical(record)===canonical(expected),'OBSERVATION_SUPERSEDED');
    const target=retirementTarget(record);
    const updated={...clone(record),state:target,retirement:clone(retirement)};
    validateInjectiveRecord(updated,this.data.accounts);authorize();
    this.data.injectiveJournal=this.data.injectiveJournal.map(r=>r.id===record.id?updated:r);this.save();return clone(updated);
  });}

  async addSmartAccount(descriptor){return this.serial(async()=>{
    this.touch();const candidate=clone(this.data);candidate.smartAccounts??=[];candidate.smartAccounts.push(clone(descriptor));
    validateSmartData(candidate);candidate.accountsVersion++;candidate.backupVersion=0;this.data=candidate;this.save();return clone(descriptor);
  });}
  async signSmartMessage(intent,signer){return this.serial(async()=>{
    this.touch();need(this.data.backupVersion===this.data.accountsVersion,'BACKUP_VERIFICATION_REQUIRED');
    const account=this.account(intent.accountId);need(account.family==='evm'&&account.kind==='local','SMART_OWNER_REQUIRED');
    const candidate=clone(this.data);candidate.smartMessages??=[];need(candidate.smartMessages.length<128,'SMART_MESSAGE_LIMIT');
    const secret=Buffer.from(account.secretHex,'hex');try{
      const signature=signer(secret);need(typeof signature==='string','SYNCHRONOUS_SIGNER_REQUIRED');
      const message={...clone(intent.message),signature};candidate.smartMessages.push(message);validateSmartData(candidate);this.data=candidate;this.save();return clone(message);
    }finally{secret.fill(0);}
  });}

}
