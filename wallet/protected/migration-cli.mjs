#!/usr/bin/env node
/** Fixed UP03 migration utility. No network, transaction signing or broadcasting. */
import fs from 'node:fs';import path from 'node:path';
import {CheckpointLeaseStore} from './store.mjs';import {Vault} from '../lib/vault.mjs';
import {prepareMigrationTarget,exportProtectedMigration,importProtectedMigration,finalizeProtectedMigration,migrationTargetText,migrationReceiptText,validateMigrationTarget,parseMigrationPackage} from './migration.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
const need=(x,c)=>{if(!x)throw Error(c);};
function safeParent(file){
 const p=path.resolve(file),d=path.dirname(p);need(fs.realpathSync(d)===d,'CP_MIGRATION_OUTPUT_DIRECTORY');const s=fs.lstatSync(d);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===process.getuid()&&(s.mode&0o077)===0,'CP_MIGRATION_OUTPUT_DIRECTORY');return p;
}
function readFile(file,max=1048576){
 const p=path.resolve(file),s=fs.lstatSync(p);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max,'CP_MIGRATION_INPUT_FILE');
 const fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const a=fs.fstatSync(fd);need(a.dev===s.dev&&a.ino===s.ino&&a.size===s.size,'CP_MIGRATION_INPUT_CHANGED');const b=Buffer.alloc(a.size+1),n=fs.readSync(fd,b,0,b.length,0);need(n===a.size,'CP_MIGRATION_INPUT_CHANGED');return b.subarray(0,n).toString('utf8');}finally{fs.closeSync(fd);}
}
function writeNew(file,text){const p=safeParent(file),fd=fs.openSync(p,'wx',0o600);try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(p),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
function password(){const fd=Number(process.env.REALDEX_MIGRATION_PASSWORD_FD);need(Number.isInteger(fd)&&fd>=3,'CP_MIGRATION_PASSWORD_FD');let raw;try{raw=fs.readFileSync(fd,'utf8');}finally{try{fs.closeSync(fd);}catch{}}delete process.env.REALDEX_MIGRATION_PASSWORD_FD;let value;try{value=JSON.parse(raw);}catch{throw Error('CP_MIGRATION_PASSWORD_FD');}need(typeof value==='string','CP_MIGRATION_PASSWORD_FD');return value;}
async function main(){
 const [action,home,witness,...rest]=process.argv.slice(2);need(['target','export','import','finalize'].includes(action)&&home&&witness,'CP_MIGRATION_ARGUMENTS');
 const store=new CheckpointLeaseStore(home,witness,{migration:true});try{
  if(action==='target'){
   need(rest.length===1,'CP_MIGRATION_ARGUMENTS');const descriptor=prepareMigrationTarget(store);writeNew(rest[0],migrationTargetText(descriptor));console.log(JSON.stringify({prepared:true,pairId:descriptor.pairId,descriptorSha256:descriptor.descriptorSha256}));return;
  }
  if(action==='export'){
   need(rest.length===2,'CP_MIGRATION_ARGUMENTS');const descriptor=validateMigrationTarget(JSON.parse(readFile(rest[0],8192)));const existing=store.migrationState();let result;
   if(existing)result=await exportProtectedMigration(store,null,descriptor);
   else {const vault=new Vault(store);await vault.unlock(password());result=await exportProtectedMigration(store,vault,descriptor);}
   writeNew(rest[1],result.packageText);console.log(JSON.stringify({exported:true,existing:result.existing,packageSha256:result.packageSha256,migrationId:result.migration.migrationId,sourceFrozen:true}));return;
  }
  if(action==='import'){
   need(rest.length===2,'CP_MIGRATION_ARGUMENTS');const text=readFile(rest[0]),parsed=parseMigrationPackage(text),vault=new Vault(store),result=await importProtectedMigration(store,vault,text,password());
   writeNew(rest[1],migrationReceiptText(result.receipt,parsed.targetDescriptor));console.log(JSON.stringify({imported:true,alreadyImported:result.alreadyImported,migrationId:result.receipt.migrationId,targetPairId:result.receipt.targetPairId}));return;
  }
  need(rest.length===1,'CP_MIGRATION_ARGUMENTS');const result=finalizeProtectedMigration(store,readFile(rest[0],16384));console.log(JSON.stringify(result));
 }finally{store.close();}
}
main().catch(e=>{console.error(e instanceof Error&&/^[A-Z][A-Z0-9_]{1,90}$/.test(e.message)?e.message:'CP_MIGRATION_FAILED');process.exitCode=1;});
