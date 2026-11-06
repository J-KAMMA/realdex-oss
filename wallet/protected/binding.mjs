/** UP01+ protected binding. This is not the unavailable INJ13 format. */
import {canonical,shape,need} from '../lib/guard.mjs';
export const PROTECTION_SCHEME='realdex.vault-checkpoint-lease.v1';
export const MIGRATION_SCHEMA='realdex.protected-storage-migration.v1';
export function validateStorageProtection(value){
 shape(value,['scheme','pairId']);
 need(value.scheme===PROTECTION_SCHEME&&typeof value.pairId==='string'&&/^[a-f0-9]{64}$/.test(value.pairId),'VAULT_STORAGE_PROTECTION_INVALID');
 return value;
}
export function requireStorageProtection(payload,store){
 if(payload.storageProtection!==undefined)validateStorageProtection(payload.storageProtection);
 if(payload.storageProtection===undefined&&store.protection===undefined)return;
 need(payload.storageProtection!==undefined&&store.protection!==undefined,'VAULT_STORAGE_PROTECTION_REQUIRED');
 need(canonical(payload.storageProtection)===canonical(validateStorageProtection(store.protection)),'VAULT_STORAGE_PROTECTION_MISMATCH');
}
export function validateStorageMigration(value){
 shape(value,['schema','migrationId','sourcePairId','sourceGeneration','sourceCiphertextSha256','targetPairId','targetDescriptorSha256']);
 need(value.schema===MIGRATION_SCHEMA,'VAULT_STORAGE_MIGRATION_INVALID');
 for(const k of ['migrationId','sourcePairId','sourceCiphertextSha256','targetPairId','targetDescriptorSha256'])
  need(typeof value[k]==='string'&&/^[a-f0-9]{64}$/.test(value[k]),'VAULT_STORAGE_MIGRATION_INVALID');
 need(typeof value.sourceGeneration==='string'&&/^[1-9][0-9]{0,18}$/.test(value.sourceGeneration),'VAULT_STORAGE_MIGRATION_INVALID');
 need(value.sourcePairId!==value.targetPairId,'VAULT_STORAGE_MIGRATION_INVALID');
 return value;
}
