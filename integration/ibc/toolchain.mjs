import fs from 'node:fs';import {createHash} from 'node:crypto';
import pin from './pin.json' with {type:'json'};
export function ibcToolStatus(binary=process.env.REALDEX_IBC_SIMD_BINARY,loader=process.env.REALDEX_IBC_MUSL_LOADER){
 const result={available:false,diagnosticOnly:true,productionApproved:false,pin};
 try{
  if(process.platform!=='linux'||process.arch!=='x64')throw Error('IBC_TOOL_PLATFORM');
  for(const [name,file,size,hash] of [['BINARY',binary,pin.binaryBytes,pin.binarySha256],['LOADER',loader,pin.loaderBytes,pin.loaderSha256]]){
   if(typeof file!=='string'||!file)throw Error('IBC_'+name+'_NOT_CONFIGURED');const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size!==size||(s.mode&0o022))throw Error('IBC_'+name+'_UNSAFE');
   const fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));let bytes;try{const x=fs.fstatSync(fd);if(x.ino!==s.ino||x.dev!==s.dev)throw Error('IBC_TOOL_CHANGED');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
   if(createHash('sha256').update(bytes).digest('hex')!==hash)throw Error('IBC_'+name+'_HASH');
  }return {...result,available:true};
 }catch(e){return {...result,reason:/^[A-Z0-9_]+$/.test(e.message)?e.message:'IBC_TOOL_UNREADABLE'};}
}
