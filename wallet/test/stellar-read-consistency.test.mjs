/**
 * The Stellar engine's read-consistency vocabulary.
 *
 * Three separate places used to report "your head is a moment stale" as something else,
 * and nothing here said they should not. Each of these fixes was made against a real
 * runtime failure; these are what stop them being undone silently.
 *
 *  - agree() reported readers being at different points in time as
 *    ACCOUNT_RPC_DISAGREEMENT, the same code it uses when two readers contradict each
 *    other about a fixed fact. An alarm that fires for the ordinary case is not an alarm.
 *  - int(v.last_modified_ledger, head.height) and int(v.ledger, head.height) used the
 *    head as an integer bound to express a domain rule, so a ledger closing mid-read
 *    surfaced as ACCOUNT_RPC_INTEGER_RANGE — a name that points at neither the field nor
 *    the cause, and that nothing recognises as read-it-again.
 *
 * The tests assert both halves: the right code, and never the misleading one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOnlineFixture} from './account-online-fixtures.mjs';

async function setup(t) { const f = await accountOnlineFixture('stellar'); t.after(() => f.close()); return f; }
const rejection = async promise => { try { await promise; return null; } catch (error) { return error.message; } };

test('stellar: an account modified after the head reads as a moved ledger, not an out-of-range integer', async t => {
  const f = await setup(t);
  // Real Horizon reports the ledger an account was last changed in. Claiming a later one
  // than the head is exactly what a ledger closing between the two reads looks like.
  f.state.mutate = (v, c) => { if (c.path.startsWith('/accounts/')) v.last_modified_ledger = f.state.height + 1; return v; };
  const message = await rejection(f.prepare());
  assert.equal(message, 'STELLAR_LEDGER_CHANGED');
  assert.equal(f.state.sent, 0);
});

test('stellar: a receipt from a ledger after the head reads as a moved ledger, not an out-of-range integer', async t => {
  const f = await setup(t);
  const {record} = await f.approve(await f.prepare(), true);
  assert.equal(record.state, 'broadcast');
  // Reconciling straight after a submit asks about a transaction that is landing right
  // now, so the recorded ledger genuinely can be ahead of the head just read.
  f.state.mutate = (v, c) => { if (c.path.startsWith('/transactions/') && !c.path.endsWith('/operations')) v.ledger = f.state.height + 5; return v; };
  // Reconciling never throws the read away: it records what it could not establish, so
  // the code arrives as the report's reason rather than as a rejection.
  const result = await f.reconcile(record);
  assert.equal(result.state, 'broadcast-unknown');
  assert.equal(result.report.reason, 'STELLAR_LEDGER_CHANGED');
  assert.equal(result.report.received, false);
  assert.equal(f.state.sent, 1, 'a failed reconcile must never send anything');
});

test('stellar: readers at different points in time are time skew, not a disagreement', async t => {
  const f = await setup(t);
  // The root resource carries the moving head. One reader a ledger ahead of the other is
  // two honest readers a fraction of a second apart, not a reader contradicting another.
  // Both heights move together: a Horizon whose history ran ahead of its own core would
  // be a different complaint, STELLAR_HORIZON_LAG, raised before the readers are compared.
  f.state.mutate = (v, c) => {
    if (c.path === '/' && c.peer === 1) { v.history_latest_ledger = f.state.height + 1; v.core_latest_ledger = f.state.height + 1; }
    return v;
  };
  const message = await rejection(f.prepare());
  assert.equal(message, 'ACCOUNT_RPC_TIME_SKEW');
  assert.notEqual(message, 'ACCOUNT_RPC_DISAGREEMENT');
});

test('stellar: readers contradicting each other about a fixed height stay a disagreement', async t => {
  const f = await setup(t);
  // A ledger at a given height is immutable. Two readers returning different content for
  // one is an integrity failure, and must not be softened into skew or read again.
  f.state.mutate = (v, c) => { if (/^\/ledgers\/\d+$/.test(c.path) && c.peer === 1) v.base_fee_in_stroops = 200; return v; };
  const message = await rejection(f.prepare());
  assert.equal(message, 'ACCOUNT_RPC_DISAGREEMENT');
  assert.equal(f.state.sent, 0);
});

test('stellar: a ledger that closes once mid-read is read again rather than refused', async t => {
  const f = await setup(t);
  // Fail the first attempt the way a real close does, then stop. The engine retries the
  // whole read-only cycle from a fresh snapshot, so the operation completes — which is
  // the difference between "read it again" being a signal and being a dead end.
  let accountReads = 0;
  f.state.mutate = (v, c) => {
    if (c.path.startsWith('/accounts/')) { accountReads += 1; if (accountReads <= 2) v.last_modified_ledger = f.state.height + 1; }
    return v;
  };
  const prepared = await f.prepare();
  assert.ok(prepared?.id, 'the retry must let the prepare through');
  assert.ok(accountReads > 2, 'the first attempt must actually have been rejected');
  assert.equal(f.state.sent, 0, 'reading again must not send anything');
});

// --- what stable() does and does not require ---
//
// It used to demand that no ledger closed at all during a read. That is stricter than the
// property it protects: what makes a view wrong is figures spanning two states, and the
// double read of both accounts plus modified <= head.height already catch that. These
// four say what replaced it, because a check that was relaxed with nothing asserting the
// new boundary is a check that will be relaxed again by accident.

test('stellar: a ledger closing without touching the accounts no longer refuses the view', async t => {
  const f = await setup(t);
  const start = f.state.height;
  let roots = 0;
  f.state.mutate = (v, c) => {
    // Let the head move on after the first snapshot, the way a close does.
    if (c.path === '/') { roots += 1; if (roots > 2) { v.history_latest_ledger = start + 3; v.core_latest_ledger = start + 3; } }
    // The accounts are untouched by it, which is the case being asserted: real Horizon
    // only advances last_modified_ledger for an account that actually changed.
    if (c.path.startsWith('/accounts/')) v.last_modified_ledger = start;
    return v;
  };
  const balance = await f.call('non-evm/account-online/balance', {accountId: f.account.id, networkId: f.network.id});
  assert.equal(balance.account.balanceAtomic, '10000000000');
  // The figures still name the ledger they were true at, rather than the newer one.
  assert.equal(balance.head.height, start);
  assert.equal(f.state.sent, 0);
});

test('stellar: an account that will not read the same twice is still refused', async t => {
  const f = await setup(t);
  // The check stable() no longer duplicates: each account is read twice within an
  // attempt and both readings must be identical. Relaxing stable() only holds because
  // this one does the work, so it has to keep failing when the figures will not settle.
  // Here the balance moves on every read, so no attempt ever sees a steady pair.
  // Per read, not per response: both readers answer the same question identically, or the
  // disagreement would be reported as time skew before the double read is reached.
  let responses = 0;
  f.state.mutate = (v, c) => {
    if (c.path === '/accounts/' + f.account.address) {
      const balance = 10000000000n - BigInt(Math.floor(responses / 2));
      responses += 1;
      const native = v.balances.find(b => b.asset_type === 'native');
      native.balance = (balance / 10000000n).toString() + '.' + String(balance % 10000000n).padStart(7, '0');
    }
    return v;
  };
  const message = await rejection(f.prepare());
  assert.equal(message, 'STELLAR_ACCOUNT_CHANGED');
  assert.equal(f.state.sent, 0);
});

test('stellar: the same height reading as a different ledger is an integrity failure', async t => {
  const f = await setup(t);
  const start = f.state.height;
  // The head does not move. What changes is what the ledger at that height says it is,
  // between the snapshot the figures were read against and the one that confirms it.
  // Both readers agree on the new answer, so this is not two endpoints differing — it is
  // one height with two contents, which cannot honestly happen.
  //
  // Fatal, and deliberately not STELLAR_LEDGER_CHANGED. That name is in the read-again
  // set, and with it a second attempt found both endpoints agreeing on the new answer and
  // accepted it — the alarm softened into nothing. The negative control for these tests
  // is what caught that, by removing the comparison and finding nothing complained.
  let heads = 0;
  f.state.mutate = (v, c) => {
    if (c.path === '/ledgers/' + start) { heads += 1; if (heads > 2) v.hash = 'f'.repeat(64); }
    return v;
  };
  const message = await rejection(f.call('non-evm/account-online/balance', {accountId: f.account.id, networkId: f.network.id}));
  assert.equal(message, 'STELLAR_LEDGER_CONTENT_CHANGED');
  assert.equal(f.state.sent, 0);
});

test('stellar: a head that goes backwards is fatal, and is not read again', async t => {
  const f = await setup(t);
  const start = f.state.height;
  let roots = 0;
  f.state.mutate = (v, c) => {
    if (c.path === '/') { roots += 1; if (roots > 2) { v.history_latest_ledger = start - 1; v.core_latest_ledger = start - 1; } }
    if (c.path.startsWith('/accounts/')) v.last_modified_ledger = start - 1;
    return v;
  };
  const message = await rejection(f.call('non-evm/account-online/balance', {accountId: f.account.id, networkId: f.network.id}));
  assert.equal(message, 'STELLAR_LEDGER_REWOUND');
  assert.equal(f.state.sent, 0);
});

test('stellar: the fee and reserve priced against must still be current', async t => {
  const f = await setup(t);
  const start = f.state.height;
  let roots = 0;
  f.state.mutate = (v, c) => {
    if (c.path === '/') { roots += 1; if (roots > 2) { v.history_latest_ledger = start + 1; v.core_latest_ledger = start + 1; } }
    // A protocol change to the reserve during the read. The owner was shown figures
    // priced against the old one, so this surfaces rather than being re-priced quietly.
    if (roots > 2 && /^\/ledgers\/\d+$/.test(c.path)) v.base_reserve_in_stroops = 6000000;
    if (c.path.startsWith('/accounts/')) v.last_modified_ledger = start;
    return v;
  };
  const message = await rejection(f.call('non-evm/account-online/balance', {accountId: f.account.id, networkId: f.network.id}));
  assert.equal(message, 'STELLAR_LEDGER_PARAMETERS_CHANGED');
  assert.equal(f.state.sent, 0);
});

test('stellar: reading again is bounded, and gives up with the same answer', async t => {
  const f = await setup(t);
  let attempts = 0;
  f.state.mutate = (v, c) => {
    if (c.path === '' || c.path === '/') attempts += 1;
    if (c.path.startsWith('/accounts/')) v.last_modified_ledger = f.state.height + 1;
    return v;
  };
  const message = await rejection(f.prepare());
  assert.equal(message, 'STELLAR_LEDGER_CHANGED');
  // Four attempts, each snapshotting twice: once to read the head and once in stable().
  // The point is that it stops — a wallet that reads for ever is not better than one
  // that refuses — and that giving up says exactly what one attempt said.
  assert.ok(attempts > 2 && attempts <= 16, 'expected a bounded number of attempts, got ' + attempts);
  assert.equal(f.state.sent, 0);
});
