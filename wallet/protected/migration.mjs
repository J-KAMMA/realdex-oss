/** UP03 protected-pair migration. Two-stage, fail-closed, no network or signing/broadcast authority. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,randomBytes,sign as signMessage,verify as verifyMessage} from 'node:crypto';
import {canonical,clone,need,shape} from '../lib/guard.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
import {MIGRATION_SCHEMA,PROTECTION_SCHEME,validateStorageMigration,validateStorageProtection} from './binding.mjs';
const TARGET_SCHEMA='realdex.protected-migration-target.v1';
const PACKAGE_SCHEMA='realdex.protected-migration-package.v1';
const RECEIPT_SCHEMA='realdex.protected-migration-receipt.v1';
const MAX=1048576;
const sha=b=>createHash('sha256').update(b).digest('hex');
const hex64=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
function parseText(text,max=MAX){need(typeof text==='string'&&Buffer.byteLength(text)<=max,'CP_MIGRATION_JSON_SIZE');parseExactJson(text,{maxChars:max,maxDepth:20,maxNodes:10000});return JSON.parse(text);}
function exactText(value){return canonical(value)+'\n';}
function descriptorBody(value){return {schema:value.schema,pairId:value.pairId,nonce:value.nonce,publicKeySpkiBase64:value.publicKeySpkiBase64,keyFingerprint:value.keyFingerprint};}
export function validateMigrationTarget(value){
 shape(value,['schema','pairId','nonce','publicKeySpkiBase64','keyFingerprint','descriptorSha256']);
 need(value.schema===TARGET_SCHEMA&&hex64(value.pairId)&&hex64(value.nonce)&&hex64(value.keyFingerprint)&&hex64(value.descriptorSha256),'CP_MIGRATION_TARGET');
 let der;try{der=Buffer.from(value.publicKeySpkiBase64,'base64');need(der.length>=32&&der.length<=256&&der.toString('base64')===value.publicKeySpkiBase64,'CP_MIGRATION_TARGET');const key=createPublicKey({key:der,format:'der',type:'spki'});need(key.asymmetricKeyType==='ed25519','CP_MIGRATION_TARGET');}catch(e){if(e?.message?.startsWith('CP_'))throw e;throw Error('CP_MIGRATION_TARGET');}
 need(sha(der)===value.keyFingerprint&&sha(Buffer.from(canonical(descriptorBody(value))))===value.descriptorSha256,'CP_MIGRATION_TARGET');return clone(value);
}
function internal(store,name){return path.join(store.checkpointDirectory,name);}
function readPrivate(file,max=MAX,missing=false){
 let s;try{s=fs.lstatSync(file);}catch(e){if(missing&&e.code==='ENOENT')return null;throw e;}
 need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid()&&(s.mode&0o077)===0&&s.size>0&&s.size<=max,'CP_MIGRATION_FILE');
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
 try{const a=fs.fstatSync(fd);need(a.dev===s.dev&&a.ino===s.ino&&a.size===s.size,'CP_MIGRATION_FILE_CHANGED');const b=Buffer.alloc(a.size+1),n=fs.readSync(fd,b,0,b.length,0);need(n===a.size,'CP_MIGRATION_FILE_CHANGED');return b.subarray(0,n);}finally{fs.closeSync(fd);}
}
function readJsonFile(file,max=MAX,missing=false){const b=readPrivate(file,max,missing);return b===null?null:parseText(new TextDecoder('utf-8',{fatal:true}).decode(b),max);}
export function prepareMigrationTarget(store){
 need(store?.migrationMode===true&&store.protection,'CP_MIGRATION_MODE_REQUIRED');store.assertOwned();
 const descriptorPath=internal(store,'migration-target.json'),keyPath=internal(store,'migration-receipt-key.pk8');
 const existingDescriptor=readJsonFile(descriptorPath,8192,true),existingKey=readPrivate(keyPath,8192,true);
 if(existingDescriptor){need(existingKey!==null,'CP_MIGRATION_TARGET_KEY_MISSING');const descriptor=validateMigrationTarget(existingDescriptor);need(descriptor.pairId===store.protection.pairId,'CP_MIGRATION_TARGET');const privateKey=createPrivateKey({key:existingKey,format:'der',type:'pkcs8'}),pub=createPublicKey(privateKey).export({format:'der',type:'spki'});need(sha(pub)===descriptor.keyFingerprint,'CP_MIGRATION_TARGET_KEY');return descriptor;}
 const info=store.info();need(info.generation==='0'&&!store.exists(),'CP_MIGRATION_TARGET_NOT_EMPTY');
 let privateKey,publicKey;if(existingKey){privateKey=createPrivateKey({key:existingKey,format:'der',type:'pkcs8'});publicKey=createPublicKey(privateKey);}else{({privateKey,publicKey}=generateKeyPairSync('ed25519'));const der=privateKey.export({format:'der',type:'pkcs8'});store.atomic(keyPath,der,{create:true});}
 const spki=publicKey.export({format:'der',type:'spki'}),body={schema:TARGET_SCHEMA,pairId:store.protection.pairId,nonce:randomBytes(32).toString('hex'),publicKeySpkiBase64:spki.toString('base64'),keyFingerprint:sha(spki)};
 const descriptor={...body,descriptorSha256:sha(Buffer.from(canonical(body)))};store.atomic(descriptorPath,exactText(descriptor),{create:true});return descriptor;
}
export function parseMigrationPackage(text){
 const p=parseText(text);shape(p,['schema','migration','targetDescriptor','encrypted','encryptedSha256','vaultId','accountsVersion','revision']);
 need(p.schema===PACKAGE_SCHEMA&&typeof p.encrypted==='string'&&Buffer.byteLength(p.encrypted)>0&&Buffer.byteLength(p.encrypted)<=MAX&&hex64(p.encryptedSha256),'CP_MIGRATION_PACKAGE');
 need(sha(Buffer.from(p.encrypted))===p.encryptedSha256&&typeof p.vaultId==='string'&&/^[0-9a-f-]{36}$/.test(p.vaultId)&&Number.isSafeInteger(p.accountsVersion)&&p.accountsVersion>=0&&Number.isSafeInteger(p.revision)&&p.revision>=0,'CP_MIGRATION_PACKAGE');
 const target=validateMigrationTarget(p.targetDescriptor),migration=validateStorageMigration(p.migration);need(target.pairId===migration.targetPairId&&target.descriptorSha256===migration.targetDescriptorSha256,'CP_MIGRATION_PACKAGE');return {...clone(p),migration,targetDescriptor:target};
}
export async function exportProtectedMigration(store,vault,targetDescriptor){
 need(store?.migrationMode===true&&store.protection,'CP_MIGRATION_MODE_REQUIRED');const target=validateMigrationTarget(targetDescriptor),existing=store.migrationState();
 if(existing){const packageData=parseMigrationPackage(existing.packageText);need(packageData.targetDescriptor.descriptorSha256===target.descriptorSha256&&packageData.migration.sourcePairId===store.protection.pairId,'CP_MIGRATION_ALREADY_TARGETED');
  if(existing.phase==='incomplete'){const marker={schema:'realdex.protected-migration-out.v1',pairId:store.protection.pairId,phase:'pending',migrationId:packageData.migration.migrationId,targetPairId:target.pairId,targetDescriptorSha256:target.descriptorSha256,packageSha256:existing.packageSha256,sourceGeneration:packageData.migration.sourceGeneration,sourceSha256:packageData.migration.sourceCiphertextSha256};store.beginMigration(existing.packageText,marker);}
  return {packageText:existing.packageText,packageSha256:existing.packageSha256,existing:true,migration:packageData.migration};}
 const source=store.info();need(source.generation!=='0'&&hex64(source.latestCiphertextSha256),'CP_MIGRATION_SOURCE_EMPTY');
 const migration=validateStorageMigration({schema:MIGRATION_SCHEMA,migrationId:randomBytes(32).toString('hex'),sourcePairId:store.protection.pairId,sourceGeneration:source.generation,sourceCiphertextSha256:source.latestCiphertextSha256,targetPairId:target.pairId,targetDescriptorSha256:target.descriptorSha256});
 const exported=await vault.exportProtectedMigration(validateStorageProtection({scheme:PROTECTION_SCHEME,pairId:target.pairId}),migration);
 const packageData={schema:PACKAGE_SCHEMA,migration:clone(migration),targetDescriptor:clone(target),encrypted:exported.encrypted,encryptedSha256:exported.sha256,vaultId:exported.vaultId,accountsVersion:exported.accountsVersion,revision:exported.revision};
 const packageText=exactText(packageData),packageSha256=sha(Buffer.from(packageText));
 const marker={schema:'realdex.protected-migration-out.v1',pairId:store.protection.pairId,phase:'pending',migrationId:migration.migrationId,targetPairId:target.pairId,targetDescriptorSha256:target.descriptorSha256,packageSha256,sourceGeneration:source.generation,sourceSha256:source.latestCiphertextSha256};
 store.beginMigration(packageText,marker);vault.lock();return {packageText,packageSha256,existing:false,migration:clone(migration)};
}
function receiptBody(r){return {schema:r.schema,migrationId:r.migrationId,packageSha256:r.packageSha256,sourcePairId:r.sourcePairId,targetPairId:r.targetPairId,targetDescriptorSha256:r.targetDescriptorSha256,destinationGeneration:r.destinationGeneration,destinationCiphertextSha256:r.destinationCiphertextSha256,vaultId:r.vaultId};}
export function validateMigrationReceipt(receipt,targetDescriptor){
 shape(receipt,['schema','migrationId','packageSha256','sourcePairId','targetPairId','targetDescriptorSha256','destinationGeneration','destinationCiphertextSha256','vaultId','signatureBase64']);
 const target=validateMigrationTarget(targetDescriptor);need(receipt.schema===RECEIPT_SCHEMA&&hex64(receipt.migrationId)&&hex64(receipt.packageSha256)&&hex64(receipt.sourcePairId)&&hex64(receipt.targetPairId)&&hex64(receipt.targetDescriptorSha256)&&hex64(receipt.destinationCiphertextSha256),'CP_MIGRATION_RECEIPT');
 need(receipt.targetPairId===target.pairId&&receipt.targetDescriptorSha256===target.descriptorSha256&&receipt.destinationGeneration==='1'&&/^[0-9a-f-]{36}$/.test(receipt.vaultId),'CP_MIGRATION_RECEIPT');
 let sig;try{sig=Buffer.from(receipt.signatureBase64,'base64');need(sig.length===64&&sig.toString('base64')===receipt.signatureBase64,'CP_MIGRATION_RECEIPT');}catch(e){if(e?.message?.startsWith('CP_'))throw e;throw Error('CP_MIGRATION_RECEIPT');}
 const pub=createPublicKey({key:Buffer.from(target.publicKeySpkiBase64,'base64'),format:'der',type:'spki'});need(verifyMessage(null,Buffer.from(canonical(receiptBody(receipt))),pub,sig),'CP_MIGRATION_RECEIPT_SIGNATURE');return clone(receipt);
}
export async function importProtectedMigration(store,vault,packageText,password){
 need(store?.migrationMode===true&&store.protection,'CP_MIGRATION_MODE_REQUIRED');const packageData=parseMigrationPackage(packageText),target=prepareMigrationTarget(store);
 need(canonical(target)===canonical(packageData.targetDescriptor),'CP_MIGRATION_WRONG_TARGET');const packageSha256=sha(Buffer.from(packageText)),receiptPath=internal(store,'migration-receipt.json');
 const existingReceipt=readJsonFile(receiptPath,16384,true);if(existingReceipt){const receipt=validateMigrationReceipt(existingReceipt,target);need(receipt.packageSha256===packageSha256&&receipt.destinationCiphertextSha256===packageData.encryptedSha256&&store.info().latestCiphertextSha256===packageData.encryptedSha256,'CP_MIGRATION_RECEIPT_MISMATCH');return {receipt,alreadyImported:true};}
 const {vaultId,accountsVersion,revision}=packageData;
 const imported=await vault.importProtectedMigration(packageData.encrypted,password,packageData.migration,{vaultId,accountsVersion,revision}),info=store.info();need(info.generation==='1'&&info.latestCiphertextSha256===packageData.encryptedSha256,'CP_MIGRATION_IMPORT_IDENTITY');
 const keyBytes=readPrivate(internal(store,'migration-receipt-key.pk8'),8192),privateKey=createPrivateKey({key:keyBytes,format:'der',type:'pkcs8'});
 const body={schema:RECEIPT_SCHEMA,migrationId:packageData.migration.migrationId,packageSha256,sourcePairId:packageData.migration.sourcePairId,targetPairId:target.pairId,targetDescriptorSha256:target.descriptorSha256,destinationGeneration:info.generation,destinationCiphertextSha256:info.latestCiphertextSha256,vaultId:imported.vaultId};
 const receipt={...body,signatureBase64:signMessage(null,Buffer.from(canonical(body)),privateKey).toString('base64')};validateMigrationReceipt(receipt,target);store.atomic(receiptPath,exactText(receipt),{create:true});return {receipt,alreadyImported:imported.alreadyImported};
}
export function finalizeProtectedMigration(store,receiptText){
 need(store?.migrationMode===true&&store.protection,'CP_MIGRATION_MODE_REQUIRED');const state=store.migrationState();need(state?.phase==='pending'&&state.marker,'CP_MIGRATION_NOT_PENDING');
 const packageData=parseMigrationPackage(state.packageText),receipt=validateMigrationReceipt(parseText(receiptText,16384),packageData.targetDescriptor);
 need(receipt.migrationId===packageData.migration.migrationId&&receipt.packageSha256===state.packageSha256&&receipt.sourcePairId===store.protection.pairId&&receipt.targetPairId===state.marker.targetPairId&&receipt.destinationCiphertextSha256===packageData.encryptedSha256&&receipt.vaultId===packageData.vaultId,'CP_MIGRATION_RECEIPT_MISMATCH');
 const receiptSha256=sha(Buffer.from(exactText(receipt)));store.finalizeMigration(receiptSha256);return {finalized:true,sourceRetired:true,migrationId:receipt.migrationId,targetPairId:receipt.targetPairId,receiptSha256};
}
export function migrationTargetText(descriptor){return exactText(validateMigrationTarget(descriptor));}
export function migrationReceiptText(receipt,target){return exactText(validateMigrationReceipt(receipt,target));}
