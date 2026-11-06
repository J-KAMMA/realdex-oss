/** Restricted Cosmos native authorization. No generic authz, feegrant, staking or nested Exec. */
import {randomUUID} from 'node:crypto';
import {need, shape, uint, canonical, clone, freeze, text} from '../lib/guard.mjs';
import {keyInfo, sha256, signDigest} from '../lib/keys.mjs';
import {decodeAccountAddress, accountAddress} from '../codec/bech32.mjs';
import {fieldBytes as bytes, fieldText as str, fieldUint as num, anyMessage} from '../codec/protobuf.mjs';
import {cosmosAddress} from './cosmos-offline.mjs';
import {canonicalBase64, fingerprint} from './solana-codec.mjs';
import {validateCosmosNetwork, cosmosNetworkFingerprint, COSMOS_ASSURANCE, U64} from './cosmos-network.mjs';
import * as secp from '../vendor/noble-secp256k1.mjs';

export const AUTHZ_TYPES = Object.freeze({send:'/cosmos.bank.v1beta1.MsgSend', authorization:'/cosmos.bank.v1beta1.SendAuthorization', grant:'/cosmos.authz.v1beta1.MsgGrant', revoke:'/cosmos.authz.v1beta1.MsgRevoke', execute:'/cosmos.authz.v1beta1.MsgExec'});
export const isAuthzOperation = op => ['grant','revoke','execute'].some(a=>op===`cosmos-authz-${a}-online`);
export const authzAddress = (address, hrp) => accountAddress(hrp, decodeAccountAddress(address, hrp));
export const authzFrom = (a,n) => accountAddress(n.hrp,decodeAccountAddress(a.address,'cosmos'));
export const MAX_GRANT_SECONDS = 7 * 86400;

export function authzUser(a,n,raw) {
  need(a.family==='cosmos'&&a.kind==='local','COSMOS_LOCAL_ACCOUNT_REQUIRED');
  need(raw && ['grant','revoke','execute'].includes(raw.action),'AUTHZ_ACTION_UNSUPPORTED');
  const fields=raw.action==='grant'?['grantee','recipient','limitAtomic','expirationSeconds']:raw.action==='revoke'?['grantee']:['granter','recipient','amountAtomic'];
  shape(raw,['action','requestKey','feeAtomic','gasLimit',...fields],['memo']);
  need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
  const feeAtomic=String(uint(raw.feeAtomic)),gasLimit=String(uint(raw.gasLimit,10000000n));
  need(BigInt(feeAtomic)>0n&&BigInt(feeAtomic)<=BigInt(n.maxFeeAtomic)&&BigInt(gasLimit)>0n&&BigInt(gasLimit)<=BigInt(n.maxGasLimit),'AUTHZ_FEE_POLICY');
  const memo=raw.memo??'';if(memo)text(memo,128);need(typeof memo==='string'&&Buffer.byteLength(memo)<=128,'COSMOS_MEMO_LIMIT');
  const u={action:raw.action,requestKey:raw.requestKey,feeAtomic,gasLimit,memo};
  const from=authzFrom(a,n),peer=raw.action==='execute'?'granter':'grantee';u[peer]=authzAddress(raw[peer],n.hrp);
  need(u[peer]!==from,'AUTHZ_SELF_DELEGATION_FORBIDDEN');
  if(raw.action!=='revoke') {
    u.recipient=authzAddress(raw.recipient,n.hrp);
    need(u.recipient!==(raw.action==='execute'?u.granter:from),'SELF_TRANSFER_FORBIDDEN');
    const k=raw.action==='grant'?'limitAtomic':'amountAtomic';u[k]=String(uint(raw[k]));
    need(BigInt(u[k])>0n&&BigInt(u[k])<=BigInt(n.maxTransferAtomic),'AUTHZ_AMOUNT_POLICY');
  }
  if(raw.action==='grant')u.expirationSeconds=String(uint(raw.expirationSeconds,253402300799n));
  return u;
}
export const authzPaymentHash=(a,n,u)=>fingerprint({family:'cosmos',accountId:a.id,from:a.address,networkId:n.id,networkFingerprint:cosmosNetworkFingerprint(n),authorization:u});
const coin=(d,a)=>Buffer.concat([str(1,d),str(2,a)]);
export function authzTransaction(p,publicKeyHex) {
  need(/^(02|03)[0-9a-f]{64}$/.test(publicKeyHex),'COSMOS_COMPRESSED_KEY_REQUIRED');
  const pub=Buffer.from(publicKeyHex,'hex');secp.ProjectivePoint.fromHex(pub);
  need(cosmosAddress(publicKeyHex,p.hrp)===p.networkFrom,'COSMOS_SIGNER_MISMATCH');
  let msg;
  if(p.action==='grant') {
    const permission=Buffer.concat([bytes(1,coin(p.denom,p.limitAtomic)),str(2,p.recipient)]);
    const grant=Buffer.concat([bytes(1,anyMessage(AUTHZ_TYPES.authorization,permission)),bytes(2,num(1,BigInt(p.expirationSeconds)))]);
    msg=Buffer.concat([str(1,p.networkFrom),str(2,p.grantee),bytes(3,grant)]);
  } else if(p.action==='revoke')msg=Buffer.concat([str(1,p.networkFrom),str(2,p.grantee),str(3,AUTHZ_TYPES.send)]);
  else if(p.action==='execute') {
    const send=Buffer.concat([str(1,p.granter),str(2,p.recipient),bytes(3,coin(p.denom,p.amountAtomic))]);
    msg=Buffer.concat([str(1,p.networkFrom),bytes(2,anyMessage(AUTHZ_TYPES.send,send))]);
  } else throw Error('AUTHZ_ACTION_UNSUPPORTED');
  const body=Buffer.concat([bytes(1,anyMessage(AUTHZ_TYPES[p.action],msg)),...(p.memo?[str(2,p.memo)]:[]),num(3,BigInt(p.timeoutHeight))]);
  const signer=Buffer.concat([bytes(1,anyMessage('/cosmos.crypto.secp256k1.PubKey',bytes(1,pub))),bytes(2,bytes(1,num(1,1n))),num(3,BigInt(p.sequence))]);
  const fee=Buffer.concat([bytes(1,coin(p.feeDenom,p.feeAtomic)),num(2,BigInt(p.gasLimit))]);
  const auth=Buffer.concat([bytes(1,signer),bytes(2,fee)]);
  const signDoc=Buffer.concat([bytes(1,body),bytes(2,auth),str(3,p.chainId),num(4,BigInt(p.accountNumber))]);
  return {body,auth,signDoc,digest:sha256(signDoc)};
}
export function signAuthz(secret,p) {
  const info=keyInfo('cosmos',secret);need(info.address===p.from,'COSMOS_SIGNER_MISMATCH');
  const tx=authzTransaction(p,info.publicKeyHex),signature=Buffer.from(signDigest(secret,tx.digest).toCompactRawBytes());
  const raw=Buffer.concat([bytes(1,tx.body),bytes(2,tx.auth),bytes(3,signature)]);
  return {format:'cosmos-sdk-direct-restricted-authz',signature:signature.toString('base64'),publicKeyHex:info.publicKeyHex,txRawBase64:raw.toString('base64'),signDocHex:tx.signDoc.toString('hex'),requestId:sha256(raw).toString('hex').toUpperCase()};
}
export function verifyAuthz(s,summary) {
  shape(s,['format','signature','publicKeyHex','txRawBase64','signDocHex','requestId']);
  need(s.format==='cosmos-sdk-direct-restricted-authz','AUTHZ_FORMAT_INVALID');
  const tx=authzTransaction(summary.transfer,s.publicKeyHex),sig=canonicalBase64(s.signature,64);
  const raw=Buffer.concat([bytes(1,tx.body),bytes(2,tx.auth),bytes(3,sig)]);
  need(sig.length===64&&cosmosAddress(s.publicKeyHex)===summary.from&&s.txRawBase64===raw.toString('base64')&&s.signDocHex===tx.signDoc.toString('hex')&&s.requestId===sha256(raw).toString('hex').toUpperCase()&&secp.verify(sig,tx.digest,Buffer.from(s.publicKeyHex,'hex'),{lowS:true}),'AUTHZ_SIGNATURE_BINDING');
  return true;
}
export function authzSummary(n,a,u,p,grantBefore) {
  const granter=u.action==='execute'?u.granter:p.networkFrom,grantee=u.action==='execute'?p.networkFrom:u.grantee;
  const confirmationText=u.action==='grant'?`GRANT ${grantee} ${u.limitAtomic} ${n.denom} TO ${u.recipient} UNTIL ${u.expirationSeconds}`:u.action==='revoke'?`REVOKE ${grantee}`:u.recipient;
  return {family:'cosmos',operation:`cosmos-authz-${u.action}-online`,action:u.action,networkId:n.id,network:n.name,networkFingerprint:cosmosNetworkFingerprint(n),cosmosNetwork:clone(n),from:a.address,networkFrom:p.networkFrom,granter,grantee,recipient:u.recipient??u.grantee,amountAtomic:u.amountAtomic??'0',limitAtomic:u.limitAtomic??null,asset:n.denom,assetSymbol:n.symbol,decimals:n.decimals,feeAsset:n.feeDenom,feeDecimals:n.feeDecimals,feeAtomic:u.feeAtomic,feePayer:p.networkFrom,sequenceKey:canonical([p.chainId,p.from,p.accountNumber,p.sequence]),requestKey:u.requestKey,paymentHash:p.paymentHash,userPayment:clone(u),transfer:clone(p),grantBefore:clone(grantBefore),confirmationText,submissionEnabled:n.broadcastEnabled,onChainStateVerified:false,finalityProven:false,assurance:COSMOS_ASSURANCE,checkpoint:clone(n.checkpoint)};
}
export function makeAuthzIntent(n,a,u,account,head,grantBefore,now=Date.now()) {
  const paymentHash=authzPaymentHash(a,n,u);
  const p={...u,family:'cosmos',networkId:n.id,chainId:n.chainId,hrp:n.hrp,accountId:a.id,from:a.address,networkFrom:authzFrom(a,n),denom:n.denom,feeDenom:n.feeDenom,accountNumber:account.accountNumber,sequence:account.sequence,timeoutHeight:String(head.height+n.timeoutBlocks),paymentHash};
  const intent={family:'cosmos',accountId:a.id,networkId:n.id,networkFingerprint:cosmosNetworkFingerprint(n),userPayment:u,payment:p,createdAt:now,expiresAt:now+60000,salt:randomUUID(),summary:authzSummary(n,a,u,p,grantBefore)};
  intent.id=fingerprint(intent);return freeze(intent);
}
export function validateAuthzRecord(r,a) {
  const s=r.summary,n=validateCosmosNetwork(s.cosmosNetwork),u=authzUser(a,n,s.userPayment),p=s.transfer;
  need(isAuthzOperation(s.operation)&&s.operation===`cosmos-authz-${u.action}-online`,'AUTHZ_OPERATION_INVALID');
  shape(p,[...Object.keys(u),'family','networkId','chainId','hrp','accountId','from','networkFrom','denom','feeDenom','accountNumber','sequence','timeoutHeight','paymentHash']);
  for(const k of Object.keys(u))need(p[k]===u[k],'AUTHZ_TRANSFER_BINDING');
  need(p.family==='cosmos'&&p.networkId===n.id&&p.chainId===n.chainId&&p.hrp===n.hrp&&p.accountId===a.id&&p.from===a.address&&p.networkFrom===authzFrom(a,n)&&p.denom===n.denom&&p.feeDenom===n.feeDenom&&p.paymentHash===authzPaymentHash(a,n,u),'AUTHZ_NETWORK_BINDING');
  uint(p.accountNumber,U64);uint(p.sequence,U64);need(uint(p.timeoutHeight,U64)>0n,'AUTHZ_TIMEOUT_REQUIRED');
  need(canonical(s)===canonical(authzSummary(n,a,u,p,s.grantBefore))&&r.paymentHash===p.paymentHash&&r.requestKey===u.requestKey,'AUTHZ_SUMMARY_BINDING');
  const prior=s.grantBefore;
  if(u.action==='grant')need(prior===null,'AUTHZ_PRIOR_STATE_INVALID');
  else {
    need(prior&&['restricted-send','unsupported'].includes(prior.kind)&&/^[0-9a-f]{64}$/.test(prior.fingerprint),'AUTHZ_PRIOR_STATE_INVALID');
    shape(prior,prior.kind==='restricted-send'?['kind','fingerprint','denom','remainingAtomic','recipient','expirationSeconds']:['kind','fingerprint']);
    if(prior.kind==='restricted-send'){
      need(prior.denom===n.denom&&uint(prior.remainingAtomic)>0n&&uint(prior.expirationSeconds,253402300799n)>0n&&authzAddress(prior.recipient,n.hrp)===prior.recipient,'AUTHZ_PRIOR_STATE_INVALID');
    }
    if(u.action==='execute')need(prior.kind==='restricted-send'&&prior.recipient===u.recipient&&uint(prior.remainingAtomic)>=uint(u.amountAtomic),'AUTHZ_PRIOR_STATE_INVALID');
  }
  verifyAuthz(r.signed,s);
  need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(r.state),'AUTHZ_STATE_INVALID');
  if(!r.report){need(r.state==='signed','AUTHZ_REPORT_REQUIRED');return;}
  const v=r.report;
  shape(v,['observedAt','received','completed','reason','assurance','finalityProven'],['height','blockHash','feeAtomic','gasUsed','code','inclusionVerified','stateProofVerified','confirmations','requiredConfirmations','authorizationStateObserved','grantFingerprintAfter']);
  need(Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&typeof v.received==='boolean'&&typeof v.completed==='boolean'&&v.assurance===COSMOS_ASSURANCE&&v.finalityProven===false,'AUTHZ_REPORT_INVALID');text(v.reason,128);
  if(v.grantFingerprintAfter!==undefined)need(v.grantFingerprintAfter===null||/^[0-9a-f]{64}$/.test(v.grantFingerprintAfter),'AUTHZ_REPORT_INVALID');
  if(['reported-confirmed','reported-reverted'].includes(r.state)) {
    need(Number.isSafeInteger(v.code)&&v.code>=0&&v.code<=0xffffffff,'AUTHZ_REPORT_INVALID');
    need(v.inclusionVerified===true&&v.stateProofVerified===false&&v.feeAtomic===u.feeAtomic&&uint(v.gasUsed)<=uint(u.gasLimit)&&Number.isSafeInteger(v.height)&&v.height>=n.checkpoint.height&&/^[A-F0-9]{64}$/.test(v.blockHash)&&Number.isSafeInteger(v.confirmations)&&v.confirmations>=n.minConfirmations&&v.requiredConfirmations===n.minConfirmations,'AUTHZ_REPORT_EVIDENCE_INVALID');
    need(r.state==='reported-confirmed'?v.code===0&&v.completed&&v.received===(u.action==='execute')&&v.authorizationStateObserved===true:v.code>0&&!v.completed&&!v.received,'AUTHZ_REPORT_STATE_INVALID');
  }else need(!v.completed&&!v.received,'AUTHZ_REPORT_STATE_INVALID');
}
