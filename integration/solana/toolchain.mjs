/** Availability check is not execution. Python checks every pinned package file before importing. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const pin=JSON.parse(fs.readFileSync(new URL('./toolchain-pin.json',import.meta.url),'utf8'));
export function solanaToolStatus(file=process.env.REALDEX_SOLANA_TEST_ARCHIVE){
  if(!file)return {available:false,reason:'SOLANA_TEST_ARCHIVE_NOT_CONFIGURED',version:pin.version};
  try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>33554432)return {available:false,reason:'SOLANA_TEST_ARCHIVE_INVALID'};
    const digest=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return digest===pin.archiveSha256?{available:true,version:pin.version,archiveSha256:digest,scope:'LiteSVM runtime; synthetic RPC metadata; no cluster consensus'}:{available:false,reason:'SOLANA_TEST_ARCHIVE_HASH_MISMATCH'};
  }catch{return {available:false,reason:'SOLANA_TEST_ARCHIVE_UNAVAILABLE'};}
}
