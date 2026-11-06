// Official Solidity binary manifest, retrieved 2026-09-05. No binary is bundled or downloaded here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PIN = Object.freeze({
  version: '0.8.24', longVersion: '0.8.24+commit.e11b9ed9', platform: 'linux', arch: 'x64',
  sha256: 'fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f',
  bytes: 15020760,
  url: 'https://binaries.soliditylang.org/linux-amd64/solc-linux-amd64-v0.8.24+commit.e11b9ed9',
  manifest: 'https://binaries.soliditylang.org/linux-amd64/list.json',
});
function fail(code) {throw Error(code);}
function verifiedCompiler(file) {
  if (!file) fail('LOCAL_COMPILER_NOT_CONFIGURED');
  if (process.platform !== PIN.platform || process.arch !== PIN.arch) fail('LOCAL_COMPILER_PLATFORM_UNSUPPORTED');
  const compilerPath=path.resolve(file);
  let fd;
  try {
    const stat=fs.lstatSync(compilerPath);
    if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1 || stat.size!==PIN.bytes || (stat.mode&0o022)!==0) fail('LOCAL_COMPILER_FILE_UNSAFE');
    fd=fs.openSync(compilerPath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    const held=fs.fstatSync(fd);
    if(held.ino!==stat.ino || held.dev!==stat.dev) fail('LOCAL_COMPILER_CHANGED');
    if(crypto.createHash('sha256').update(fs.readFileSync(fd)).digest('hex')!==PIN.sha256) fail('LOCAL_COMPILER_HASH_MISMATCH');
    fs.accessSync(compilerPath,fs.constants.X_OK);
  }catch(e){
    if(/^[A-Z][A-Z0-9_]+$/.test(e.message))throw e;
    fail('LOCAL_COMPILER_UNAVAILABLE');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
  return {compilerPath,isSolcJs:false,version:PIN.version,longVersion:PIN.longVersion};
}
function compilerStatus(file) {
  try {const result=verifiedCompiler(file);return {available:true,version:result.longVersion,sha256:PIN.sha256,compilerExecuted:false};}
  catch(e){return {available:false,reason:e.message,compilerExecuted:false};}
}
module.exports={PIN,verifiedCompiler,compilerStatus};
