/** Test tool identity only. Never changes the production 0.8.24 compiler pin. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import stable from '../compiler-pin.cjs';
import pin from './experimental-pin.json' with {type:'json'};
export function compilerProfileStatus(profile,compiler) {
  if(!['pinned','experimental'].includes(profile))throw Error('AMM_COMPILER_PROFILE_INVALID');
  if(profile==='pinned')return {...stable.compilerStatus(compiler),profile,experimentalOnly:false};
  const base={profile,available:false,experimentalOnly:true,version:pin.version,sha256:pin.sha256,satisfiesPinnedProductionCompilerGate:false};
  try{
    if(typeof compiler!=='string'||!compiler)throw Error('EXPERIMENTAL_COMPILER_NOT_CONFIGURED');
    const s=fs.lstatSync(compiler);
    if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==pin.bytes||(s.mode&0o022))throw Error('EXPERIMENTAL_COMPILER_UNSAFE');
    const fd=fs.openSync(compiler,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let bytes;
    try{const opened=fs.fstatSync(fd);if(opened.ino!==s.ino||opened.dev!==s.dev)throw Error('EXPERIMENTAL_COMPILER_CHANGED');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
    if(createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw Error('EXPERIMENTAL_COMPILER_HASH_MISMATCH');
    return {...base,available:true};
  }catch(e){return {...base,reason:/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'EXPERIMENTAL_COMPILER_UNREADABLE'};}
}
