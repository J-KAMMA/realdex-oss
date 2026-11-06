/** Local, revocable AI transfer permissions. No private key or arbitrary signing RPC is exposed. */
import {randomBytes, randomUUID} from 'node:crypto';
import {need, shape, clone, safeError} from './guard.mjs';
import {transferRequest, readTransferBalance} from './transfers.mjs';
import {
  AUTO_CONFIRMATION, MANUAL_CONFIRMATION, normalizePolicy, normalizeAgentTransfer,
  hashObject, tokenHash, assertPolicyActive, assertCanReserve, assertTransferIntent,
  publicPolicy, validateAgentData,
} from './agent-policy.mjs';

export class AgentController {
  constructor(wallet) {
    this.wallet = wallet;
    this.capabilities = new Map(); // Hash -> active vault epoch; raw capabilities are returned only once.
    this.drafts = new Map();
    this.inflight = new Set();
    this.rates = new Map();
  }
  get vault() { return this.wallet.vault; }
  now() { return this.wallet.now(); }
  policies() { this.vault.check(); return this.vault.data.agentPolicies ?? []; }
  claims() { this.vault.check(); return this.vault.data.agentRequests ?? []; }
  initState() {
    this.vault.check();
    this.vault.data.agentPolicies ??= [];
    this.vault.data.agentRequests ??= [];
  }
  policy(id) { const p = this.policies().find(p => p.id === id); need(p, 'AGENT_POLICY_NOT_FOUND'); return p; }
  claim(id) { const r = this.claims().find(r => r.id === id); need(r, 'AGENT_REQUEST_NOT_FOUND'); return r; }
  active(policy) {
    const cap = this.capabilities.get(policy.tokenHash);
    return !!cap && cap.id === policy.id && cap.epoch === this.vault.epoch && this.now() < policy.expiresAt && policy.status === 'active';
  }
  invalidate() { this.capabilities.clear(); this.drafts.clear(); }
  deactivate(id) { for (const [k, v] of this.capabilities) if (v.id === id) this.capabilities.delete(k); }
  authorize(rawToken) {
    need(typeof rawToken === 'string' && /^[0-9a-f]{64}$/.test(rawToken), 'AGENT_UNAUTHORIZED');
    const digest = tokenHash(rawToken), cap = this.capabilities.get(digest);
    need(cap, 'AGENT_UNAUTHORIZED');
    this.vault.check();
    need(cap.epoch === this.vault.epoch, 'AGENT_REACTIVATION_REQUIRED');
    const p = this.policy(cap.id);
    need(p.tokenHash === digest, 'AGENT_UNAUTHORIZED');
    assertPolicyActive(p, this.wallet.network(p.chainId), this.now());
    return p;
  }
  rateLimit(policy) {
    const now = this.now(), r = this.rates.get(policy.id);
    const bucket = !r || now - r.at >= 60000 || now < r.at ? {at: now, n: 0} : r;
    need(++bucket.n <= 60, 'AGENT_RATE_LIMIT'); this.rates.set(policy.id, bucket);
  }
  list() {
    return this.policies().map(p => publicPolicy(p, this.claims(), this.now(), this.active(p)));
  }
  preparePolicy(raw) {
    this.vault.touch();
    for (const [id, d] of this.drafts) if (this.now() >= d.expiresAt || d.epoch !== this.vault.epoch) this.drafts.delete(id);
    need(this.drafts.size < 8 && this.policies().length < 32, 'AGENT_POLICY_LIMIT');
    const policy = normalizePolicy(raw, this.wallet.network(raw.chainId), this.vault.account(raw.accountId), this.now(), randomUUID());
    const draft = {id: randomUUID(), digest: hashObject(policy), policy, epoch: this.vault.epoch,
      expiresAt: Math.min(this.now() + 60000, policy.expiresAt)};
    this.drafts.set(draft.id, draft);
    return {draftId: draft.id, digest: draft.digest, expiresAt: draft.expiresAt,
      policy: publicPolicy(policy, [], this.now(), false),
      confirmation: policy.mode === 'auto' ? AUTO_CONFIRMATION : MANUAL_CONFIRMATION};
  }
  async createPolicy({draftId, digest, confirmation}) {
    return this.vault.serial(async () => {
      this.vault.touch();
      const d = this.drafts.get(draftId);
      need(d && d.epoch === this.vault.epoch && this.now() < d.expiresAt && digest === d.digest, 'AGENT_DRAFT_EXPIRED_OR_CHANGED');
      need(confirmation === (d.policy.mode === 'auto' ? AUTO_CONFIRMATION : MANUAL_CONFIRMATION), 'AGENT_CONFIRMATION_REQUIRED');
      assertPolicyActive(d.policy, this.wallet.network(d.policy.chainId), this.now());
      this.initState(); need(this.policies().length < 32, 'AGENT_POLICY_LIMIT');
      need(this.vault.data.backupVersion === this.vault.data.accountsVersion, 'BACKUP_VERIFICATION_REQUIRED');
      const token = randomBytes(32).toString('hex'), p = clone(d.policy);
      p.tokenHash = tokenHash(token); this.vault.data.agentPolicies.push(p);
      this.vault.save(); this.drafts.delete(draftId);
      this.capabilities.set(p.tokenHash, {id: p.id, epoch: this.vault.epoch});
      return {token, policy: publicPolicy(p, this.claims(), this.now(), true), tokenShownOnce: true};
    });
  }
  async activate(id, confirmation) {
    // Rotation immediately invalidates the previous authority, even during an asynchronous recheck.
    this.deactivate(id);
    return this.vault.serial(async () => {
      this.vault.touch(); const p = this.policy(id);
      need(confirmation === (p.mode === 'auto' ? AUTO_CONFIRMATION : MANUAL_CONFIRMATION), 'AGENT_CONFIRMATION_REQUIRED');
      assertPolicyActive(p, this.wallet.network(p.chainId), this.now());
      need(this.vault.data.backupVersion === this.vault.data.accountsVersion, 'BACKUP_VERIFICATION_REQUIRED');
      const token = randomBytes(32).toString('hex'); p.tokenHash = tokenHash(token); p.lastSeenAt = this.now();
      this.vault.save(); this.capabilities.set(p.tokenHash, {id: p.id, epoch: this.vault.epoch});
      return {token, policy: publicPolicy(p, this.claims(), this.now(), true), tokenShownOnce: true};
    });
  }
  async revoke(id) {
    this.deactivate(id);
    return this.vault.serial(async () => {
      this.vault.touch(); const p = this.policy(id); p.status = 'revoked'; p.tokenHash = null;
      this.vault.save(); return {revoked: true};
    });
  }
  async stopAll() {
    this.invalidate();
    return this.vault.serial(async () => {
      this.vault.touch(); for (const p of this.policies()) p.tokenHash = null;
      this.vault.save(); return {stopped: true, alreadyBroadcastTransactionsCancelled: false};
    });
  }
  requestView(r) {
    const record = r.recordId ? this.vault.data.journal.find(j => j.id === r.recordId) : null;
    return {requestId: r.id, idempotencyKey: r.idempotencyKey, policyId: r.policyId, state: r.state,
      recipient: r.recipient, amountAtomic: r.amountAtomic, note: r.note, createdAt: r.createdAt,
      expiresAt: r.expiresAt, feeReservedWei: r.feeReservedWei, transactionHash: record?.signed.transactionHash ?? null,
      broadcastState: record?.state ?? null, error: r.error, automaticRetry: false,
      receiptObservation: record?.report?.transactionReportedSuccessful === undefined ? null : clone(record.report),
      warning: 'A signed or uncertain payment remains charged. Do not use a new key to retry it.'};
  }
  async releaseUnsigned(id, error, {cancelled = false} = {}) {
    return this.vault.serial(async () => {
      this.vault.check(); const r = this.claim(id);
      if (r.state === 'signed') return this.requestView(r);
      need(!this.vault.data.journal.some(j => j.agent?.requestId === id), 'AGENT_SIGNATURE_ALREADY_EXISTS');
      if (['reserved', 'awaiting-approval'].includes(r.state)) {
        r.state = cancelled ? 'cancelled' : 'failed-before-sign'; r.error = error; this.vault.save();
      }
      return this.requestView(r);
    });
  }
  async cancel(id) {
    // Recheck inside the serialized operation; never release a signed transaction's budget.
    this.vault.touch(); const r = this.claim(id); need(r.state !== 'signed', 'SIGNED_PAYMENT_CANNOT_BE_CANCELLED');
    for (const pending of this.wallet.requests.values()) if (pending.agentRequestId === id && pending.state === 'pending') {
      pending.state = 'rejected'; pending.error = 'USER_REJECTED';
    }
    return this.releaseUnsigned(id, 'USER_REJECTED', {cancelled: true});
  }
  async reserve(rawToken, input) {
    return this.vault.serial(async () => {
      const p = this.authorize(rawToken); this.initState();
      const digest = hashObject(input), old = this.claims().find(r => r.policyId === p.id && r.idempotencyKey === input.idempotencyKey);
      if (old) { need(old.requestHash === digest, 'AGENT_IDEMPOTENCY_CONFLICT'); return {fresh: false, request: this.requestView(old)}; }
      need(this.claims().length < 512, 'AGENT_REQUEST_STORAGE_LIMIT');
      assertCanReserve(p, this.claims(), input, this.now());
      need(this.vault.data.backupVersion === this.vault.data.accountsVersion, 'BACKUP_VERIFICATION_REQUIRED');
      const now = this.now();
      const r = {id: randomUUID(), policyId: p.id, ...input, requestHash: digest, createdAt: now, reservedAt: now,
        expiresAt: Math.min(now + 90000, p.expiresAt), signedAt: null, state: 'reserved',
        feeReservedWei: p.limits.perTxFeeWei, intentId: null, recordId: null, error: null};
      this.vault.data.agentRequests.push(r); p.lastSeenAt = now;
      this.vault.save(); return {fresh: true, id: r.id};
    });
  }
  async transfer(rawToken, raw) {
    const input = normalizeAgentTransfer(raw), result = await this.reserve(rawToken, input);
    if (!result.fresh) return result.request;
    const requestId = result.id;
    try {
      need(this.inflight.size < 4, 'AGENT_PREPARATION_BUSY'); this.inflight.add(requestId);
      const p = this.authorize(rawToken), account = this.vault.account(p.accountId), network = this.wallet.network(p.chainId);
      const {transaction} = transferRequest(network, account, {asset: p.asset, recipient: input.recipient, amountAtomic: input.amountAtomic}, {atomic: true});
      const intent = await this.wallet.engine.prepare(network, account, transaction, {origin: `agent:${p.id}`});
      await this.vault.serial(async () => {
        const current = this.authorize(rawToken), r = this.claim(requestId);
        need(r.state === 'reserved', 'AGENT_REQUEST_CANCELLED');
        const next = {...r, intentId: intent.id, state: 'awaiting-approval'};
        assertTransferIntent(current, next, intent, this.now());
        Object.assign(r, next); current.lastSeenAt = this.now(); this.vault.save();
      });
      if (p.mode === 'manual') {
        this.wallet.addRequest({kind: 'transaction', origin: `agent:${p.id}`, intent, expiresAt: Math.min(intent.expiresAt, this.claim(requestId).expiresAt),
          sessionToken: null, agentRequestId: requestId, agentTokenHash: tokenHash(rawToken)});
        return this.requestView(this.claim(requestId));
      }
      need(!this.wallet.activeApproval, 'APPROVAL_BUSY'); this.wallet.activeApproval = true;
      try { return await this.execute(requestId, intent, tokenHash(rawToken)); }
      finally { this.wallet.activeApproval = false; }
    } catch (e) {
      const code = safeError(e);
      try { return await this.releaseUnsigned(requestId, code); }
      catch { throw Error('AGENT_RESULT_UNCERTAIN_CHECK_AFTER_UNLOCK'); }
    } finally { this.inflight.delete(requestId); }
  }
  authorizeHash(digest, requestId, intent, {signed = false} = {}) {
    this.vault.check(); const cap = this.capabilities.get(digest);
    need(cap && cap.epoch === this.vault.epoch, 'AGENT_REACTIVATION_REQUIRED');
    const p = this.policy(cap.id), r = this.claim(requestId);
    need(p.tokenHash === digest && r.policyId === p.id, 'AGENT_UNAUTHORIZED');
    assertPolicyActive(p, this.wallet.network(p.chainId), this.now());
    if (!signed) assertTransferIntent(p, r, intent, this.now());
    else { need(r.state === 'signed' && r.intentId === intent.id, 'AGENT_JOURNAL_BINDING_INVALID'); need(this.now() < r.expiresAt && this.now() < intent.expiresAt, 'AGENT_REQUEST_EXPIRED'); }
    return {policy: p, claim: r};
  }
  async execute(requestId, intent, digest, {requestGuard = () => {}} = {}) {
    const authorization = () => { requestGuard(); return this.authorizeHash(digest, requestId, intent); };
    authorization();
    const network = this.wallet.network(intent.networkId);
    const record = await this.wallet.engine.sign(this.vault, network, intent, {
      authorize: authorization, userActivity: false,
      commit: (data, record) => {
        // Signature, nonce reservation, and consumed budget are written in ONE encrypted atomic save.
        const r = data.agentRequests.find(r => r.id === requestId);
        const p = data.agentPolicies.find(p => p.id === r?.policyId);
        need(p && r, 'AGENT_JOURNAL_BINDING_INVALID');
        assertTransferIntent(p, r, intent, this.now());
        record.agent = {policyId: p.id, requestId};
        r.recordId = record.id; r.state = 'signed'; r.signedAt = this.now(); r.feeReservedWei = intent.summary.executionFeeCapWei;
        p.lastSeenAt = this.now();
        validateAgentData(data);
      },
    });
    try {
      const authorizeSend = () => { requestGuard(); this.authorizeHash(digest, requestId, intent, {signed: true}); };
      await this.wallet.engine.broadcast(this.vault, network, record, {authorize: authorizeSend});
    } catch (e) {
      // Never turn a post-sign failure into an unsigned/refunded request.
      if (this.vault.status().locked) throw Error('AGENT_RESULT_UNCERTAIN_CHECK_AFTER_UNLOCK');
      await this.vault.serial(async () => { this.claim(requestId).error = safeError(e); this.vault.save(); });
    }
    return this.requestView(this.claim(requestId));
  }
  /** A bounded, read-only preview: no reservation, approval request, signature or send. */
  async preview(rawToken, raw) {
    const input=normalizeAgentTransfer(raw), policy=this.authorize(rawToken);
    const old=this.claims().find(r=>r.policyId===policy.id&&r.idempotencyKey===input.idempotencyKey);
    if(old){need(old.requestHash===hashObject(input),'AGENT_IDEMPOTENCY_CONFLICT');return {alreadyRequested:true,result:this.requestView(old),reservationCreated:false,automaticRetry:false};}
    assertCanReserve(policy,this.claims(),input,this.now());
    need(this.inflight.size<4,'AGENT_PREPARATION_BUSY');const marker='preview:'+randomUUID();this.inflight.add(marker);
    try {
      const network=this.wallet.network(policy.chainId), account=this.vault.account(policy.accountId);
      const {transaction}=transferRequest(network,account,{asset:policy.asset,recipient:input.recipient,amountAtomic:input.amountAtomic},{atomic:true});
      const intent=await this.wallet.engine.prepare(network,account,transaction,{origin:`agent:${policy.id}`});
      const current=this.authorize(rawToken);
      const raced=this.claims().find(r=>r.policyId===current.id&&r.idempotencyKey===input.idempotencyKey);
      if(raced){need(raced.requestHash===hashObject(input),'AGENT_IDEMPOTENCY_CONFLICT');return {alreadyRequested:true,result:this.requestView(raced),reservationCreated:false,automaticRetry:false};}
      assertCanReserve(current,this.claims(),input,this.now());
      assertTransferIntent(current,{...input,policyId:current.id,state:'awaiting-approval',expiresAt:Math.min(intent.expiresAt,current.expiresAt),intentId:intent.id,feeReservedWei:current.limits.perTxFeeWei},intent,this.now());
      return {alreadyRequested:false,canRequest:true,idempotencyKey:input.idempotencyKey,policyId:current.id,
        account:account.address,chainId:current.chainId,asset:current.asset,recipient:input.recipient,amountAtomic:input.amountAtomic,
        executionFeeCapWei:intent.summary.executionFeeCapWei,totalNativeDebitCapWei:intent.summary.totalNativeDebitCapWei,
        blockHash:intent.summary.blockHash,expiresAt:Math.min(intent.expiresAt,current.expiresAt),mode:current.mode,
        usage:publicPolicy(current,this.claims(),this.now(),true).usage,reservationCreated:false,signatureCreated:false,
        automaticRetry:false,warning:'Preview only. Balances, fees and budgets are rechecked when requested and immediately before signing. No quote or budget is reserved.'};
    } finally {this.inflight.delete(marker);}
  }
  async api(route, body, rawToken) {
    const policy = this.authorize(rawToken); this.rateLimit(policy);
    if (route === 'status') { shape(body, []); return {policy: publicPolicy(policy, this.claims(), this.now(), true),
      account: this.vault.publicAccounts().find(a => a.id === policy.accountId),
      walletAutoLocksAt: this.vault.expiresAt, supportedActions: ['balance', 'preview', 'transfer', 'result', 'history'],
      rawSigning: false, privateKeyExport: false, swaps: false, bridges: false}; }
    if (route === 'balance') {
      shape(body, []); need(this.inflight.size < 4, 'AGENT_PREPARATION_BUSY');
      const id = randomUUID(); this.inflight.add(id);
      try {
        const balance = await readTransferBalance(this.wallet.engine, this.wallet.network(policy.chainId), this.vault.account(policy.accountId), policy.asset);
        this.authorize(rawToken); return balance;
      } finally { this.inflight.delete(id); }
    }
    if (route === 'preview') return this.preview(rawToken, body);
    if (route === 'transfer') return this.transfer(rawToken, body);
    if (route === 'result') {
      shape(body, ['idempotencyKey'], ['refresh']);
      need(body.refresh === undefined || typeof body.refresh === 'boolean', 'AGENT_REFRESH_INVALID');
      need(typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(body.idempotencyKey), 'AGENT_IDEMPOTENCY_KEY_INVALID');
      const r = this.claims().find(r => r.policyId === policy.id && r.idempotencyKey === body.idempotencyKey);
      if (!r) return {state: 'not-found', idempotencyKey: body.idempotencyKey, automaticRetry: false};
      let observation = null;
      if (body.refresh && r.recordId) {
        const record = this.vault.data.journal.find(j => j.id === r.recordId);
        if (record) {
          const key = 'receipt:' + record.id;
          need(this.inflight.size < 4 && !this.inflight.has(key), 'AGENT_PREPARATION_BUSY'); this.inflight.add(key);
          try {
            const result = await this.wallet.engine.reconcile(this.vault, this.wallet.network(policy.chainId), record);
            observation = result.observation ?? null;
            this.authorize(rawToken); // A revoked/locked client must not obtain a late response.
          } finally { this.inflight.delete(key); }
        }
      }
      return {...this.requestView(this.claim(r.id)), reconciliationObservation: observation};
    }
    if (route === 'history') { shape(body, []); return {requests: this.claims().filter(r => r.policyId === policy.id).map(r => this.requestView(r))}; }
    throw Error('AGENT_METHOD_DENIED');
  }
}
