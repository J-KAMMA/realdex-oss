#!/usr/bin/env node
/** Read-only local signature/content verification. No wallet access, RPC, or broadcasting. */
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {need,safeError} from '../lib/guard.mjs';
import {validateNonEvmRecord} from './records.mjs';
export function verifyExportedRecord(record){
  need(record&&typeof record==='object','SIGNED_RECORD_REQUIRED');
  // The supplied public account is reconstructed only for cryptographic consistency.
  // This does NOT prove the file came from any particular operator's wallet.
  const publicAccount={id:record.accountId,family:record.family,kind:'local',address:record.summary?.from};
  validateNonEvmRecord(record,[publicAccount]);
  return {schema:'realdex.signed-export-check.v1',family:record.family,operation:record.summary.operation,
    signatureAndContentsVerified:true,sourceWalletAuthenticated:false,networkStateVerified:false,
    onChainExecutionVerified:false,submissionPerformed:false,productionReady:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    need(process.argv.length===4&&process.argv[2]==='--input','USAGE_VERIFY_EXPORT_INPUT');
    const path=process.argv[3],stat=fs.lstatSync(path);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1048576,'SIGNED_EXPORT_FILE_INVALID');
    const bytes=fs.readFileSync(path);const result=verifyExportedRecord(JSON.parse(bytes.toString('utf8')));
    console.log(JSON.stringify({...result,fileSha256:createHash('sha256').update(bytes).digest('hex')},null,2));
  }catch(error){console.error(safeError(error));process.exitCode=1;}
}
