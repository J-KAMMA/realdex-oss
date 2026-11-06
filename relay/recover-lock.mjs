#!/usr/bin/env node
/** Explicit offline dead-process lock recovery. Never changes the encrypted journal. */
import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {need,safeError} from '../wallet/lib/guard.mjs';
export function recoverRelayLock(directory,expectedPid){
  need(process.platform!=='win32','RELAY_LOCK_RECOVERY_UNTESTED_PLATFORM');
  need(Number.isSafeInteger(expectedPid)&&expectedPid>1,'RELAY_RECOVERY_PID');
  const dir=path.resolve(directory),d=fs.lstatSync(dir);need(d.isDirectory()&&!d.isSymbolicLink()&&d.uid===process.getuid()&&(d.mode&0o077)===0,'RELAY_RECOVERY_DIRECTORY');
  // Presence is required; never use this tool to remove a different application's lock.
  const file=path.join(dir,'relay-vault.json'),v=fs.lstatSync(file);need(v.isFile()&&!v.isSymbolicLink()&&v.nlink===1&&v.size<=1048576&&(v.mode&0o077)===0,'RELAY_RECOVERY_JOURNAL');
  need(JSON.parse(fs.readFileSync(file,'utf8')).schema==='realdex.relay-vault.v1','RELAY_RECOVERY_SCHEMA');
  const lock=path.join(dir,'writer.lock'),s=fs.lstatSync(lock);need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size<=16,'RELAY_RECOVERY_LOCK');
  need(fs.readFileSync(lock,'utf8')===String(expectedPid),'RELAY_RECOVERY_PID_MISMATCH');
  let dead=false;try{process.kill(expectedPid,0);}catch(e){if(e.code==='ESRCH')dead=true;}
  need(dead,'RELAY_RECOVERY_PROCESS_LIVE_OR_UNKNOWN');const current=fs.lstatSync(lock),currentDir=fs.lstatSync(dir);
  need(current.ino===s.ino&&current.dev===s.dev&&currentDir.ino===d.ino&&currentDir.dev===d.dev,'RELAY_RECOVERY_CHANGED');
  fs.unlinkSync(lock);const fd=fs.openSync(dir,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return {lockRemoved:true,journalChanged:false,automaticSigningResumed:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const a=process.argv.slice(2);need(a.length===4&&a[0]==='--directory'&&a[2]==='--dead-pid'&&/^[0-9]+$/.test(a[3]),'RELAY_RECOVERY_ARGUMENT');console.log(JSON.stringify(recoverRelayLock(a[1],Number(a[3]))));}catch(e){console.error(safeError(e));process.exitCode=1;}
}
