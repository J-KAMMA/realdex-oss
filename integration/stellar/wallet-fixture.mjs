/**
 * Points the REAL wallet Stellar path at a REAL Stellar Core/Horizon container.
 *
 * Nothing here simulates a ledger. The only thing between the wallet and Horizon
 * is a loopback forwarder, and it exists for two honest reasons:
 *
 *   - validateAccountNetwork requires two to four distinct RPC URLs, and there is
 *     one Horizon. Two forwarders in front of it give two URLs. They are NOT
 *     independent consensus, exactly as the synthetic fixture already documents
 *     about its own two endpoints.
 *   - Response loss has to be produced somewhere. Dropping the reply in the
 *     forwarder means the transaction really reaches Horizon and really lands on
 *     the ledger, and only the answer is lost. Faking the submission instead
 *     would test nothing.
 *
 * Disposable keys only. Standalone network only; stellar-offline.mjs refuses to
 * sign for any other passphrase.
 */
import http from 'node:http';
import {Vault} from '../../wallet/lib/vault.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {storeFixture, PASSWORD} from '../../wallet/test/fixtures.mjs';
import {validateAccountNetwork} from '../../wallet/non-evm/account-network.mjs';
import {STELLAR_LOCAL_PASSPHRASE} from '../../wallet/non-evm/stellar-offline.mjs';
import {keyInfo} from '../../wallet/lib/keys.mjs';

const need = (value, code) => { if (!value) throw Error(code); };

/** Forwards to the real Horizon, optionally losing the reply to a submit. */
async function forwarder(horizonUrl, fault) {
  const server = http.createServer(async (req, res) => {
    const target = new URL(req.url, horizonUrl);
    let body = [];
    for await (const chunk of req) body.push(chunk);
    body = Buffer.concat(body);
    const isSubmit = req.method === 'POST' && target.pathname === '/transactions';
    const send = () => fetch(target, {
      method: req.method,
      headers: {'content-type': req.headers['content-type'] ?? 'application/x-www-form-urlencoded'},
      body: req.method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(60000),
    });
    let upstream, failure;
    // Reads get a few retries, with backoff, and 429 counts as one. Horizon rate-limits
    // per client, and this fixture is far chattier than a person: every consistency
    // recheck re-reads the head and the accounts through BOTH forwarders. Hitting that
    // limit surfaced as ACCOUNT_RPC_HTTP_ERROR and looked like a wallet fault when it
    // was only "slow down". Backing off is honest; a 429 is not evidence about the wallet.
    //
    // A submit is NEVER retried. That could double-send, which is the exact failure this
    // gate exists to detect.
    for (let attempt = 0; attempt < (isSubmit ? 1 : 5); attempt++) {
      try {
        upstream = await send();
        if (isSubmit || upstream.status !== 429) break;
      } catch (error) { failure = error; upstream = undefined; }
      await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
    if (!upstream) {
      fault.log.push({method: req.method, path: target.pathname, status: 502, forwarderFailure: String(failure?.message)});
      res.writeHead(502, {'content-type': 'application/json'});
      res.end(JSON.stringify({forwarderError: String(failure?.message)}));
      return;
    }
    fault.log.push({method: req.method, path: target.pathname, status: upstream.status});
    const text = await upstream.text();
    if (isSubmit) {
      fault.submitted.push({status: upstream.status, body: text});
      if (fault.dropSubmitResponse) {
        // The transaction has already reached Horizon and will land on the ledger.
        // Only the answer is lost, which is exactly what the wallet must survive.
        req.destroy();
        res.destroy();
        return;
      }
    }
    // Every response closes its connection. Dropping the submit destroys a socket, and
    // with keep-alive that socket could be reused for an unrelated read, which then
    // failed as ACCOUNT_RPC_HTTP_ERROR and made the fault look like a wallet defect.
    // One request per connection keeps the injected fault confined to the submit.
    res.writeHead(upstream.status, {'content-type': 'application/json', connection: 'close'});
    res.end(text);
  });
  server.keepAliveTimeout = 0;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

/**
 * Friendbot comes up after Horizon answers, so a 502 early on means "not yet",
 * not "broken". Retry it rather than failing the run on start-up ordering.
 */
export async function friendbot(friendbotUrl, address, {attempts = 40, wait = 3000} = {}) {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(friendbotUrl + '?addr=' + encodeURIComponent(address), {signal: AbortSignal.timeout(60000)});
      const text = await response.text();
      if (response.ok) return JSON.parse(text);
      last = response.status + ' ' + text.slice(0, 200);
      // A duplicate account is success for our purposes: it already exists.
      if (text.includes('op_already_exists') || text.includes('already funded')) return {existing: true};
    } catch (error) { last = String(error.message); }
    await new Promise(resolve => setTimeout(resolve, wait));
  }
  throw Error('STELLAR_FRIENDBOT_FAILED: ' + last);
}

/** Builds a wallet bound to the real container, with real Friendbot-funded accounts. */
export async function realStellarWalletFixture({horizonUrl, friendbotUrl, sourceSecretHex, recipientSecretHex} = {}) {
  need(typeof horizonUrl === 'string' && horizonUrl.startsWith('http://127.0.0.1:'), 'STELLAR_HORIZON_URL_NOT_LOOPBACK');
  need(typeof friendbotUrl === 'string' && friendbotUrl.startsWith('http://127.0.0.1:'), 'STELLAR_FRIENDBOT_URL_NOT_LOOPBACK');

  // Horizon has only just started, so its first reads can still refuse a connection.
  // Retrying the fixture's own setup reads is harness robustness; it asserts nothing.
  const readJson = async (url, attempts = 20) => {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        const response = await fetch(url, {signal: AbortSignal.timeout(15000)});
        if (response.ok) return await response.json();
        last = Error('HTTP ' + response.status);
      } catch (error) { last = error; }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw last;
  };

  const root = await readJson(horizonUrl);
  need(root.network_passphrase === STELLAR_LOCAL_PASSPHRASE, 'STELLAR_NETWORK_PASSPHRASE_MISMATCH');
  need(Number.isSafeInteger(root.history_latest_ledger) && root.history_latest_ledger >= 1, 'STELLAR_HISTORY_LEDGER_INVALID');
  // Horizon starts ingesting at a checkpoint and does not backfill to ledger 1, so the
  // pinned checkpoint has to be the oldest ledger it actually serves, read from itself.
  const oldest = await readJson(new URL('ledgers?order=asc&limit=1', horizonUrl));
  const checkpointLedger = oldest?._embedded?.records?.[0];
  need(Number.isSafeInteger(checkpointLedger?.sequence) && typeof checkpointLedger?.hash === 'string',
    'STELLAR_CHECKPOINT_LEDGER_UNAVAILABLE');

  const fault = {dropSubmitResponse: false, submitted: [], log: []};
  const servers = [await forwarder(horizonUrl, fault), await forwarder(horizonUrl, fault)];
  const rpcUrls = servers.map(s => `http://127.0.0.1:${s.address().port}/`);
  // If construction throws after this point, the forwarders would keep the process
  // alive and the failure would look like a hang instead of the error it is.
  const closeServers = () => Promise.all(servers.map(s => new Promise(resolve => { s.close(resolve); s.closeAllConnections(); })));
  try {
    return await build();
  } catch (error) { await closeServers(); throw error; }

  async function build() {
  const store = storeFixture();
  const vault = new Vault(store.store, {now: () => Date.now()});
  await vault.create(PASSWORD);
  const account = await vault.addAccount({family: 'stellar', label: 'DISPOSABLE STELLAR TEST KEY', secretHex: sourceSecretHex});
  const to = keyInfo('stellar', Buffer.from(recipientSecretHex, 'hex')).address;
  // The vault refuses to sign until a backup has been taken and verified.
  const backup = await vault.backup();
  await vault.verifyBackup(backup.encrypted, PASSWORD);

  // Real accounts, created on the real ledger by the container's Friendbot.
  await friendbot(friendbotUrl, account.address);
  await friendbot(friendbotUrl, to);

  const network = validateAccountNetwork({
    family: 'stellar', id: 'stellar:standalone', name: 'REAL local Stellar Core',
    rpcUrls, checkpoint: {height: checkpointLedger.sequence, hash: checkpointLedger.hash},
    broadcastEnabled: true, maxTransferAtomic: '1000000000', maxFeeAtomic: '1000000',
    minConfirmations: 1, networkPassphrase: STELLAR_LOCAL_PASSPHRASE,
  });
  const app = new WalletServer({
    store: store.store, vault, now: () => Date.now(),
    settings: {schema: 'realdex.wallet-settings.v1', allowedAppOrigins: ['http://127.0.0.1:5173'], networks: [], accountNetworks: [network]},
  });
  const started = await app.start(0);
  const call = async (route, body = {}) => {
    const response = await fetch(started.origin + '/api/' + route, {
      method: 'POST',
      headers: {origin: started.origin, authorization: 'Bearer ' + app.uiToken, 'content-type': 'application/json'},
      body: JSON.stringify(body),
    });
    const parsed = await response.json();
    if (!response.ok) { const error = Error(parsed.error ?? 'REQUEST_FAILED'); error.body = parsed; throw error; }
    return parsed;
  };
  const close = async () => { await app.close(); await closeServers(); store.close(); };
  let requests = 0;
  return {
    fault, account, to, network, vault, app, started, call, close, horizonUrl,
    /**
     * Each prepare needs its own requestKey. Reusing one is idempotency, not a new
     * payment: the wallet answers {alreadyRecorded, submittedAgain} instead of an intent.
     *
     * This used to retry STELLAR_LEDGER_CHANGED twelve times. It no longer retries at
     * all: the engine reads again by itself now, and a harness that also retries would
     * mean this gate measures the harness rather than the wallet.
     */
    prepare: (extra = {}) =>
      call('non-evm/account-online/prepare', {
        accountId: account.id, networkId: network.id,
        payment: {requestKey: 'account-payment-' + (++requests), to, amountAtomic: '1000000', feeAtomic: '100', memo: '', ...extra},
      }),
    approve: (prepared, broadcast = true) =>
      call('non-evm/approve', {id: prepared.id, intentId: prepared.intentId, confirmation: to, broadcast}),
    /**
     * One payment: prepare, then approve and broadcast. Once.
     *
     * This used to retry the whole cycle ten times on STELLAR_LEDGER_CHANGED and
     * ACCOUNT_RPC_DISAGREEMENT, with an in-flight guard so a retry could never
     * double-send. Even so it only reached three passes in six, and the next step from
     * there was to widen the retry until it looked green — which is the one thing this
     * work must not do.
     *
     * The reading again now happens inside the engine, where it belongs and where a real
     * owner gets it too. So the harness does it once and reports what happened. If this
     * fails, the wallet failed; there is no harness left to hide behind.
     */
    pay: async (extra = {}) => {
      const prepared = await call('non-evm/account-online/prepare', {
        accountId: account.id, networkId: network.id,
        payment: {requestKey: 'account-payment-' + (++requests), to, amountAtomic: '1000000', feeAtomic: '100', memo: '', ...extra},
      });
      const approved = await call('non-evm/approve', {id: prepared.id, intentId: prepared.intentId, confirmation: to, broadcast: true});
      return [approved, approved.record].find(candidate => candidate?.signed?.requestId);
    },
    submit: (record) => call('non-evm/account-online/submit', {id: record.id, confirmation: record.signed.requestId}),
    /**
     * The read-again signals are the engine's business now, so this retries exactly one
     * thing: ACCOUNT_RPC_HTTP_ERROR, which here is Horizon answering 429. That is an
     * artifact of the fixture, not of the wallet — every consistency recheck is read
     * through both forwarders, so this makes far more requests per second than a person
     * ever would, and the container rate-limits it. Retrying a refusal to serve is not
     * retrying a refusal to agree.
     */
    reconcile: async (record) => {
      let last;
      for (let attempt = 0; attempt < 6; attempt++) {
        try { return await call('non-evm/account-online/reconcile', {id: record.id}); }
        catch (error) {
          if (error.message !== 'ACCOUNT_RPC_HTTP_ERROR') throw error;
          last = error;
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
        }
      }
      throw last;
    },
    records: () => vault.nonEvmRecords(),
    /** Payments as the REAL ledger reports them, not as the wallet believes. */
    ledgerPayments: async () => {
      const url = new URL(`accounts/${account.address}/payments`, horizonUrl);
      url.searchParams.set('limit', '200');
      const page = await fetch(url).then(r => r.json());
      return (page?._embedded?.records ?? []).filter(p => p.type === 'payment');
    },
  };
  }
}
