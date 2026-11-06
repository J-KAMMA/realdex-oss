/** Owner-authorized, one-hop ICS-20 transfer. No memo hooks or arbitrary messages. */
import {randomUUID} from 'node:crypto';
import {need,shape,uint,text,freeze,canonical} from '../lib/guard.mjs';
import {keyInfo,sha256,signDigest} from '../lib/keys.mjs';
import {decodeAccountAddress,accountAddress} from '../codec/bech32.mjs';
import {fieldBytes as bytes,fieldText as str,fieldUint as num,anyMessage} from '../codec/protobuf.mjs';
import {cosmosAddress} from '../non-evm/cosmos-offline.mjs';
import {fingerprint,canonicalBase64} from '../non-evm/solana-codec.mjs';
import {U64} from '../non-evm/cosmos-network.mjs';
import * as secp from '../vendor/noble-secp256k1.mjs';
import {parseExactJson} from '../../node/extended/json.mjs';
import {validateIbcRoute,ibcRouteFingerprint,routeAssets,IBC_TYPES,IBC_OPERATION,IBC_ASSURANCE} from './ibc-config.mjs';
export const ibcFrom=(a,r)=>accountAddress(r.source.network.hrp,decodeAccountAddress(a.address,'cosmos'));
export function ibcUser(route,a,raw){
 const r=validateIbcRoute(route),n=r.source.network;need(a.family==='cosmos'&&a.kind==='local','IBC_LOCAL_COSMOS_ACCOUNT_REQUIRED');
 shape(raw,['requestKey','receiver','feeAtomic','gasLimit','timeoutSeconds'],['amount','amountAtomic']);
 need(typeof raw.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey),'PAYMENT_KEY_INVALID');
 need(Object.hasOwn(raw,'amount')!==Object.hasOwn(raw,'amountAtomic'),'IBC_SINGLE_AMOUNT_REQUIRED');
 const receiver=accountAddress(r.destination.network.hrp,decodeAccountAddress(raw.receiver,r.destination.network.hrp));need(receiver===raw.receiver,'IBC_RECEIVER_NONCANONICAL');
 let amountAtomic=raw.amountAtomic;
 if(Object.hasOwn(raw,'amount')){need(typeof raw.amount==='string'&&/^(0|[1-9][0-9]{0,38})(\.[0-9]+)?$/.test(raw.amount),'IBC_DECIMAL_INVALID');const [w,f='']=raw.amount.split('.');need(f.length<=r.asset.decimals,'IBC_DECIMAL_PRECISION');amountAtomic=String(BigInt(w)*10n**BigInt(r.asset.decimals)+BigInt((f.padEnd(r.asset.decimals,'0'))||'0'));}
 const amount=uint(amountAtomic,(1n<<128n)-1n),fee=uint(raw.feeAtomic),gas=uint(raw.gasLimit,10000000n);
 need(amount>0n&&amount<=uint(r.maxTransferAtomic)&&fee>0n&&fee<=uint(n.maxFeeAtomic)&&gas>0n&&gas<=uint(n.maxGasLimit),'IBC_PAYMENT_POLICY');
 need(Number.isInteger(raw.timeoutSeconds)&&raw.timeoutSeconds>=r.minTimeoutSeconds&&raw.timeoutSeconds<=r.maxTimeoutSeconds,'IBC_TIMEOUT_POLICY');
 return {requestKey:raw.requestKey,receiver,amountAtomic:String(amount),feeAtomic:String(fee),gasLimit:String(gas),timeoutSeconds:raw.timeoutSeconds};
}
export const ibcPaymentHash=(r,a,u)=>fingerprint({family:'cosmos',operation:IBC_OPERATION,accountId:a.id,from:a.address,routeFingerprint:ibcRouteFingerprint(r),payment:u});
export function ibcTransaction(p,publicKeyHex){
 need(/^(02|03)[0-9a-f]{64}$/.test(publicKeyHex),'IBC_COMPRESSED_KEY_REQUIRED');const pub=Buffer.from(publicKeyHex,'hex');secp.ProjectivePoint.fromHex(pub);need(cosmosAddress(publicKeyHex,p.hrp)===p.networkFrom,'IBC_SIGNER_MISMATCH');
 const coin=(d,a)=>Buffer.concat([str(1,d),str(2,a)]);
 const msg=Buffer.concat([str(1,'transfer'),str(2,p.sourceChannel),bytes(3,coin(p.denom,p.amountAtomic)),str(4,p.networkFrom),str(5,p.receiver),bytes(6,Buffer.alloc(0)),num(7,BigInt(p.timeoutTimestamp))]);
 const body=Buffer.concat([bytes(1,anyMessage(IBC_TYPES.transfer,msg)),str(2,'RealDEX IBC transfer'),num(3,BigInt(p.timeoutHeight))]);
 const signer=Buffer.concat([bytes(1,anyMessage('/cosmos.crypto.secp256k1.PubKey',bytes(1,pub))),bytes(2,bytes(1,num(1,1n))),num(3,BigInt(p.sequence))]);
 const auth=Buffer.concat([bytes(1,signer),bytes(2,Buffer.concat([bytes(1,coin(p.feeDenom,p.feeAtomic)),num(2,BigInt(p.gasLimit))]))]);
 const signDoc=Buffer.concat([bytes(1,body),bytes(2,auth),str(3,p.chainId),num(4,BigInt(p.accountNumber))]);
 return {body,auth,signDoc,digest:sha256(signDoc)};
}
export function ibcRaw(tx,signature){return Buffer.concat([bytes(1,tx.body),bytes(2,tx.auth),bytes(3,signature)]);}
export function signIbc(secret,p){const info=keyInfo('cosmos',secret);need(info.address===p.from,'IBC_SIGNER_MISMATCH');const tx=ibcTransaction(p,info.publicKeyHex),signature=Buffer.from(signDigest(secret,tx.digest).toCompactRawBytes()),raw=ibcRaw(tx,signature);return {format:'cosmos-sdk-direct-ics20-v1',signature:signature.toString('base64'),publicKeyHex:info.publicKeyHex,signDocHex:tx.signDoc.toString('hex'),txRawBase64:raw.toString('base64'),requestId:sha256(raw).toString('hex').toUpperCase()};}
export function verifyIbcSigned(s,summary){shape(s,['format','signature','publicKeyHex','signDocHex','txRawBase64','requestId']);need(s.format==='cosmos-sdk-direct-ics20-v1','IBC_SIGNATURE_FORMAT');const tx=ibcTransaction(summary.transfer,s.publicKeyHex),sig=canonicalBase64(s.signature,64),raw=ibcRaw(tx,sig);need(sig.length===64&&cosmosAddress(s.publicKeyHex)===summary.from&&s.signDocHex===tx.signDoc.toString('hex')&&s.txRawBase64===raw.toString('base64')&&s.requestId===sha256(raw).toString('hex').toUpperCase()&&secp.verify(sig,tx.digest,Buffer.from(s.publicKeyHex,'hex'),{lowS:true}),'IBC_SIGNATURE_INVALID');return true;}
export function ibcSummary(r,a,u,p){const n=r.source.network,assets=routeAssets(r);return {family:'cosmos',operation:IBC_OPERATION,networkId:n.id,network:n.name,route:r,routeFingerprint:ibcRouteFingerprint(r),from:a.address,networkFrom:p.networkFrom,recipient:u.receiver,amountAtomic:u.amountAtomic,asset:assets.sourceDenom,destinationAsset:assets.destinationDenom,assetSymbol:r.asset.symbol,decimals:r.asset.decimals,feeAsset:n.feeDenom,feeDecimals:n.feeDecimals,feeAtomic:u.feeAtomic,sequenceKey:canonical([n.chainId,a.address,p.accountNumber,p.sequence]),requestKey:u.requestKey,paymentHash:p.paymentHash,userPayment:u,transfer:p,submissionEnabled:n.broadcastEnabled,onChainStateVerified:false,finalityProven:false,assurance:IBC_ASSURANCE,confirmationText:`BRIDGE ${u.receiver} TO ${r.destination.network.chainId}`};}
export function makeIbcIntent(route,a,u,checked,now){const r=validateIbcRoute(route),n=r.source.network,assets=routeAssets(r);
 const p={...u,family:'cosmos',networkId:n.id,chainId:n.chainId,hrp:n.hrp,accountId:a.id,from:a.address,networkFrom:ibcFrom(a,r),sourceChannel:r.source.channel,destinationChannel:r.destination.channel,denom:assets.sourceDenom,feeDenom:n.feeDenom,accountNumber:checked.account.accountNumber,sequence:checked.account.sequence,timeoutHeight:String(BigInt(checked.sourceHead.height)+BigInt(n.timeoutBlocks)),timeoutTimestamp:String(BigInt(checked.destinationHead.time+u.timeoutSeconds*1000)*1000000n),paymentHash:ibcPaymentHash(r,a,u)};
 const expiresAt=Math.min(now+60000,Number(BigInt(p.timeoutTimestamp)/1000000n)-10000);need(expiresAt>now,'IBC_TIMEOUT_TOO_CLOSE');
 const intent={family:'cosmos',accountId:a.id,networkId:n.id,routeFingerprint:ibcRouteFingerprint(r),userPayment:u,payment:p,summary:ibcSummary(r,a,u,p),createdAt:now,expiresAt,salt:randomUUID()};intent.id=fingerprint(intent);return freeze(intent);
}
export function validatePacket(p,summary){
 shape(p,['sequence','source_port','source_channel','destination_port','destination_channel','data','timeout_height','timeout_timestamp']);const r=summary.route,t=summary.transfer;
 need(uint(p.sequence,U64)>0n&&p.source_port==='transfer'&&p.destination_port==='transfer'&&p.source_channel===r.source.channel&&p.destination_channel===r.destination.channel&&p.timeout_timestamp===t.timeoutTimestamp,'IBC_PACKET_LANE_MISMATCH');shape(p.timeout_height,['revision_number','revision_height']);need(p.timeout_height.revision_number==='0'&&p.timeout_height.revision_height==='0','IBC_PACKET_TIMEOUT_MISMATCH');
 const raw=canonicalBase64(p.data,2048);let data;try{data=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:2048,maxNodes:20,maxDepth:4});}catch{throw Error('IBC_PACKET_JSON_INVALID');}
 shape(data,['denom','amount','sender','receiver'],['memo']);need(data.denom===routeAssets(r).packetDenom&&data.amount===t.amountAtomic&&data.sender===t.networkFrom&&data.receiver===t.receiver&&(data.memo===undefined||data.memo===''),'IBC_PACKET_CONTENT_MISMATCH');return p;
}
export function parseAck(encoded){const raw=canonicalBase64(encoded,2048);let j;try{j=parseExactJson(new TextDecoder('utf-8',{fatal:true}).decode(raw),{maxChars:2048,maxNodes:8,maxDepth:2});}catch{throw Error('IBC_ACK_JSON_INVALID');}
 need(j&&typeof j==='object'&&!Array.isArray(j)&&Object.keys(j).length===1,'IBC_ACK_INVALID');if(Object.hasOwn(j,'result')){need(j.result==='AQ==','IBC_ACK_RESULT_INVALID');return {success:true};}shape(j,['error']);text(j.error,1024);return {success:false};}
export function packetCommitment(p){const fixed=Buffer.alloc(24);fixed.writeBigUInt64BE(BigInt(p.timeout_timestamp),0);fixed.writeBigUInt64BE(BigInt(p.timeout_height.revision_number),8);fixed.writeBigUInt64BE(BigInt(p.timeout_height.revision_height),16);return sha256(Buffer.concat([fixed,sha256(Buffer.from(p.data,'base64'))])).toString('base64');}
export function validateIbcRecord(record,a){
 const s=record.summary,r=validateIbcRoute(s.route),u=ibcUser(r,a,s.userPayment),p=s.transfer,n=r.source.network,assets=routeAssets(r);
 shape(p,[...Object.keys(u),'family','networkId','chainId','hrp','accountId','from','networkFrom','sourceChannel','destinationChannel','denom','feeDenom','accountNumber','sequence','timeoutHeight','timeoutTimestamp','paymentHash']);
 for(const k of Object.keys(u))need(p[k]===u[k],'IBC_TRANSFER_BINDING');
 need(p.family==='cosmos'&&p.networkId===n.id&&p.chainId===n.chainId&&p.hrp===n.hrp&&p.accountId===a.id&&p.from===a.address&&p.networkFrom===ibcFrom(a,r)&&p.sourceChannel===r.source.channel&&p.destinationChannel===r.destination.channel&&p.denom===assets.sourceDenom&&p.feeDenom===n.feeDenom&&p.paymentHash===ibcPaymentHash(r,a,u),'IBC_TRANSFER_BINDING');
 uint(p.accountNumber,U64);uint(p.sequence,U64);need(uint(p.timeoutHeight,U64)>0n&&uint(p.timeoutTimestamp,U64)>0n,'IBC_TIMEOUT_REQUIRED');
 need(canonical(s)===canonical(ibcSummary(r,a,u,p))&&record.paymentHash===p.paymentHash&&record.requestKey===u.requestKey,'IBC_SUMMARY_BINDING');verifyIbcSigned(record.signed,s);
 need(['signed','broadcast-unknown','broadcast','reported-confirmed','reported-reverted'].includes(record.state),'IBC_RECORD_STATE');
 if(!record.report){need(record.state==='signed','IBC_REPORT_REQUIRED');return;}
 const v=record.report;shape(v,['observedAt','stage','received','refunded','completed','reason','assurance','finalityProven','stateProofVerified','timeoutElapsed','evidenceRefs'],['source','destination','settlement','packet','acknowledgement','refundDeltaAtomic','settlementKind']);
 need(Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&[v.received,v.refunded,v.completed,v.timeoutElapsed].every(x=>typeof x==='boolean')&&v.assurance===IBC_ASSURANCE&&v.finalityProven===false&&v.stateProofVerified===false,'IBC_REPORT_INVALID');text(v.reason,128);
 need(['signed','source-unresolved','awaiting-receive','awaiting-ack','awaiting-refund','reported-delivered','reported-refunded','source-failed','inconsistent'].includes(v.stage),'IBC_REPORT_STAGE');
 shape(v.evidenceRefs,[],['destinationTxHash','settlementTxHash']);for(const h of Object.values(v.evidenceRefs))need(typeof h==='string'&&/^[A-F0-9]{64}$/.test(h),'IBC_EVIDENCE_HASH');
 for(const k of ['source','destination','settlement'])if(v[k]){const e=v[k];shape(e,['transactionHash','height','blockHash','confirmations','requiredConfirmations','inclusionVerified','executionCode','eventDataAuthenticated']);need(/^[A-F0-9]{64}$/.test(e.transactionHash)&&/^[A-F0-9]{64}$/.test(e.blockHash)&&[e.height,e.confirmations,e.requiredConfirmations].every(x=>Number.isSafeInteger(x)&&x>0)&&e.inclusionVerified===true&&e.eventDataAuthenticated===false&&uint(e.executionCode,0xffffffffn)>=0n,'IBC_EVIDENCE_INVALID');}
 if(v.source)need(v.source.transactionHash===record.signed.requestId&&v.source.requiredConfirmations===n.minConfirmations&&v.source.height>=n.checkpoint.height,'IBC_SOURCE_HASH_MISMATCH');
 if(v.destination)need(v.destination.transactionHash===v.evidenceRefs.destinationTxHash&&v.destination.requiredConfirmations===r.destination.network.minConfirmations&&v.destination.confirmations>=r.destination.network.minConfirmations,'IBC_DESTINATION_EVIDENCE_BINDING');
 if(v.settlement)need(v.settlement.transactionHash===v.evidenceRefs.settlementTxHash&&v.settlement.requiredConfirmations===n.minConfirmations&&v.settlement.confirmations>=n.minConfirmations&&['acknowledge','timeout'].includes(v.settlementKind),'IBC_SETTLEMENT_EVIDENCE_BINDING');
 if(v.packet)validatePacket(v.packet,s);if(v.acknowledgement)parseAck(v.acknowledgement);
 if(v.completed){need(v.source&&v.source.confirmations>=n.minConfirmations,'IBC_SOURCE_EVIDENCE_REQUIRED');
  if(v.stage==='reported-delivered'){need(record.state==='reported-confirmed'&&v.received&&!v.refunded&&v.source.executionCode==='0'&&v.packet&&v.destination?.executionCode==='0'&&v.settlement?.executionCode==='0'&&v.settlementKind==='acknowledge'&&parseAck(v.acknowledgement).success,'IBC_DELIVERY_EVIDENCE_REQUIRED');}
  else if(v.stage==='reported-refunded'){need(record.state==='reported-reverted'&&v.refunded&&!v.received&&v.source.executionCode==='0'&&v.packet&&v.settlement?.executionCode==='0'&&v.refundDeltaAtomic===u.amountAtomic&&(v.settlementKind==='timeout'?v.timeoutElapsed:!!v.destination&&!parseAck(v.acknowledgement).success),'IBC_REFUND_EVIDENCE_REQUIRED');}
  else need(v.stage==='source-failed'&&record.state==='reported-reverted'&&!v.received&&!v.refunded&&BigInt(v.source.executionCode)>0n,'IBC_FAILURE_EVIDENCE_REQUIRED');
 }else need(!v.received&&!v.refunded&&['signed','broadcast','broadcast-unknown'].includes(record.state),'IBC_INCOMPLETE_STATE');
}
