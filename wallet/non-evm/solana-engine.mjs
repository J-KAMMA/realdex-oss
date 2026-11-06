import {randomUUID} from 'node:crypto';
import {Rpc} from '../lib/network.mjs';
import {need, shape, clone, canonical, uint, safeError, freeze} from '../lib/guard.mjs';
import {base58Decode, sha256} from '../lib/keys.mjs';
import {solanaTransferMessage, signSolanaTransfer} from '../lib/transactions.mjs';
import {validateSolanaNetwork, solanaNetworkFingerprint, safeRpcInteger} from './solana-network.mjs';
import {SYSTEM_PROGRAM, fingerprint, parseSignedSolanaTransfer, unsignedSolanaTransfer} from './solana-codec.mjs';
const CONFIG = Object.freeze({commitment: 'confirmed'});
export function normalizeSolanaPayment(network, account, raw) {
  shape(raw, ['requestKey', 'to', 'lamports']);
  need(typeof raw.requestKey === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw.requestKey), 'PAYMENT_KEY_INVALID');
  need(account.family === 'solana' && account.kind === 'local', 'SOLANA_LOCAL_ACCOUNT_REQUIRED');
  base58Decode(raw.to, 32); base58Decode(account.address, 32);
  const lamports = String(uint(raw.lamports, BigInt(network.maxTransferLamports)));
  need(BigInt(lamports) > 0n && raw.to !== account.address && raw.to !== SYSTEM_PROGRAM && account.address !== SYSTEM_PROGRAM, 'SOLANA_TRANSFER_INVALID');
  const payment = {family:'solana', networkId:network.id, genesisHash:network.genesisHash, accountId:account.id, from:account.address, to:raw.to, lamports};
  return {...payment, requestKey:raw.requestKey, paymentHash:fingerprint(payment)};
}
function contextValue(r, minSlot = 0) {
  need(r && r.context && Object.hasOwn(r, 'value'), 'SOLANA_RPC_CONTEXT_REQUIRED');
  need(safeRpcInteger(r.context.slot) >= minSlot, 'SOLANA_RPC_CONTEXT_STALE'); return r.value;
}
function systemAccount(a, {allowAbsent = false} = {}) {
  if (a === null && allowAbsent) return 0n;
  need(a && a.owner === SYSTEM_PROGRAM && a.executable === false && Array.isArray(a.data) && a.data.length === 2 && a.data[0] === '' && a.data[1] === 'base64', 'SOLANA_SYSTEM_ACCOUNT_REQUIRED');
  return BigInt(safeRpcInteger(a.lamports));
}
export class SolanaEngine {
  constructor({rpc = new Rpc(), now = Date.now} = {}) {this.rpc = rpc; this.now = now; this.active = new Set();}
  parseSigned(encoded) { return parseSignedSolanaTransfer(encoded); }
  async beforeBroadcast(_network, _record) {}
  async identity(n) {
    const roots = await this.rpc.all(n, 'getGenesisHash', []);
    need(roots.every(v => v === n.genesisHash), 'SOLANA_GENESIS_MISMATCH');
    const health = await this.rpc.all(n, 'getHealth', []); need(health.every(v => v === 'ok'), 'SOLANA_RPC_UNHEALTHY');
  }
  async contextAgree(n, method, params, minSlot = 0, project = x => x) {
    const results = await this.rpc.all(n, method, params);
    const values = results.map(r => project(contextValue(r, minSlot)));
    need(values.every(v => canonical(v) === canonical(values[0])), 'SOLANA_RPC_DISAGREEMENT');
    return values[0];
  }
  async latest(n) {
    await this.identity(n);
    const results = await this.rpc.all(n, 'getLatestBlockhash', [CONFIG]);
    const r = results[0], v = contextValue(r);
    base58Decode(v.blockhash, 32); safeRpcInteger(v.lastValidBlockHeight);
    const slots = results.map(x => {contextValue(x); return safeRpcInteger(x.context.slot);});
    need(Math.max(...slots) - Math.min(...slots) <= 64, 'SOLANA_RPC_CONTEXT_LAG');
    // Use one blockhash then verify that exact blockhash at every endpoint. minContextSlot is NOT a snapshot proof.
    const minContextSlot = Math.max(...slots);
    await this.validity(n, {recentBlockhash:v.blockhash, lastValidBlockHeight:v.lastValidBlockHeight, minContextSlot});
    return {recentBlockhash:v.blockhash, lastValidBlockHeight:v.lastValidBlockHeight, minContextSlot};
  }
  async validity(n, life) {
    const heights = await this.rpc.all(n, 'getBlockHeight', [CONFIG]);
    heights.forEach(safeRpcInteger);
    need(heights.every(h => h + 5 < life.lastValidBlockHeight), 'SOLANA_BLOCKHASH_EXPIRED_OR_CLOSE');
    const valid = await this.contextAgree(n, 'isBlockhashValid', [life.recentBlockhash, {...CONFIG, minContextSlot:life.minContextSlot}], life.minContextSlot);
    need(valid === true, 'SOLANA_BLOCKHASH_INVALID');
  }
  async inspect(n, transfer, life) {
    await this.identity(n); await this.validity(n, life);
    const options = {...CONFIG, encoding:'base64', minContextSlot:life.minContextSlot};
    const accounts = await this.contextAgree(n, 'getMultipleAccounts', [[transfer.from, transfer.to], options], life.minContextSlot, values => {
      need(Array.isArray(values)&&values.length===2,'SOLANA_ACCOUNTS_INVALID');
      return values.map(a=>a===null?null:{lamports:safeRpcInteger(a.lamports),owner:a.owner,executable:a.executable,data:a.data});
    });
    need(Array.isArray(accounts) && accounts.length === 2, 'SOLANA_ACCOUNTS_INVALID');
    const source = systemAccount(accounts[0]), destination = systemAccount(accounts[1], {allowAbsent:true});
    const feeValue = await this.contextAgree(n, 'getFeeForMessage', [solanaTransferMessage(transfer).toString('base64'), {...CONFIG, minContextSlot:life.minContextSlot}], life.minContextSlot);
    const fee = BigInt(safeRpcInteger(feeValue));
    need(fee > 0n && fee <= BigInt(n.maxFeeLamports), 'SOLANA_FEE_CAP_EXCEEDED');
    need(source >= BigInt(transfer.lamports) + fee, 'INSUFFICIENT_SOL_BALANCE');
    const simulations = await this.rpc.all(n, 'simulateTransaction', [unsignedSolanaTransfer(transfer), {...options, sigVerify:false, replaceRecentBlockhash:false, accounts:{encoding:'base64', addresses:[transfer.from, transfer.to]}}]);
    for (const r of simulations) {
      const v = contextValue(r, life.minContextSlot);
      need(v && Object.hasOwn(v,'err') && v.err === null && Array.isArray(v.accounts) && v.accounts.length === 2, 'SOLANA_SIMULATION_FAILED');
      const afterFrom = systemAccount(v.accounts[0]), afterTo = systemAccount(v.accounts[1]);
      need(source - afterFrom === BigInt(transfer.lamports) + fee && afterTo - destination === BigInt(transfer.lamports), 'SOLANA_SIMULATION_BALANCE_MISMATCH');
    }
    return {feeLamports:String(fee), sourceLamports:String(source), destinationLamports:String(destination)};
  }
  async balance(network, account) {
    const n = validateSolanaNetwork(network); need(account.family === 'solana', 'SOLANA_ACCOUNT_REQUIRED');
    await this.identity(n);
    const value = await this.contextAgree(n, 'getBalance', [account.address, CONFIG]);
    return {networkId:n.id, address:account.address, lamports:String(safeRpcInteger(value)), decimals:9, assurance:'local-RPC-observation-not-consensus-proof', observedAt:this.now()};
  }
  async prepare(network, account, raw) {
    const n = validateSolanaNetwork(network), payment = normalizeSolanaPayment(n, account, raw), life = await this.latest(n);
    const transfer = {from:payment.from, to:payment.to, lamports:payment.lamports, recentBlockhash:life.recentBlockhash};
    const costs = await this.inspect(n, transfer, life), createdAt = this.now(), expiresAt = createdAt + 60000;
    const intent = {family:'solana', accountId:account.id, networkId:n.id, networkFingerprint:solanaNetworkFingerprint(n), genesisHash:n.genesisHash, payment, life, transfer, costs, createdAt, expiresAt, salt:randomUUID()};
    intent.summary = {family:'solana', operation:'solana-native-transfer', networkId:n.id, network:n.name, genesisHash:n.genesisHash, networkFingerprint:intent.networkFingerprint, from:transfer.from, recipient:transfer.to, amountAtomic:transfer.lamports, asset:'SOL', decimals:9, feeAtomic:costs.feeLamports, totalDebitAtomic:String(BigInt(transfer.lamports)+BigInt(costs.feeLamports)), recentBlockhash:life.recentBlockhash, lastValidBlockHeight:life.lastValidBlockHeight, minContextSlot:life.minContextSlot, expiresAt, requestKey:payment.requestKey, paymentHash:payment.paymentHash, assurance:'local-RPC-observation-not-consensus-proof'};
    intent.id = fingerprint(intent);
    return freeze(intent);
  }
  verifyIntent(n, intent) {
    const {id, ...content} = intent;
    need(fingerprint(content) === id && solanaNetworkFingerprint(n) === intent.networkFingerprint, 'SOLANA_INTENT_CHANGED');
    need(this.now() >= intent.createdAt && this.now() < intent.expiresAt, 'SOLANA_INTENT_EXPIRED');
  }
  async sign(vault, network, intent, {authorize = () => {}} = {}) {
    const n = validateSolanaNetwork(network); this.verifyIntent(n, intent);
    vault.check(); const epoch = vault.epoch;
    const account = vault.account(intent.accountId); need(account.address === intent.transfer.from, 'SIGNER_ADDRESS_MISMATCH');
    const costs = await this.inspect(n, intent.transfer, intent.life);
    need(costs.feeLamports === intent.costs.feeLamports, 'SOLANA_FEE_CHANGED');
    need(epoch === vault.epoch, 'LOCK_INTERRUPTED_OPERATION');
    return vault.signNonEvmAndRecord(intent, secret => {
      authorize(); this.verifyIntent(n, intent); need(epoch === vault.epoch, 'LOCK_INTERRUPTED_OPERATION');
      return signSolanaTransfer(secret, intent.transfer);
    });
  }
  async currentRecord(vault, n, candidate) {
    const record = (await vault.nonEvmRecords()).find(r => r.id === candidate.id);
    need(record && canonical(record) === canonical(candidate), 'NON_EVM_RECORD_CHANGED');
    need(record.family === 'solana' && record.summary.networkFingerprint === solanaNetworkFingerprint(n) && record.summary.genesisHash === n.genesisHash, 'SOLANA_RECORD_NETWORK_MISMATCH');
    const decoded = this.parseSigned(record.signed.transactionBase64);
    need(decoded.signature === record.signed.signature, 'SOLANA_RECORD_SIGNATURE_MISMATCH');
    return record;
  }
  async broadcast(vault, network, candidate, {authorize = () => {}} = {}) {
    const n = validateSolanaNetwork(network); need(n.broadcastEnabled, 'BROADCAST_DISABLED');
    need(!this.active.has(candidate.accountId), 'SOLANA_OPERATION_BUSY'); this.active.add(candidate.accountId);
    try {
      vault.check(); const epoch = vault.epoch;
      let record = await this.currentRecord(vault, n, candidate);
      need(record.state === 'signed', 'SOLANA_AUTOMATIC_REBROADCAST_FORBIDDEN');
      const assertActive = () => {vault.check(); need(vault.epoch === epoch, 'LOCK_INTERRUPTED_OPERATION'); authorize();};
      assertActive(); await this.identity(n);
      await this.validity(n, {recentBlockhash:record.summary.recentBlockhash, lastValidBlockHeight:record.summary.lastValidBlockHeight, minContextSlot:record.summary.minContextSlot});
      const parsed = this.parseSigned(record.signed.transactionBase64);
      const fee = await this.contextAgree(n, 'getFeeForMessage', [Buffer.from(parsed.messageHex, 'hex').toString('base64'), {...CONFIG, minContextSlot:record.summary.minContextSlot}], record.summary.minContextSlot);
      need(String(safeRpcInteger(fee)) === record.summary.feeAtomic, 'SOLANA_FEE_CHANGED');
      await this.beforeBroadcast(n,record);
      assertActive();
      // Persist uncertainty BEFORE releasing signed bytes to any RPC endpoint.
      record = await vault.observeNonEvm(record, 'broadcast-unknown', {observedAt:this.now(), reason:'submission-may-have-started', received:false});
      assertActive();
      let report, state;
      try {
        const signature = await this.rpc.call(n.rpcUrls[0], 'sendTransaction', [record.signed.transactionBase64, {encoding:'base64', skipPreflight:false, preflightCommitment:'confirmed', maxRetries:0, minContextSlot:record.summary.minContextSlot}]);
        need(signature === record.signed.signature, 'SOLANA_RPC_SIGNATURE_MISMATCH');
        state = 'broadcast'; report = {observedAt:this.now(), received:false, reason:'RPC-accepted-not-finalized'};
      } catch (error) {state = 'broadcast-unknown'; report = {observedAt:this.now(), received:false, reason:safeError(error)};}
      assertActive(); return await vault.observeNonEvm(record, state, report);
    } finally {this.active.delete(candidate.accountId);}
  }
  receipt(record,status,tx) {
            const fee = BigInt(safeRpcInteger(tx.meta.fee)); need(fee <= BigInt(record.summary.feeAtomic), 'SOLANA_ACTUAL_FEE_EXCEEDED');
            need(Array.isArray(tx.meta.preBalances) && tx.meta.preBalances.length===3 && Array.isArray(tx.meta.postBalances) && tx.meta.postBalances.length===3, 'SOLANA_BALANCE_PROOF_SHAPE');
            const pre=tx.meta.preBalances.map(v=>BigInt(safeRpcInteger(v))), post=tx.meta.postBalances.map(v=>BigInt(safeRpcInteger(v)));
            if (status.err === null) need(pre[0]-post[0]===BigInt(record.summary.amountAtomic)+fee && post[1]-pre[1]===BigInt(record.summary.amountAtomic) && post[2]===pre[2], 'SOLANA_RECEIPT_BALANCE_MISMATCH');
            else need(pre[0]-post[0]===fee && post[1]===pre[1] && post[2]===pre[2], 'SOLANA_FAILURE_BALANCE_MISMATCH');
            return {slot:tx.slot,feeAtomic:String(fee),pre:pre.map(String),post:post.map(String)};
  }
  async reconcile(vault, network, candidate) {
    const n = validateSolanaNetwork(network); vault.check(); const epoch = vault.epoch;
    const record = await this.currentRecord(vault, n, candidate);
    let state = record.state === 'signed' ? 'signed' : 'broadcast-unknown', report = {observedAt:this.now(), received:false, reason:'unresolved'};
    try {
      await this.identity(n);
      const statuses = await this.contextAgree(n, 'getSignatureStatuses', [[record.signed.signature], {searchTransactionHistory:true}]);
      need(Array.isArray(statuses) && statuses.length === 1, 'SOLANA_STATUS_INVALID');
      const status = statuses[0];
      if (status === null) {
        const heights = await this.rpc.all(n,'getBlockHeight',[{commitment:'finalized'}]); heights.forEach(safeRpcInteger);
        report.reason = heights.every(h => h > record.summary.lastValidBlockHeight) ? 'expired-unresolved-no-automatic-replacement' : 'not-observed';
      } else {
        state='broadcast-unknown';
        safeRpcInteger(status.slot); need(['processed','confirmed','finalized'].includes(status.confirmationStatus) && Object.hasOwn(status,'err'), 'SOLANA_STATUS_INVALID');
        report.slot = status.slot; report.commitment = status.confirmationStatus;
        if (status.confirmationStatus !== 'finalized') {report.reason='not-finalized';}
        else {
          const transactions = await this.rpc.all(n,'getTransaction',[record.signed.signature,{encoding:'base64',commitment:'finalized',maxSupportedTransactionVersion:0}]);
          const observations = transactions.map(tx => {
            need(tx && tx.slot === status.slot && Array.isArray(tx.transaction) && tx.transaction[1] === 'base64' && tx.transaction[0] === record.signed.transactionBase64, 'SOLANA_TRANSACTION_BINDING_MISMATCH');
            need(tx.meta && Object.hasOwn(tx.meta,'err') && canonical(tx.meta.err) === canonical(status.err), 'SOLANA_RESULT_MISMATCH');
            return this.receipt(record,status,tx);
          });
          need(observations.every(o=>canonical(o)===canonical(observations[0])), 'SOLANA_RPC_DISAGREEMENT');
          state=status.err===null?'reported-finalized':'reported-reverted';
          report={...report,...observations[0],received:status.err===null,reason:'RPC-reported-finalized',assurance:'RPC agreement; no light-client proof'};
        }
      }
    } catch(error) {report={observedAt:this.now(),received:false,reason:safeError(error)};}
    vault.check(); need(epoch===vault.epoch,'LOCK_INTERRUPTED_OPERATION');
    return vault.observeNonEvm(record,state,report);
  }
}
