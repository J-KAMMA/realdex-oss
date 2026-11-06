/** UP01 integrated checkpoint+flock store. New pairs only; no INJ13 migration.
 * Disk hashes detect unilateral rollback, not a malicious owner or joint rollback.
 * Synchronous operations hold BOTH kernel leases; recovery never signs or sends.
 */
import fs from 'node:fs';import path from 'node:path';import {createHash,randomBytes} from 'node:crypto';
import {parseExactJson} from '../../node/extended/json.mjs';
import {PROTECTION_SCHEME} from './binding.mjs';
const MAX=1048576, SCHEMA='realdex.checkpoint-record.v1',claimed=new Set();
const need=(x,c)=>{if(!x)throw Error('CP_'+c);};
const sha=b=>createHash('sha256').update(b).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const identity=s=>({dev:String(s.dev),ino:String(s.ino)});
const shape=(o,ks,optional=[])=>need(o&&typeof o==='object'&&!Array.isArray(o)&&ks.every(k=>Object.hasOwn(o,k))&&Object.keys(o).every(k=>[...ks,...optional].includes(k)),'RECORD_FIELDS');
function privateStat(s,d=false,max=MAX){need((d?s.isDirectory():s.isFile()&&s.nlink===1&&s.size<=max)&&s.uid===process.getuid()&&(s.mode&0o077)===0,'UNSAFE_FILE');}
function readRegular(p,max=MAX,missing=false){
 let s;try{s=fs.lstatSync(p);}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
 privateStat(s,false,max);need(!s.isSymbolicLink(),'FILE_LINK');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const a=fs.fstatSync(fd);privateStat(a,false,max);need(same(a,s),'FILE_CHANGED');
  const b=Buffer.alloc(a.size+1),n=fs.readSync(fd,b,0,b.length,0);need(n===a.size,'FILE_CHANGED');
  need(same(fs.lstatSync(p),a),'FILE_CHANGED');return b.subarray(0,n);
 }finally{fs.closeSync(fd);}
}
function parse(b){const text=new TextDecoder('utf-8',{fatal:true}).decode(b);parseExactJson(text,{maxChars:8192,maxDepth:8,maxNodes:100});return JSON.parse(text);}
function point(p){
 shape(p,['generation','sha256','bytes']);need(typeof p.generation==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(p.generation),'GENERATION');
 need(Number.isSafeInteger(p.bytes)&&p.bytes>=0&&p.bytes<=MAX,'CIPHER_SIZE');
 need(p.generation==='0'?p.sha256===null&&p.bytes===0:typeof p.sha256==='string'&&/^[a-f0-9]{64}$/.test(p.sha256)&&p.bytes>0,'CIPHER_HASH');return p;
}
function value(r){return point({generation:r.generation,sha256:r.sha256,bytes:r.bytes});}
const token=p=>p.generation+':'+(p.sha256??'empty');
const matches=(b,p)=>p.sha256===null?b===null:b!==null&&b.length===p.bytes&&sha(b)===p.sha256;
export class CheckpointLeaseStore{
 constructor(directory,checkpoint,{fds=(process.env.REALDEX_PROTECTED_FDS??'').split(',').map(Number),onBoundary=()=>{},migration=false}={}){
  need(process.platform==='linux'&&process.arch==='x64'&&process.env.REALDEX_PROTECTED_MODE==='explicit-up01','MODE');
  need(fds.length===2&&fds.every(x=>Number.isInteger(x)&&x>=3&&!claimed.has(x))&&fds[0]!==fds[1],'FDS');
  this.directory=path.resolve(directory);this.checkpointDirectory=path.resolve(checkpoint);this.fds=fds;this.onBoundary=onBoundary;this.poisoned=false;this.migrationMode=migration===true;
  this.parts=[this.directory,this.checkpointDirectory].map((d,i)=>{
   need(fs.realpathSync(d)===d,'DIRECTORY_LINK');const s=fs.lstatSync(d);privateStat(s,true);
   const lockFile=path.join(d,'writer.lock'),lockStat=fs.fstatSync(fds[i]);privateStat(lockStat,false,4096);
   return {d,s,lockFile,lockStat,fd:fds[i]};
  });
  need(this.directory!==this.checkpointDirectory&&!this.directory.startsWith(this.checkpointDirectory+'/')&&!this.checkpointDirectory.startsWith(this.directory+'/'),'SEPARATE_DIRECTORIES');
  this.file=path.join(this.directory,'vault.json');this.stage=path.join(this.directory,'pending-ciphertext');
  this.cp=path.join(this.checkpointDirectory,'checkpoint.json');this.migrationPackagePath=path.join(this.checkpointDirectory,'migration-package.json');this.migrationMarkerPath=path.join(this.checkpointDirectory,'migration-out.json');
  try{
   this.assertOwned();
   const a=this.marker(this.parts[0]),b=this.marker(this.parts[1]);
   need(a.role==='vault'&&b.role==='checkpoint'&&a.pairId===b.pairId,'PAIR_CHANGED');
   this.protection=Object.freeze({scheme:PROTECTION_SCHEME,pairId:a.pairId});
   this.recoveryPerformed=false;this.recover();this.current=this.record();this.assertCurrent({allowMissing:true});
   fds.forEach(f=>claimed.add(f));
  }catch(e){this.fds=null;for(const f of fds)try{fs.closeSync(f);}catch{}throw e;}
 }
 marker(part){
  const b=Buffer.alloc(4097),n=fs.readSync(part.fd,b,0,b.length,0);need(n<=4096,'MARKER_SIZE');const m=parse(b.subarray(0,n));
  shape(m,['schema','pairId','vault','checkpoint','role']);
  need(m.schema==='realdex.protected-directory.v1'&&/^[a-f0-9]{64}$/.test(m.pairId),'MARKER');
  for(let i=0;i<2;i++){const role=['vault','checkpoint'][i];shape(m[role],['dev','ino']);const id=identity(this.parts[i].s);need(m[role].dev===id.dev&&m[role].ino===id.ino,'PAIR_CHANGED');}
  return m;
 }
 assertOwned(){
  need(this.fds!==null,'CLOSED');need(!this.poisoned,'RESTART_REQUIRED');
  for(const [i,p] of this.parts.entries()){
   const d=fs.lstatSync(p.d);privateStat(d,true);need(same(d,p.s)&&fs.realpathSync(p.d)===p.d,'DIRECTORY_CHANGED');
   const l=fs.lstatSync(p.lockFile),f=fs.fstatSync(p.fd);privateStat(l,false,4096);privateStat(f,false,4096);
   need(same(l,p.lockStat)&&same(f,p.lockStat),'LOCK_CHANGED');
   const m=this.marker(p);need(m.role===['vault','checkpoint'][i]&&(!this.protection||m.pairId===this.protection.pairId),'PAIR_CHANGED');
   const info=fs.readFileSync('/proc/self/fdinfo/'+p.fd,'utf8'),rows=info.split('\n').filter(s=>s.startsWith('lock:'));
   need(info.length<=16384&&rows.length===1,'LEASE_LOST');
   const match=/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+[a-f0-9]+:[a-f0-9]+:(\d+)\s+0\s+EOF\s*$/.exec(rows[0]);
   need(match&&match[1]===String(process.pid)&&match[2]===String(p.lockStat.ino),'LEASE_LOST');
  }
  if(!this.migrationMode&&this.protection)this.assertNoMigration();
 }
 migrationState(){
  const packageBytes=readRegular(this.migrationPackagePath,MAX,true),markerBytes=readRegular(this.migrationMarkerPath,65536,true);
  if(packageBytes===null&&markerBytes===null)return null;
  need(packageBytes!==null,'MIGRATION_PACKAGE_MISSING');
  if(markerBytes===null)return {phase:'incomplete',packageSha256:sha(packageBytes),packageText:new TextDecoder('utf-8',{fatal:true}).decode(packageBytes),marker:null};
  const marker=parse(markerBytes);shape(marker,['schema','pairId','phase','migrationId','targetPairId','targetDescriptorSha256','packageSha256','sourceGeneration','sourceSha256'],marker.phase==='retired'?['destinationReceiptSha256']:[]);
  need(marker.schema==='realdex.protected-migration-out.v1'&&marker.pairId===this.protection.pairId&&['pending','retired'].includes(marker.phase),'MIGRATION_MARKER');
  for(const k of ['migrationId','targetPairId','targetDescriptorSha256','packageSha256','sourceSha256'])need(typeof marker[k]==='string'&&/^[a-f0-9]{64}$/.test(marker[k]),'MIGRATION_MARKER');
  need(typeof marker.sourceGeneration==='string'&&/^[1-9][0-9]{0,18}$/.test(marker.sourceGeneration),'MIGRATION_MARKER');
  if(marker.phase==='retired')need(typeof marker.destinationReceiptSha256==='string'&&/^[a-f0-9]{64}$/.test(marker.destinationReceiptSha256),'MIGRATION_MARKER');
  need(sha(packageBytes)===marker.packageSha256,'MIGRATION_PACKAGE_CHANGED');
  return {phase:marker.phase,packageSha256:marker.packageSha256,packageText:new TextDecoder('utf-8',{fatal:true}).decode(packageBytes),marker};
 }
 assertNoMigration(){const state=this.migrationState();if(state)throw Error(state.phase==='retired'?'CP_MIGRATED_OUT':'CP_MIGRATION_PENDING');}
 beginMigration(packageText,marker){
  need(this.migrationMode,'MIGRATION_MODE_REQUIRED');this.assertOwned();this.assertCurrent();need(this.current.generation!=='0'&&this.current.sha256!==null,'MIGRATION_SOURCE_EMPTY');
  need(typeof packageText==='string'&&Buffer.byteLength(packageText)>0&&Buffer.byteLength(packageText)<=MAX,'MIGRATION_PACKAGE');
  shape(marker,['schema','pairId','phase','migrationId','targetPairId','targetDescriptorSha256','packageSha256','sourceGeneration','sourceSha256']);
  need(marker.schema==='realdex.protected-migration-out.v1'&&marker.pairId===this.protection.pairId&&marker.phase==='pending'&&marker.sourceGeneration===this.current.generation&&marker.sourceSha256===this.current.sha256,'MIGRATION_MARKER');
  need(marker.packageSha256===sha(Buffer.from(packageText)),'MIGRATION_PACKAGE_CHANGED');
  const existing=readRegular(this.migrationPackagePath,MAX,true),existingMarker=readRegular(this.migrationMarkerPath,65536,true);
  if(existing!==null)need(existing.equals(Buffer.from(packageText)),'MIGRATION_PACKAGE_CHANGED');else{this.atomic(this.migrationPackagePath,packageText,{create:true});this.onBoundary('migration-package');}
  if(existingMarker===null){this.atomic(this.migrationMarkerPath,JSON.stringify(marker)+'\n',{create:true});this.onBoundary('migration-marker');}
  else need(JSON.stringify(parse(existingMarker))===JSON.stringify(marker),'MIGRATION_MARKER_CHANGED');
  return this.migrationState();
 }
 finalizeMigration(receiptSha256){
  need(this.migrationMode,'MIGRATION_MODE_REQUIRED');this.assertOwned();need(typeof receiptSha256==='string'&&/^[a-f0-9]{64}$/.test(receiptSha256),'MIGRATION_RECEIPT');
  const state=this.migrationState();need(state&&state.marker&&state.phase==='pending','MIGRATION_NOT_PENDING');
  const retired={...state.marker,phase:'retired',destinationReceiptSha256:receiptSha256};this.atomic(this.migrationMarkerPath,JSON.stringify(retired)+'\n');this.onBoundary('migration-retired');return this.migrationState();
 }
 record(){
  const b=readRegular(this.cp,8192,true);need(b!==null,'CHECKPOINT_MISSING');const r=parse(b);
  const keys=['schema','pairId','phase','generation','sha256','bytes'];if(r.phase==='pending')keys.push('next');shape(r,keys);
  need(r.schema===SCHEMA&&r.pairId===this.protection.pairId&&['stable','pending'].includes(r.phase),'RECORD');
  value(r);if(r.phase==='pending'){point(r.next);need(BigInt(r.next.generation)===BigInt(r.generation)+1n&&r.next.sha256!==r.sha256,'NEXT_GENERATION');}
  return r;
 }
 syncDir(d){const fd=fs.openSync(d,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 atomic(p,data,{create=false}={}){
  this.assertOwned();const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);
  const old=readRegular(p,MAX,true);if(create)need(old===null,'FILE_EXISTS');
  const d=path.dirname(p),tmp=path.join(d,'.cp-write-'+randomBytes(16).toString('hex'));
  let fd=null;
  try{
   fd=fs.openSync(tmp,'wx',0o600);fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);fs.closeSync(fd);fd=null;
   this.assertOwned();
   if(create){fs.linkSync(tmp,p);fs.unlinkSync(tmp);}else fs.renameSync(tmp,p);
   this.syncDir(d);
  }finally{if(fd!==null)try{fs.closeSync(fd);}catch{}try{fs.unlinkSync(tmp);}catch(e){if(e.code!=='ENOENT')throw e;}}
 }
 persist(r){this.atomic(this.cp,JSON.stringify(r)+'\n');}
 stable(p){return {schema:SCHEMA,pairId:this.protection.pairId,phase:'stable',...p};}
 recover(){
  const r=this.record(),v=value(r),main=readRegular(this.file,MAX,true),staged=readRegular(this.stage,MAX,true);
  if(r.phase==='pending'){
   if(matches(main,r.next)){
    if(staged!==null)need(matches(staged,r.next),'STAGE_MISMATCH');
    const fd=fs.openSync(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    this.syncDir(this.directory);
   }else{
    need(matches(main,v),'RECOVERY_BASE_MISMATCH');need(matches(staged,r.next),'RECOVERY_STAGE_MISSING_OR_CHANGED');
    this.assertOwned();fs.renameSync(this.stage,this.file);this.syncDir(this.directory);
   }
   this.persist(this.stable(r.next));this.recoveryPerformed=true;
  }else{
   // Missing body is recoverable ONLY via exact backup; never re-enroll or create.
   need(main===null&&r.sha256!==null||matches(main,v),'CIPHERTEXT_MISMATCH');
  }
  // A pre-intent staged body was never acknowledged. Never promote it over a stable checkpoint.
  if(readRegular(this.stage,MAX,true)!==null){fs.unlinkSync(this.stage);this.syncDir(this.directory);}
  // Uncommitted atomic temp files can survive SIGKILL. They are never candidates for recovery.
  for(const d of [this.directory,this.checkpointDirectory]){
   const names=fs.readdirSync(d).filter(n=>/^\.cp-write-[a-f0-9]{32}$/.test(n));need(names.length<=16,'TOO_MANY_TEMPS');
   for(const name of names){readRegular(path.join(d,name),MAX);fs.unlinkSync(path.join(d,name));}
   if(names.length)this.syncDir(d);
  }
 }
 assertCurrent({allowMissing=false}={}){
  this.assertOwned();const r=this.record();need(r.phase==='stable','RESTART_REQUIRED');
  need(token(value(r))===token(value(this.current)),'CHECKPOINT_CHANGED');
  const b=readRegular(this.file,MAX,true);need(allowMissing&&b===null||matches(b,value(r)),'CIPHERTEXT_MISMATCH');
  return b;
 }
 sessionToken(){this.assertCurrent();return token(value(this.current));}
 assertSession(t){need(t===this.sessionToken(),'STALE_SESSION');}
 exists(){this.assertCurrent({allowMissing:true});return this.current.sha256!==null;}
 read(){const b=this.assertCurrent();need(b!==null,'VAULT_MISSING');return new TextDecoder('utf-8',{fatal:true}).decode(b);}
 info(){
  this.assertCurrent({allowMissing:true});
  return {scheme:PROTECTION_SCHEME,generation:this.current.generation,latestCiphertextSha256:this.current.sha256,
   pairId:this.protection.pairId,recoveryPerformed:this.recoveryPerformed,
   bodyMissing:readRegular(this.file,MAX,true)===null&&this.current.sha256!==null,
   jointRollbackDetected:false,independentAuthority:false};
 }
 write(data,{create=false}={}){
  this.assertCurrent();need(typeof data==='string'&&Buffer.byteLength(data)>0&&Buffer.byteLength(data)<=MAX,'CIPHER_SIZE');
  need(create?this.current.generation==='0':this.current.generation!=='0','CREATE_STATE');
  const v=value(this.current),next={generation:String(BigInt(v.generation)+1n),sha256:sha(data),bytes:Buffer.byteLength(data)};
  point(next);need(next.sha256!==v.sha256,'UNCHANGED_CIPHERTEXT');need(!fs.existsSync(this.stage),'STAGE_EXISTS');
  try{
   this.atomic(this.stage,data,{create:true});this.onBoundary('staged');
   this.persist({...this.stable(v),phase:'pending',next});this.onBoundary('intent');
   need(matches(readRegular(this.file,MAX,true),v)&&matches(readRegular(this.stage,MAX),next),'COMMIT_INPUT_CHANGED');
   this.assertOwned();fs.renameSync(this.stage,this.file);this.onBoundary('renamed');
   this.syncDir(this.directory);this.onBoundary('vault-durable');
   this.persist(this.stable(next));this.onBoundary('checkpoint-durable');
   this.current=this.record();this.assertCurrent();
  }catch(e){this.poisoned=true;throw e;}
 }
 assertExactBackup(data){
  this.assertOwned();need(typeof data==='string'&&matches(Buffer.from(data),value(this.current)),'BACKUP_NOT_CURRENT');
 }
 restoreExact(data){
  this.assertCurrent({allowMissing:true});need(this.current.sha256!==null&&!fs.existsSync(this.file),'RESTORE_REQUIRES_MISSING_BODY');
  this.assertExactBackup(data);
  try{this.atomic(this.file,data,{create:true});this.assertCurrent();}catch(e){this.poisoned=true;throw e;}
 }
 close(){if(this.fds===null)return;const fds=this.fds;this.fds=null;for(const f of fds){claimed.delete(f);fs.closeSync(f);}}
}
