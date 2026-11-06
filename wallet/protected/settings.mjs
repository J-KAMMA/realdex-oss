/** UP02 settings live INSIDE the checkpoint-bound ciphertext, never in a plaintext sidecar. */
import {createHash} from 'node:crypto';
import {validateSettings} from '../lib/network.mjs';
import {need,shape,canonical,clone,freeze} from '../lib/guard.mjs';
export const SETTINGS_SCHEMA='realdex.protected-owner-settings.v1';
export const EMPTY_SETTINGS=freeze({schema:'realdex.wallet-settings.v1',allowedAppOrigins:[],networks:[]});
export const settingsDigest=x=>createHash('sha256').update(canonical(x)).digest('hex');
export function normalizedSettings(input){
 // These settings have the SAME network/origin restrictions as the standard owner server.
 const value=validateSettings(input);
 need(Buffer.byteLength(canonical(value))<=131072,'CP_SETTINGS_SIZE');
 return freeze(clone(value));
}
export function settingsRecord(value,{stored=true}={}){
 shape(value,['schema','revision','settings']);
 need(value.schema===SETTINGS_SCHEMA&&Number.isSafeInteger(value.revision)&&value.revision>=(stored?1:0),'CP_SETTINGS_RECORD');
 const normalized=normalizedSettings(value.settings);
 need(canonical(value.settings)===canonical(normalized),'CP_SETTINGS_NOT_CANONICAL');
 return freeze({schema:SETTINGS_SCHEMA,revision:value.revision,settings:normalized});
}
export function emptySettingsRecord(){return settingsRecord({schema:SETTINGS_SCHEMA,revision:0,settings:EMPTY_SETTINGS},{stored:false});}
export function settingsTransition(before,after,ownerOrigin){
 const next=normalizedSettings(after);
 need(!next.allowedAppOrigins.includes(ownerOrigin),'SIGNER_ORIGIN_CANNOT_BE_DAPP');
 // Full-document review must not become a way around the original identity replacement rules.
 // Removing an identity and later re-adding it is deliberately unsupported in this release.
 for(const old of before.networks){
  const n=next.networks.find(x=>x.chainId===old.chainId);
  need(n,'CP_SETTINGS_NETWORK_REMOVAL_UNSUPPORTED');
  need(n.genesisHash===old.genesisHash,'NETWORK_GENESIS_REPLACEMENT_FORBIDDEN');
 }
 // Existing non-EVM/IBC endpoints and trust pins were add-only in the old API. Keep that boundary.
 for(const name of ['solanaNetworks','bitcoinNetworks','accountNetworks','cosmosNetworks','ibcRoutes']){
  const a=before[name]??[],b=next[name]??[];
  need(b.length>=a.length&&a.every((x,i)=>canonical(x)===canonical(b[i])),'CP_SETTINGS_EXISTING_IDENTITY_CHANGED');
 }
 return next;
}
