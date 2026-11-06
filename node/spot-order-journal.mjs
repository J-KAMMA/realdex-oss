#!/usr/bin/env node
/** Explicit offline observation storage CLI. Never signs, broadcasts, or fetches venue state. */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInjectiveObservationJournal,appendInjectiveObservation,inspectInjectiveObservationJournal} from './external/injective-journal.mjs';
const usage='Usage: node node/spot-order-journal.mjs init --directory ABS --plan FILE --observation FILE | append --directory ABS --observation FILE --expect-head SHA256 | inspect --directory ABS [--expect-head SHA256]';
function readJson(file,limit){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{
  const s=fs.fstatSync(fd);if(!s.isFile()||s.size<1||s.size>limit)throw Error('INJ_JOURNAL_INPUT_FILE');
  const b=Buffer.alloc(s.size);let pos=0;while(pos<b.length){const n=fs.readSync(fd,b,pos,b.length-pos,null);if(!n)throw Error('INJ_JOURNAL_INPUT_CHANGED');pos+=n;}
  const after=fs.fstatSync(fd);if(after.size!==s.size||after.mtimeMs!==s.mtimeMs||after.ctimeMs!==s.ctimeMs)throw Error('INJ_JOURNAL_INPUT_CHANGED');
  const text=b.toString('utf8');if(!Buffer.from(text).equals(b))throw Error('INJ_JOURNAL_INPUT_UTF8');
  // Reject duplicate keys/ambiguous JSON via a strict small JSON parser boundary below.
  return parseInput(text);
 }finally{fs.closeSync(fd);}
}
// JSON.parse accepts duplicate keys. Check them before handing parsed data to the reconciler.
function parseInput(text){
 let i=0;const space=()=>{while(/[\x20\t\r\n]/.test(text[i]??'\0'))i++;};
 function value(depth=0){
  if(depth>8)throw Error('INJ_JOURNAL_INPUT_DEPTH');space();const c=text[i];
  if(c==='"'){const start=i++;while(i<text.length){if(text[i]==='\\'){i+=2;continue;}if(text[i++]==='"')return JSON.parse(text.slice(start,i));}throw Error('INJ_JOURNAL_INPUT_JSON');}
  if(c==='{'||c==='['){
   const obj=c==='{',close=obj?'}':']',keys=new Set();i++;space();if(text[i]===close){i++;return;}
   while(i<text.length){
    if(obj){space();if(text[i]!=='"')throw Error('INJ_JOURNAL_INPUT_JSON');const key=value(depth+1);if(keys.has(key))throw Error('INJ_JOURNAL_INPUT_DUPLICATE_KEY');keys.add(key);space();if(text[i++]!==':')throw Error('INJ_JOURNAL_INPUT_JSON');}
    value(depth+1);space();if(text[i]===close){i++;return;}if(text[i++]!==',')throw Error('INJ_JOURNAL_INPUT_JSON');
   }throw Error('INJ_JOURNAL_INPUT_JSON');
  }
  const m=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!m)throw Error('INJ_JOURNAL_INPUT_JSON');i+=m[0].length;
 }
 value();space();if(i!==text.length)throw Error('INJ_JOURNAL_INPUT_JSON');return JSON.parse(text);
}
export function journalCommand(args){
 const [command,...rest]=args,allowed={init:['directory','plan','observation'],append:['directory','observation','expect-head'],inspect:['directory','expect-head']}[command];
 if(!allowed||rest.length%2)throw Error(usage);const opts={};
 for(let i=0;i<rest.length;i+=2){const k=rest[i].slice(2);if(!rest[i].startsWith('--')||!allowed.includes(k)||Object.hasOwn(opts,k)||!rest[i+1]||rest[i+1].startsWith('--'))throw Error(usage);opts[k]=rest[i+1];}
 const required=command==='inspect'?['directory']:allowed;if(required.some(k=>!Object.hasOwn(opts,k)))throw Error(usage);
 if(command==='init')return createInjectiveObservationJournal(opts.directory,readJson(opts.plan,65536),readJson(opts.observation,4096));
 if(command==='append')return appendInjectiveObservation(opts.directory,readJson(opts.observation,4096),{expectedHead:opts['expect-head']});
 return inspectInjectiveObservationJournal(opts.directory,{expectedHead:opts['expect-head']});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(journalCommand(process.argv.slice(2)),null,2));}
 catch(e){console.error(e.message===usage?usage:/^INJ_[A-Z_]+$/.test(e.message)?e.message:'INJ_JOURNAL_IO_OR_INVALID_INPUT');process.exitCode=1;}
}
