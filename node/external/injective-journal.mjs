/** Local Linux observation storage; NOT wallet storage, a signer, or authenticated settlement. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {reconcileInjectiveOrderObservation as reconcile} from './injective-orders.mjs';

export const JOURNAL_LIMITS=Object.freeze({entries:1024,bytes:2097152});
const SCHEMA='realdex.injective-observation-journal.v1';
const DATA='journal.json',LOCK='.write-lock',TEMP='.journal.pending';
const KEYS=['planSha256','clientOrderId','orderHash','revision','filledBaseAtomic','status'];
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const need=(ok,code)=>{if(!ok)throw Error('INJ_JOURNAL_'+code);};
const validHead=x=>need(typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),'HEAD_REQUIRED');
const observation=s=>Object.fromEntries(KEYS.map(k=>[k,s[k]]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function fields(value,keys){need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k)),'FIELDS');}
function envelope(plan,entries,state){
  const body={schema:SCHEMA,plan,entries,state};return {...body,journalSha256:sha(body)};
}
const genesis=plan=>sha({domain:SCHEMA+'/genesis',planSha256:plan.planSha256});
function entry(previousSha256,obs){
  const body={previousSha256,observation:obs};return {...body,entrySha256:sha({domain:SCHEMA+'/entry',...body})};
}
function encode(journal){
  const b=Buffer.from(JSON.stringify(journal)+'\n');need(b.length<=JOURNAL_LIMITS.bytes,'SIZE_LIMIT');return b;
}
/** Rebuild every transition. The unkeyed hashes verify consistency, NOT authenticity. */
function decode(bytes){
  need(bytes.length>0&&bytes.length<=JOURNAL_LIMITS.bytes,'SIZE_LIMIT');
  let j;try{j=JSON.parse(bytes.toString('utf8'));}catch{throw Error('INJ_JOURNAL_JSON');}
  fields(j,['schema','plan','entries','state','journalSha256']);
  need(j.schema===SCHEMA,'SCHEMA');
  need(Array.isArray(j.entries)&&j.entries.length>0&&j.entries.length<=JOURNAL_LIMITS.entries,'ENTRY_LIMIT');
  let previous=null,link=genesis(j.plan);const rebuilt=[];
  for(const e of j.entries){
    fields(e,['previousSha256','observation','entrySha256']);
    const r=reconcile(j.plan,e.observation,previous);need(!r.duplicate,'DUPLICATE_RECORD');
    const expected=entry(link,observation(r.state));need(same(e,expected),'CHAIN_MISMATCH');
    rebuilt.push(expected);link=expected.entrySha256;previous=r.state;
  }
  const expected=envelope(j.plan,rebuilt,previous);
  // Also rejects duplicate JSON keys, invalid UTF-8, trailing data and altered derived fields.
  need(bytes.equals(encode(expected)),'INTEGRITY');return expected;
}
function storagePath(directory){
  need(process.platform==='linux'&&typeof process.getuid==='function','LINUX_REQUIRED');
  need(typeof directory==='string'&&path.isAbsolute(directory)&&directory===path.resolve(directory)&&!/[\x00-\x1f]/.test(directory),'ABSOLUTE_PATH_REQUIRED');
  return directory;
}
function privateDir(dir){
  const s=fs.lstatSync(dir);
  need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'PRIVATE_DIRECTORY_REQUIRED');
  need(fs.realpathSync(dir)===dir,'SYMLINK_PATH');return s;
}
function syncDir(dir){const fd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function exists(p){try{fs.lstatSync(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
function layout(dir,{locked=false,creating=false}={}){
  privateDir(dir);const names=fs.readdirSync(dir);
  if(!locked)need(!names.includes(LOCK),'LOCKED');
  need(!names.includes(TEMP),'INTERRUPTED_WRITE');
  const allowed=creating?[LOCK]:locked?[DATA,LOCK]:[DATA];
  need(names.length===allowed.length&&allowed.every(n=>names.includes(n)),'LAYOUT');
}
function readData(dir){
  const fd=fs.openSync(path.join(dir,DATA),fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const a=fs.fstatSync(fd);
    need(a.isFile()&&a.nlink===1&&a.uid===process.getuid()&&(a.mode&0o077)===0,'PRIVATE_FILE_REQUIRED');
    need(a.size>0&&a.size<=JOURNAL_LIMITS.bytes,'SIZE_LIMIT');
    const bytes=Buffer.alloc(a.size);let offset=0;
    while(offset<bytes.length){const n=fs.readSync(fd,bytes,offset,bytes.length-offset,null);need(n>0,'TRUNCATED');offset+=n;}
    const b=fs.fstatSync(fd);
    need(b.size===a.size&&b.mtimeMs===a.mtimeMs&&b.ctimeMs===a.ctimeMs,'FILE_CHANGED');
    return decode(bytes);
  }finally{fs.closeSync(fd);}
}
function receipt(j,duplicate=false){return {schema:'realdex.injective-journal-receipt.v1',journalSha256:j.journalSha256,
  planSha256:j.plan.planSha256,entryCount:j.entries.length,state:structuredClone(j.state),duplicate,
  localConsistencyVerified:true,historyAuthenticated:false,settlementVerified:false,signingEnabled:false,broadcastEnabled:false,executable:false};}
function lock(dir){
  let fd;try{fd=fs.openSync(path.join(dir,LOCK),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);}
  catch(e){if(e.code==='EEXIST')throw Error('INJ_JOURNAL_LOCKED');throw e;}
  try{fs.writeFileSync(fd,JSON.stringify({schema:SCHEMA+'/lock',nonce:randomUUID(),pid:process.pid})+'\n');fs.fsyncSync(fd);}
  finally{fs.closeSync(fd);}
  syncDir(dir);
}
function install(dir,j){
  const fd=fs.openSync(path.join(dir,TEMP),fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(fd,encode(j));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(path.join(dir,TEMP),path.join(dir,DATA));syncDir(dir);
}
function uncertain(){return Error('INJ_JOURNAL_WRITE_UNCERTAIN');}
/** Create a new dedicated directory; NEVER replace or recover an existing one. */
export function createInjectiveObservationJournal(directory,plan,first){
  const dir=storagePath(directory);privateDir(path.dirname(dir));
  // Validate before any file creation; the existing reconciler never invokes accessors/toJSON.
  const r=reconcile(plan,first),copy=JSON.parse(JSON.stringify(plan));
  const j=envelope(copy,[entry(genesis(copy),observation(r.state))],r.state);encode(j);
  need(!exists(dir),'EXISTS');fs.mkdirSync(dir,{mode:0o700});
  try{
    syncDir(path.dirname(dir));lock(dir);layout(dir,{locked:true,creating:true});install(dir,j);
    fs.unlinkSync(path.join(dir,LOCK));
  }catch{throw uncertain();} // preserve files/lock, never delete uncertain evidence
  return receipt(j);
}
/** Read-only snapshot. A concurrent writer yields LOCKED or CHANGED, never a mixed history. */
export function inspectInjectiveObservationJournal(directory,{expectedHead}={}){
  const dir=storagePath(directory);if(expectedHead!==undefined)validHead(expectedHead);
  layout(dir);const a=readData(dir);layout(dir);const b=readData(dir);layout(dir);
  need(a.journalSha256===b.journalSha256,'CHANGED');
  if(expectedHead!==undefined)need(b.journalSha256===expectedHead,'HEAD_MISMATCH');return receipt(b);
}
/** Compare-and-swap on the caller's observed head, serialized for cooperating local writers. */
export function appendInjectiveObservation(directory,obs,{expectedHead}={}){
  validHead(expectedHead);const dir=storagePath(directory);layout(dir);
  try{lock(dir);}catch(e){if(e.message==='INJ_JOURNAL_LOCKED')throw e;throw uncertain();}
  let next,duplicate;
  try{
    layout(dir,{locked:true});const current=readData(dir);
    need(current.journalSha256===expectedHead,'HEAD_MISMATCH');
    const r=reconcile(current.plan,obs,current.state);duplicate=r.duplicate;
    if(duplicate)next=current;
    else{
      need(current.entries.length<JOURNAL_LIMITS.entries,'ENTRY_LIMIT');
      next=envelope(current.plan,[...current.entries,entry(current.entries.at(-1).entrySha256,observation(r.state))],r.state);encode(next);
    }
  }catch(e){
    // Validation occurred before data mutation, so only our lock is removed.
    try{fs.unlinkSync(path.join(dir,LOCK));}catch{throw uncertain();}throw e;
  }
  try{if(!duplicate)install(dir,next);fs.unlinkSync(path.join(dir,LOCK));}catch{throw uncertain();}
  return receipt(next,duplicate);
}
