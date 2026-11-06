/** Protected owner mode. Settings changes are separate owner-reviewed ciphertext commits. */
import {randomUUID} from 'node:crypto';
import {WalletServer} from '../lib/server.mjs';
import {need,shape,canonical,clone,freeze} from '../lib/guard.mjs';
import {EMPTY_SETTINGS,settingsDigest,settingsTransition} from './settings.mjs';
const PREFIX='/api/protected/settings';
export const LEGACY_SETTINGS_WRITES=Object.freeze([
 '/api/networks/add','/api/origins/set','/api/networks/replace',
 '/api/non-evm/networks/add','/api/non-evm/bitcoin-online/networks/add',
 '/api/non-evm/account-online/networks/add','/api/non-evm/cosmos-online/networks/add','/api/ibc/routes/add'
]);
export class ProtectedOwnerServer extends WalletServer{
 constructor(options={}){
  need(options.store?.protection,'CP_SETTINGS_PROTECTION_REQUIRED');
  need(options.settings===undefined&&options.saveSettings===undefined,'CP_SETTINGS_EXTERNAL_FORBIDDEN');
  super({...options,settings:EMPTY_SETTINGS,saveSettings:()=>{throw Error('CP_SETTINGS_REVIEW_REQUIRED');}});
  this.settingsDraft=null;this.settingsApplying=false;this.refreshProtectedSettings();
 }
 invalidate(code){super.invalidate(code);this.settingsDraft=null;}
 refreshProtectedSettings(){
  // Configuration is not available to a new/locked process before successful decryption.
  try{this.vault.check();}catch{this.settings=EMPTY_SETTINGS;this.settingsDraft=null;return null;}
  try{const record=this.vault.protectedSettings();this.settings=freeze(clone(record.settings));return record;}
  catch(e){this.invalidate('PROTECTED_SETTINGS_INVALID');this.vault.lock();this.settings=EMPTY_SETTINGS;throw e;}
 }
 sweep(){super.sweep();this.refreshProtectedSettings();}
 handle(req,res){try{this.refreshProtectedSettings();}catch{}return super.handle(req,res);}
 idleSettings(){
  this.vault.check();
  need(!this.settingsApplying&&!this.activeApproval&&!this.nonEvm.busy&&!this.dexBusy&&this.vault.pendingOperations===0,'CP_SETTINGS_BUSY');
  const monitor=this.ibc.monitor.status();need(!monitor.enabled&&!monitor.running,'CP_SETTINGS_MONITOR_ACTIVE');
  this.vault.assertSettingsQuiescent();
 }
 async settingsApi(route,b){
  if(route===PREFIX){shape(b,[]);const current=this.vault.protectedSettings();return {...current,settingsSha256:settingsDigest(current),persisted:current.revision>0,storage:'encrypted-vault',applyLocksWallet:true};}
  if(route===PREFIX+'/prepare'){
   shape(b,['settings']);this.idleSettings();const current=this.vault.protectedSettings();
   const next=settingsTransition(current.settings,b.settings,this.origin);
   need(canonical(current.settings)!==canonical(next),'CP_SETTINGS_UNCHANGED');
   const draft={schema:'realdex.protected-settings-review.v1',id:randomUUID(),epoch:this.vault.epoch,
    storageToken:this.store.sessionToken(),baseSha256:settingsDigest(current),baseRevision:current.revision,
    expiresAt:this.now()+90000,before:clone(current.settings),after:clone(next),applyLocksWallet:true,
    requiresNewBackup:true,networkAuthenticationPerformed:false};
   this.settingsDraft=freeze({...draft,reviewSha256:settingsDigest(draft)});
   return clone(this.settingsDraft);
  }
  if(route===PREFIX+'/apply'){
   shape(b,['id','reviewSha256','confirmation']);this.idleSettings();const d=this.settingsDraft;
   need(d&&d.id===b.id&&d.reviewSha256===b.reviewSha256&&b.confirmation==='SAVE SETTINGS AND LOCK','CP_SETTINGS_CONFIRMATION');
   need(this.now()<d.expiresAt&&d.epoch===this.vault.epoch&&d.storageToken===this.store.sessionToken(),'CP_SETTINGS_REVIEW_EXPIRED_OR_CHANGED');
   need(settingsDigest(this.vault.protectedSettings())===d.baseSha256,'CP_SETTINGS_STALE');
   settingsTransition(this.settings,d.after,this.origin);
   this.settingsApplying=true;this.invalidate('PROTECTED_SETTINGS_CHANGED');
   try{
    const result=await this.vault.saveProtectedSettings(d.after,d.baseSha256);
    return {changed:true,locked:true,...result,requiresNewBackup:true,networkAuthenticationPerformed:false};
   }finally{
    // No successful response or new-session authority is retained across failed persistence.
    this.vault.lock();this.settings=EMPTY_SETTINGS;this.invalidate('PROTECTED_SETTINGS_LOCKED');this.settingsApplying=false;
   }
  }
  throw Error('NOT_FOUND');
 }
 async api(route,b){
  this.refreshProtectedSettings();
  if(this.settingsApplying&&!['/api/status','/api/lock'].includes(route))throw Error('CP_SETTINGS_BUSY');
  // Preserve old APIs in standard mode; protected mode never writes an unprotected settings file.
  if(LEGACY_SETTINGS_WRITES.includes(route))throw Error('CP_SETTINGS_REVIEW_REQUIRED');
  if(route===PREFIX||route.startsWith(PREFIX+'/'))return this.settingsApi(route,b);
  try{
   const result=await super.api(route,b);
   const record=this.refreshProtectedSettings();
   if(route==='/api/status')return {...result,...(record?{}:{locked:true,expiresAt:null,accounts:[],smartAccounts:[],agents:[],
    networks:[],allowedAppOrigins:[],solanaNetworks:[],bitcoinNetworks:[],accountNetworks:[],cosmosNetworks:[],ibcRoutes:[]}),
    protectedSettings:{storage:'encrypted-vault',loaded:!!record,
    revision:record?.revision??null,settingsSha256:record?settingsDigest(record):null,reviewRequired:true,requiresNewBackupAfterChange:true}};
   return result;
  }finally{if(!this.vault.key){this.settings=EMPTY_SETTINGS;this.settingsDraft=null;}}
 }
}
