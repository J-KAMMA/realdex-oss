import test from 'node:test';
import assert from 'node:assert/strict';
import {accountOnlineFixture} from './account-online-fixtures.mjs';
import {
  compareAccountProgress, highestSignedSequence,
  VAULT_BACKUP_POLICY, VAULT_CONTINUITY_ACKNOWLEDGEMENT,
} from '../lib/vault-continuity.mjs';

const rejects = (fn, code) => assert.throws(fn, error => error.message === code, 'expected ' + code);

// The rule both engines share, on its own. Everything below drives it through them.
test('The three answers, and the one with no way past it', () => {
  assert.deepEqual(compareAccountProgress('7', '7'), {status: 'accounted-for', maySign: true, unaccountedFor: '0'});
  assert.deepEqual(compareAccountProgress('7', '12'), {status: 'unaccounted-activity', maySign: false, unaccountedFor: '5', reason: 'VAULT_CONTINUITY_UNACCOUNTED_ACTIVITY'});
  assert.deepEqual(compareAccountProgress('12', '7'), {status: 'impossible-rewind', maySign: false, unaccountedFor: '0', reason: 'VAULT_CONTINUITY_CHAIN_BEHIND_RECORD'});
  rejects(() => compareAccountProgress(7, '7'), 'VAULT_CONTINUITY_FLOOR_INVALID');
  rejects(() => compareAccountProgress('007', '7'), 'VAULT_CONTINUITY_FLOOR_INVALID');
  rejects(() => compareAccountProgress('7', '-1'), 'VAULT_CONTINUITY_OBSERVATION_INVALID');
});

test('The floor counts only this account on this network', () => {
  // A floor raised by somebody else's records is a floor that hides a real gap: the
  // account would look further along than this copy can actually account for. The
  // negative control found that breaking the filter changed nothing, so this says it.
  const mine = {family: 'stellar', summary: {networkId: 'stellar:standalone', from: 'G-me', transfer: {sequence: '7'}}};
  const otherAccount = {family: 'stellar', summary: {networkId: 'stellar:standalone', from: 'G-someone-else', transfer: {sequence: '99'}}};
  const otherNetwork = {family: 'stellar', summary: {networkId: 'stellar:other', from: 'G-me', transfer: {sequence: '98'}}};
  const otherFamily = {family: 'aptos', summary: {networkId: 'stellar:standalone', from: 'G-me', transfer: {sequence: '97'}}};
  const selector = {family: 'stellar', networkId: 'stellar:standalone', from: 'G-me'};
  assert.equal(highestSignedSequence([mine, otherAccount, otherNetwork, otherFamily], selector), 7n);
  assert.equal(highestSignedSequence([otherAccount, otherNetwork, otherFamily], selector), null);
  assert.equal(highestSignedSequence([], selector), null);
  rejects(() => highestSignedSequence(null, selector), 'VAULT_CONTINUITY_RECORDS_INVALID');
  rejects(() => highestSignedSequence([], {family: 'stellar', networkId: 'x'}), 'VAULT_CONTINUITY_SELECTOR_INVALID');
});

test('Sequences past what a double can count are compared exactly', () => {
  // These two are one apart and indistinguishable once either is a JavaScript number, so
  // a comparison done on numbers would call a genuine gap accounted for.
  assert.equal(Number('9007199254740992') === Number('9007199254740993'), true);
  const progress = compareAccountProgress('9007199254740992', '9007199254740993');
  assert.equal(progress.status, 'unaccounted-activity');
  assert.equal(progress.unaccountedFor, '1');
  // And the floor is read back at full width rather than through a number.
  const record = s => ({family: 'stellar', summary: {networkId: 'n', from: 'a', transfer: {sequence: s}}});
  assert.equal(highestSignedSequence([record('9007199254740992'), record('9007199254740993')], {family: 'stellar', networkId: 'n', from: 'a'}), 9007199254740993n);
});

test('The backup policy says the thing that is easy to get wrong', () => {
  assert.equal(VAULT_BACKUP_POLICY.acknowledgement, VAULT_CONTINUITY_ACKNOWLEDGEMENT);
  const text = VAULT_BACKUP_POLICY.rules.join(' ');
  assert.match(text, /a restored backup and a second live copy are the same thing/i);
  assert.match(text, /Do not run two copies/);
  assert.match(text, /cannot tell a copy from you using a different tool/);
  assert.equal(Object.isFrozen(VAULT_BACKUP_POLICY.rules), true);
});

// --- the engine actually asking, before it signs ---

test('stellar: signing on top of a history this copy cannot account for is refused', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());

  // One payment this copy made and saw land. That is the floor, taken from the records
  // rather than from a new place to keep one.
  const first = await f.approve(await f.prepare(), true);
  const reconciled = await f.reconcile(first.record);
  assert.equal(reconciled.state, 'reported-confirmed');
  assert.equal(f.state.sent, 1);

  // Something else moves the account: two sequences appear that this copy never signed.
  // From here that is a restored backup, a second copy, or another tool, and the wallet
  // is not told which — only that it cannot account for them.
  f.state.sequence = String(BigInt(f.state.sequence) + 2n);

  const prepared = await f.prepare({requestKey: 'after-the-gap'});
  await assert.rejects(f.approve(prepared, true), /ACCOUNT_UNACCOUNTED_ACTIVITY/);
  assert.equal(f.state.sent, 1, 'nothing may be sent while the gap stands');
});

test('stellar: the owner can accept a gap by naming it, and only by naming it', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  const first = await f.approve(await f.prepare(), true);
  await f.reconcile(first.record);
  const signedSequence = first.record.summary.transfer.sequence;

  f.state.sequence = String(BigInt(f.state.sequence) + 2n);
  const chain = f.state.sequence;
  const ack = 'I have accounted for the activity this copy did not record';
  const approve = (acknowledgeGap, key) => f.prepare({requestKey: key})
    .then(p => f.call('non-evm/approve', {id: p.id, intentId: p.intentId, confirmation: f.to, broadcast: true, acknowledgeGap}));

  // A flag is not an acknowledgement, and neither is the right words about the wrong gap.
  await assert.rejects(approve({fromSequence: signedSequence, toSequence: chain, acknowledgement: true}, 'a'), /ACCOUNT_GAP_ACKNOWLEDGEMENT_REQUIRED/);
  await assert.rejects(approve({fromSequence: signedSequence, toSequence: '999', acknowledgement: ack}, 'b'), /ACCOUNT_GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH/);
  await assert.rejects(approve('yes', 'c'), /ACCOUNT_GAP_ACKNOWLEDGEMENT_INVALID/);
  assert.equal(f.state.sent, 1, 'none of those may send anything');

  // Naming the exact range, in the exact words, does let it through — because a refusal
  // with no way past it would be worse than the thing it prevents.
  const approved = await approve({fromSequence: signedSequence, toSequence: chain, acknowledgement: ack}, 'd');
  assert.equal(approved.record.state, 'broadcast');
  assert.equal(f.state.sent, 2);
});

test('stellar: a gap acknowledgement cannot be carried along by every approval', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  // Sent when there is no gap, it is simply never consulted: it cannot pre-authorise a
  // gap that has not happened yet, because the range it names would not match one.
  const prepared = await f.prepare();
  const approved = await f.call('non-evm/approve', {
    id: prepared.id, intentId: prepared.intentId, confirmation: f.to, broadcast: true,
    acknowledgeGap: {fromSequence: '1', toSequence: '999', acknowledgement: 'I have accounted for the activity this copy did not record'},
  });
  assert.equal(approved.record.state, 'broadcast');
  assert.equal(f.state.sent, 1);
});

test('stellar: ordinary payments in a row are not mistaken for someone else', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  // Three, not two. With one record on file the first and the highest sequence are the
  // same, so a floor taken from the wrong one still looks right; by the third payment
  // they differ, and taking the first would report a gap that is not there. The negative
  // control found that with two payments nothing noticed.
  for (const key of ['first', 'second', 'third']) {
    const approved = await f.approve(await f.prepare({requestKey: key}), true);
    assert.equal(approved.record.state, 'broadcast', key);
    const reconciled = await f.reconcile(approved.record);
    assert.equal(reconciled.state, 'reported-confirmed', key);
  }
  assert.equal(f.state.sent, 3);
});

// --- asking about the gap without signing anything ---

test('stellar: continuity can be asked before anything has been signed', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  const result = await f.call('non-evm/account-online/continuity', {accountId: f.account.id, networkId: f.network.id});
  assert.equal(result.status, 'nothing-recorded');
  assert.equal(result.maySign, true);
  assert.equal(result.signedSequences, 0);
  assert.match(result.notice, /cannot notice history it is missing/);
  assert.equal(f.state.sent, 0, 'asking must never send anything');
});

test('stellar: continuity hands back the exact range the owner would be accepting', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  const first = await f.approve(await f.prepare(), true);
  await f.reconcile(first.record);
  const signedSequence = first.record.summary.transfer.sequence;
  f.state.sequence = String(BigInt(f.state.sequence) + 2n);

  const seen = await f.call('non-evm/account-online/continuity', {accountId: f.account.id, networkId: f.network.id});
  assert.equal(seen.status, 'unaccounted-activity');
  assert.equal(seen.maySign, false);
  assert.equal(seen.unaccountedFor, '2');
  assert.equal(seen.sequenceFloor, signedSequence);
  assert.equal(seen.signedSequences, 1);
  assert.match(seen.notice, /Nothing here can tell which/);
  // The backup rules travel with the answer. Rules that live only in a document are
  // rules the person looking at a gap does not have.
  assert.deepEqual(seen.policy, VAULT_BACKUP_POLICY);

  // Handed back whole, so the owner affirms a range they can see rather than composing
  // one out of a document — and it is exactly what the signing path will accept.
  const prepared = await f.prepare({requestKey: 'after-seeing-the-gap'});
  const approved = await f.call('non-evm/approve', {
    id: prepared.id, intentId: prepared.intentId, confirmation: f.to, broadcast: true, acknowledgeGap: seen.acknowledgeGap,
  });
  assert.equal(approved.record.state, 'broadcast');
});

test('stellar: a rewind is reported with no range to accept', async t => {
  const f = await accountOnlineFixture('stellar');
  t.after(() => f.close());
  const first = await f.approve(await f.prepare(), true);
  await f.reconcile(first.record);
  f.state.sequence = '1';
  const seen = await f.call('non-evm/account-online/continuity', {accountId: f.account.id, networkId: f.network.id});
  assert.equal(seen.status, 'impossible-rewind');
  assert.equal(seen.maySign, false);
  assert.equal(seen.acknowledgeGap, undefined, 'there must be nothing here to click past');
  assert.match(seen.notice, /no range to accept/);
});

const screenSource = () => import('node:fs/promises').then(fs => fs.readFile(new URL('../public/app.mjs', import.meta.url), 'utf8'));

test('The screen has words for every refusal this can produce', async () => {
  // A code with no sentence beside it reaches the owner as a code. These are the ones
  // this work can raise, and the catalogue in the wallet screen has to carry all of them.
  const source = await screenSource();
  for (const family of ['ACCOUNT', 'COSMOS']) for (const suffix of [
    'UNACCOUNTED_ACTIVITY', 'CONTINUITY_CHAIN_BEHIND_RECORD',
    'GAP_ACKNOWLEDGEMENT_REQUIRED', 'GAP_ACKNOWLEDGEMENT_DOES_NOT_MATCH', 'GAP_ACKNOWLEDGEMENT_INVALID',
  ]) {
    const code = family + '_' + suffix;
    assert.ok(new RegExp('^\\s*' + code + ':', 'm').test(source), code + ' has no sentence in the screen catalogue');
  }
});

test('The screen asks about the gap, and makes the owner type the sentence', async () => {
  const source = await screenSource();
  // Asked from the screen, or the owner has to compose the range themselves.
  assert.ok(source.includes("api('non-evm/account-online/continuity'"), 'the screen must ask the read-only continuity question');
  // Carried into the approval, or seeing it changes nothing.
  assert.ok(/\{\.\.\.gap,acknowledgement:gapSentence\.value\}/.test(source), 'the approval must carry the observed range together with what the owner typed');
  // Typed, not clicked. The value that goes to the server is the input's, so an empty box
  // cannot become an acknowledgement, and the stored sentence cannot be sent on its own.
  assert.ok(source.includes('gapSentence.value'), 'the acknowledgement must come from what was typed');
  assert.ok(/gap&&gapSentence\.value\?/.test(source), 'an untyped box must send no acknowledgement at all');
  // A rewind has no range to accept, so the screen must not offer one.
  assert.ok(/impossible-rewind'\)\{gap=null/.test(source), 'a rewind must clear any range the screen was holding');
  // And the rules reach the screen, not just the answer.
  assert.ok(source.includes('seen.policy?.rules'), 'the card must show the backup rules it was given');
});

test('Nothing is exported that the product does not call', async () => {
  // The record-based half of this module — a durable continuity record with a device id
  // and a floor advanced by hand — was replaced by deriving the floor from the payments
  // already recorded, and became code nothing reached. Tested code that nothing reaches
  // reads as a capability the product has. This says it stays gone.
  const module = await import('../lib/vault-continuity.mjs');
  assert.deepEqual(Object.keys(module).sort(), [
    'VAULT_BACKUP_POLICY', 'VAULT_CONTINUITY_ACKNOWLEDGEMENT', 'compareAccountProgress', 'highestSignedSequence',
  ]);
});

