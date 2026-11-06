/** Owner-only, two-step policy replacement. This is explicit local trust, not code certification. */
import {createHash,randomUUID} from 'node:crypto';
import {canonical,clone,need,shape} from './guard.mjs';
import {validateNetwork,validateSettings} from './network.mjs';
const digest=x=>createHash('sha256').update(canonical(x)).digest('hex');
export class NetworkReview {
  constructor(server){this.server=server;this.draft=null;}
  invalidate(){this.draft=null;}
  prepare(input){
    shape(input,['network']);const s=this.server;s.vault.touch();const next=validateNetwork(input.network),before=s.network(next.chainId);
    need(before.genesisHash===next.genesisHash,'NETWORK_GENESIS_REPLACEMENT_FORBIDDEN');
    need(canonical(before)!==canonical(next),'NETWORK_POLICY_UNCHANGED');
    const settings=validateSettings({...s.settings,networks:s.settings.networks.map(n=>n.chainId===next.chainId?next:n)});
    const map=new Map(before.contracts.map(c=>[c.address,c])),changed=[];
    for(const c of next.contracts){const old=map.get(c.address);if(!old||canonical(old)!==canonical(c))changed.push({action:old?'changed':'added',before:old??null,after:c});map.delete(c.address);}
    for(const old of map.values())changed.push({action:'removed',before:old,after:null});
    const draft={id:randomUUID(),digest:digest(next),settingsDigest:digest(s.settings),epoch:s.vault.epoch,expiresAt:s.now()+90000,settings};
    this.draft=draft;
    return {schema:'realdex.network-policy-review.v1',id:draft.id,digest:draft.digest,chainId:next.chainId,expiresAt:draft.expiresAt,
      confirmation:`REPLACE ${next.chainId} AND LOCK`,before:clone(before),after:clone(next),contractChanges:clone(changed),
      applyLocksWallet:true,existingSessionsAndAgentsInvalidated:true,contractsCertified:false,automaticTrustPromotion:false};
  }
  apply(input){
    shape(input,['id','digest','confirmation']);const s=this.server;s.vault.check();const d=this.draft;
    need(d&&s.now()<d.expiresAt&&d.epoch===s.vault.epoch&&d.id===input.id&&d.digest===input.digest,'NETWORK_REVIEW_EXPIRED_OR_CHANGED');
    need(d.settingsDigest===digest(s.settings),'NETWORK_SETTINGS_CHANGED');
    const n=d.settings.networks.find(n=>digest(n)===d.digest);need(n&&input.confirmation===`REPLACE ${n.chainId} AND LOCK`,'NETWORK_REVIEW_CONFIRMATION_REQUIRED');
    // No await between guard, epoch invalidation and synchronous atomic settings persistence.
    // A live signature/broadcast may already be irreversible; do not mutate its policy.
    need(!s.activeApproval&&!s.nonEvm?.busy,'APPROVAL_BUSY');
    s.invalidate('NETWORK_POLICY_REPLACED');s.vault.lock();
    s.saveSettings(d.settings);s.settings=d.settings;
    return {changed:true,locked:true,chainId:n.chainId,digest:d.digest,agentsRequireReauthorization:true,contractsCertified:false};
  }
}
