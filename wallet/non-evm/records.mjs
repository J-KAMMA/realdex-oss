import {IBC_OPERATION} from '../bridge/ibc-config.mjs';
import {validateIbcRecord} from '../bridge/ibc-codec.mjs';
import {isAuthzOperation,validateAuthzRecord} from './cosmos-authz-codec.mjs';
import {validateCosmosOnlineRecord} from './cosmos-payment.mjs';
import {COSMOS_ONLINE_OPERATION} from './cosmos-network.mjs';
import {validateOnlineAccountMeta} from './account-payment.mjs';
import {onlineOperation} from './account-network.mjs';
import {normalizeStellarPayment,verifyStellarSigned} from './stellar-offline.mjs';
import {normalizeAptosPayment,verifyAptosSigned} from './aptos-offline.mjs';
import {normalizeCosmosPayment,verifyCosmosSigned} from './cosmos-offline.mjs';
import {normalizeBitcoinPayment,verifyBitcoinSigned} from './bitcoin-offline.mjs';
import {need, shape, uint, canonical,text} from '../lib/guard.mjs';
import {parseSignedSolanaTransfer, fingerprint} from './solana-codec.mjs';
import {parseSignedSplTransfer,TOKEN_PROGRAM} from './spl-codec.mjs';
import {base58Decode} from '../lib/keys.mjs';
import {verifyIcpEnvelope} from './icp-offline.mjs';
export const NON_EVM_STATES=Object.freeze(['signed','broadcast-unknown','broadcast','reported-finalized','reported-reverted','reported-confirmed']);
export function validateNonEvmRecord(r,accounts) {
  shape(r,['id','intentId','requestKey','paymentHash','accountId','family','state','createdAt','summary','signed'],['report']);
  need(typeof r.id==='string'&&/^[a-f0-9-]{36}$/.test(r.id)&&/^[a-f0-9]{64}$/.test(r.intentId)&&/^[a-f0-9]{64}$/.test(r.paymentHash),'NON_EVM_RECORD_ID_INVALID');
  need(typeof r.requestKey==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(r.requestKey),'PAYMENT_KEY_INVALID');
  need(NON_EVM_STATES.includes(r.state)&&Number.isSafeInteger(r.createdAt)&&r.createdAt>=0,'NON_EVM_RECORD_STATE_INVALID');
  const a=accounts.find(a=>a.id===r.accountId);need(a?.kind==='local'&&a.family===r.family&&r.summary.family===r.family,'NON_EVM_RECORD_ACCOUNT_INVALID');
  const s=r.summary;need(s.requestKey===r.requestKey&&s.paymentHash===r.paymentHash&&s.from===a.address,'NON_EVM_RECORD_BINDING_INVALID');
  if(r.family==='solana'){
    if(s.operation==='spl-transfer-checked'){
      shape(r.signed,['format','signature','transactionBase64','messageHex','networkNotBoundByChainId']);
      const p=parseSignedSplTransfer(r.signed.transactionBase64),t=p.transfer;
      need(r.signed.format==='solana-legacy-spl-transfer-checked'&&p.signature===r.signed.signature&&p.messageHex===r.signed.messageHex&&r.signed.networkNotBoundByChainId===true,'SPL_RECORD_SIGNATURE_MISMATCH');
      need(t.from===a.address&&t.source===s.source&&t.destination===s.destination&&t.mint===s.mint&&t.amountAtomic===s.amountAtomic&&t.decimals===s.decimals&&t.recentBlockhash===s.recentBlockhash&&s.programId===TOKEN_PROGRAM,'SPL_RECORD_TRANSFER_MISMATCH');
      base58Decode(s.recipient,32);base58Decode(s.genesisHash,32);
      need(/^solana-local:[a-z0-9-]{1,40}$/.test(s.networkId)&&/^[a-f0-9]{64}$/.test(s.networkFingerprint),'SOLANA_RECORD_NETWORK_MISMATCH');
      const payment={family:'solana',operation:'spl-transfer-checked',networkId:s.networkId,genesisHash:s.genesisHash,accountId:a.id,from:a.address,to:s.recipient,source:t.source,destination:t.destination,mint:t.mint,amountAtomic:t.amountAtomic,decimals:t.decimals,programId:TOKEN_PROGRAM};
      need(fingerprint(payment)===r.paymentHash,'SPL_PAYMENT_HASH_MISMATCH');
      need(s.totalDebitAtomic===s.amountAtomic&&s.totalNativeDebitAtomic===s.feeAtomic&&uint(s.feeAtomic)>0n&&Number.isSafeInteger(s.lastValidBlockHeight)&&Number.isSafeInteger(s.minContextSlot),'SPL_SUMMARY_INVALID');
    }else{
      need(s.operation==='solana-native-transfer','SOLANA_OPERATION_UNSUPPORTED');
    shape(r.signed,['format','signature','transactionBase64','messageHex','networkNotBoundByChainId']);
    const p=parseSignedSolanaTransfer(r.signed.transactionBase64),t=p.transfer;
    need(r.signed.format==='solana-legacy-native-transfer'&&p.signature===r.signed.signature&&p.messageHex===r.signed.messageHex&&r.signed.networkNotBoundByChainId===true,'SOLANA_RECORD_SIGNATURE_MISMATCH');
    need(t.from===a.address&&t.to===s.recipient&&t.lamports===s.amountAtomic&&t.recentBlockhash===s.recentBlockhash,'SOLANA_RECORD_TRANSFER_MISMATCH');
    need(/^solana-local:[a-z0-9-]{1,40}$/.test(s.networkId)&&/^[a-f0-9]{64}$/.test(s.networkFingerprint),'SOLANA_RECORD_NETWORK_MISMATCH');
    const payment={family:'solana',networkId:s.networkId,genesisHash:s.genesisHash,accountId:a.id,from:a.address,to:t.to,lamports:t.lamports};
    need(fingerprint(payment)===r.paymentHash,'SOLANA_PAYMENT_HASH_MISMATCH');
    need(BigInt(s.totalDebitAtomic)===uint(s.amountAtomic)+uint(s.feeAtomic)&&uint(s.feeAtomic)>0n&&Number.isSafeInteger(s.lastValidBlockHeight)&&Number.isSafeInteger(s.minContextSlot),'SOLANA_SUMMARY_INVALID');

    }
  } else if(r.family==='icp'){
    need(r.state==='signed'&&s.submissionEnabled===false&&s.certifiedResponseVerifierImplemented===false&&/^icp:local-[a-z0-9-]{1,40}$/.test(s.networkId),'ICP_OFFLINE_RECORD_REQUIRED');
    verifyIcpEnvelope(r.signed,s);
    const t=s.transfer;
    need(s.recipient===t.to.owner&&s.subaccount===t.to.subaccount&&s.amountAtomic===t.amountAtomic&&s.feeAtomic===t.feeAtomic&&BigInt(s.totalDebitAtomic)===uint(t.amountAtomic)+uint(t.feeAtomic),'ICP_SUMMARY_INVALID');
    const payment={family:'icp',networkId:s.networkId,accountId:a.id,from:a.address,ledger:s.ledger,to:t.to,fromSubaccount:t.fromSubaccount,amountAtomic:t.amountAtomic,feeAtomic:t.feeAtomic,requestedMemoHex:s.requestedMemoHex};
    need(fingerprint(payment)===r.paymentHash,'ICP_PAYMENT_HASH_MISMATCH');
  } else if(r.family==='stellar'||r.family==='aptos'){
    const family=r.family,t=s.transfer,isStellar=family==='stellar';
    const online=s.operation===onlineOperation(family);
    if(online)validateOnlineAccountMeta(r,a);
    else need(r.state==='signed'&&s.operation===(isStellar?'stellar-native-payment-offline':'aptos-native-transfer-offline')&&s.submissionEnabled===false&&s.onChainStateVerified===false,'OFFLINE_RECORD_REQUIRED');
    const names=isStellar?['requestKey','networkPassphrase','to','amountAtomic','feeAtomic','sequence','maxTime','memo']:['requestKey','chainId','to','amountAtomic','sequence','maxGasAmount','gasUnitPrice','expirationTimestampSecs'];
    const p=(isStellar?normalizeStellarPayment:normalizeAptosPayment)(a,{...Object.fromEntries(names.map(k=>[k,t[k]])),acknowledgeUnverifiedState:true});
    const fee=isStellar?BigInt(p.feeAtomic):BigInt(p.maxGasAmount)*BigInt(p.gasUnitPrice),asset=isStellar?'XLM-standalone':'APT-local';
    need(canonical(p)===canonical(t)&&(online||r.paymentHash===p.paymentHash)&&r.requestKey===p.requestKey&&s.networkId===p.networkId&&s.recipient===p.to&&s.amountAtomic===p.amountAtomic&&s.feeAtomic===String(fee)&&s.asset===asset&&s.feeAsset===asset&&s.decimals===(isStellar?7:8)&&s.totalDebitAtomic===String(BigInt(p.amountAtomic)+fee)&&s.sequenceKey===canonical([family,isStellar?p.networkId:p.chainId,p.from,p.sequence]),'OFFLINE_SUMMARY_MISMATCH');
    if(!isStellar)need(s.feeIsMaximum===true,'APTOS_FEE_MAXIMUM_REQUIRED');
    (isStellar?verifyStellarSigned:verifyAptosSigned)(r.signed,s);
  } else if(r.family==='cosmos'){
    if(s.operation===IBC_OPERATION){validateIbcRecord(r,a);return r;}
    if(isAuthzOperation(s.operation)){validateAuthzRecord(r,a);return r;}
    const cosmosOnline=s.operation===COSMOS_ONLINE_OPERATION;
    if(cosmosOnline)validateCosmosOnlineRecord(r,a);
    else need(r.state==='signed'&&s.operation==='cosmos-bank-send-offline'&&s.submissionEnabled===false&&s.onChainStateVerified===false,'COSMOS_OFFLINE_RECORD_REQUIRED');
    const t=s.transfer;
    const keys=['requestKey','chainId','hrp','to','denom','amountAtomic','feeDenom','feeAtomic','gasLimit','accountNumber','sequence','timeoutHeight','memo'];
    const p=normalizeCosmosPayment(a,{...Object.fromEntries(keys.map(k=>[k,t[k]])),acknowledgeUnverifiedState:true});
    need(canonical(p)===canonical(t)&&(cosmosOnline||r.paymentHash===p.paymentHash)&&r.requestKey===p.requestKey&&s.networkId===p.networkId&&s.networkFrom===p.networkFrom&&s.recipient===p.to&&s.amountAtomic===p.amountAtomic&&s.asset===p.denom&&s.feeAsset===p.feeDenom&&s.feeAtomic===p.feeAtomic&&s.sequenceKey===canonical([p.chainId,p.from,p.accountNumber,p.sequence]),'COSMOS_SUMMARY_MISMATCH');
    verifyCosmosSigned(r.signed,s);
  } else if(r.family==='bitcoin'){
    if(s.operation==='bitcoin-p2wpkh-online'){
      need(['signed','broadcast-unknown','broadcast','reported-confirmed'].includes(r.state)&&typeof s.submissionEnabled==='boolean'&&s.onChainStateVerified===false&&s.rpcInputsChecked===true&&/^[0-9a-f]{64}$/.test(s.networkFingerprint)&&s.genesisHash==='0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206'&&Number.isSafeInteger(s.checkpoint?.height)&&s.checkpoint.height>=1&&/^[0-9a-f]{64}$/.test(s.checkpoint.hash),'BITCOIN_ONLINE_RECORD_INVALID');
      need(r.state!=='reported-confirmed'||r.report?.received===true,'BITCOIN_REPORT_INVALID');
      if(r.report){shape(r.report,['observedAt','received','reason','assurance'],['confirmations','blockHash','blockHeight','inclusion','requiredConfirmations','feeAtomic','finalityProven']);need(Number.isSafeInteger(r.report.observedAt)&&r.report.observedAt>=0&&typeof r.report.received==='boolean'&&r.report.finalityProven!==true,'BITCOIN_REPORT_INVALID');text(r.report.reason,128);text(r.report.assurance,200);if(r.report.received)need(r.state==='reported-confirmed'&&r.report.inclusion===true&&Number.isSafeInteger(r.report.confirmations)&&r.report.confirmations>=r.report.requiredConfirmations&&r.report.requiredConfirmations>=1&&r.report.feeAtomic===s.feeAtomic&&/^[0-9a-f]{64}$/.test(r.report.blockHash)&&Number.isSafeInteger(r.report.blockHeight)&&r.report.blockHeight>=1,'BITCOIN_REPORT_INVALID');}
    }else need(r.state==='signed'&&s.operation==='bitcoin-p2wpkh-offline'&&s.submissionEnabled===false&&s.onChainStateVerified===false,'BITCOIN_OFFLINE_RECORD_REQUIRED');
    const t=s.transfer;
    const keys=['requestKey','networkId','to','amountAtomic','feeAtomic','maxFeeRateSatVb','utxos'];
    const p=normalizeBitcoinPayment(a,{...Object.fromEntries(keys.map(k=>[k,t[k]])),acknowledgeUnverifiedState:true});
    need(canonical(p)===canonical(t)&&r.paymentHash===p.paymentHash&&r.requestKey===p.requestKey&&s.networkId===p.networkId&&s.recipient===p.to&&s.amountAtomic===p.amountAtomic&&s.feeAtomic===p.feeAtomic&&s.asset==='BTC-regtest'&&s.feeAsset==='BTC-regtest'&&s.decimals===8&&s.totalDebitAtomic===String(BigInt(p.amountAtomic)+BigInt(p.feeAtomic))&&canonical(s.outpoints)===canonical(p.utxos.map(i=>i.txid+':'+i.vout)),'BITCOIN_SUMMARY_MISMATCH');
    verifyBitcoinSigned(r.signed,s);
  } else throw Error('NON_EVM_FAMILY_UNSUPPORTED');
  return r;
}
export function validateNonEvmJournal(data) {
  if(data.nonEvmJournal===undefined)return;
  need(Array.isArray(data.nonEvmJournal)&&data.nonEvmJournal.length<=128,'NON_EVM_JOURNAL_LIMIT');
  const ids=new Set(),keys=new Set(),signatures=new Set(),sequences=new Set(),outpoints=new Set();
  for(const r of data.nonEvmJournal){validateNonEvmRecord(r,data.accounts);
    if(['cosmos','stellar','aptos'].includes(r.family)){const key=r.family+':'+r.summary.sequenceKey;need(!sequences.has(key),r.family.toUpperCase()+'_SEQUENCE_ALREADY_RESERVED');sequences.add(key);}
    if(r.family==='bitcoin')for(const o of r.summary.outpoints){const key=r.summary.networkId+':'+o;need(!outpoints.has(key),'BITCOIN_OUTPOINT_ALREADY_RESERVED');outpoints.add(key);}
    const key=canonical([r.family,r.accountId,r.summary.networkId,r.requestKey]),sig=r.signed.signature??r.signed.requestId;
    need(!ids.has(r.id)&&!keys.has(key)&&!signatures.has(sig),'NON_EVM_JOURNAL_DUPLICATE');ids.add(r.id);keys.add(key);signatures.add(sig);
  }
}
