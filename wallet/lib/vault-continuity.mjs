/**
 * Whether this copy of the vault can account for everything the account has done.
 *
 * A vault is a file, and a file can be copied. Two copies both believe they hold the
 * account, both will sign, and neither sees the other. Restoring a backup produces the
 * same situation with one of the copies in the past. The existing checkpoint store
 * catches a vault rolled back while its own checkpoint was not; it cannot see anything
 * that happened on another machine, because that machine has its own checkpoint.
 *
 * There is no server here to hold a counter, and adding one would make a local tool into
 * a hosted one. But the account already has a counter that every copy can read and none
 * can rewind: its own sequence on the chain. If the chain is further along than the
 * transactions this copy recorded producing, something signed for this account that this
 * copy knows nothing about.
 *
 * What this does not know. It cannot say the other signer was a copy of this vault. The
 * same reading appears when the owner signs from a different tool entirely, which is not
 * a fault and may be exactly what they meant to do. So the callers report unaccounted-for
 * activity and refuse to name a cause.
 *
 * It also cannot see a copy that has not signed yet. Two copies are indistinguishable
 * until one of them moves. This detects the moment that stops being true; it does not
 * prevent the copy.
 *
 * Pure. No storage, no clock, no network. Which families this covers, and why bitcoin
 * needs none of it while the solana families are exposed, is in
 * the internal design notes (not published).
 *
 * There used to be more here: a durable continuity record with a device id, an
 * acknowledgement history and a floor that had to be advanced by hand. The engines ended
 * up deriving the floor from the payments they had already recorded, which needs no new
 * storage and cannot fall out of step with the records, so that half became code nobody
 * called. It is gone rather than kept: tested code that nothing reaches reads as a
 * capability the product has, and this one did not.
 */
import {need, uint} from './guard.mjs';

const U64 = (1n << 64n) - 1n;
const ACKNOWLEDGEMENT = 'I have accounted for the activity this copy did not record';

const sequence = (value, code) => { need(typeof value === 'string' && /^(?:0|[1-9][0-9]{0,19})$/.test(value), code); return uint(value, U64); };

/**
 * The highest sequence a copy of the vault signed for one account on one network, or
 * null when it has signed none.
 *
 * This is the continuity floor without a new place to keep one: the records are already
 * durable, and every one of them is a transaction this copy produced. Callers refuse
 * anything unfinalised before asking, so each of these sequences was consumed on the
 * chain rather than merely intended.
 *
 * Shared, because the account engine and the cosmos engine reach the same question and
 * two copies of this would be two chances to disagree about what counts as signed.
 */
export function highestSignedSequence(records, {family, networkId, from}) {
  need(Array.isArray(records), 'VAULT_CONTINUITY_RECORDS_INVALID');
  need(typeof family === 'string' && typeof networkId === 'string' && typeof from === 'string', 'VAULT_CONTINUITY_SELECTOR_INVALID');
  let highest = null;
  for (const record of records) {
    if (record?.family !== family || record?.summary?.networkId !== networkId || record?.summary?.from !== from) continue;
    const value = sequence(String(record.summary.transfer.sequence), 'VAULT_CONTINUITY_RECORD_SEQUENCE_INVALID');
    if (highest === null || value > highest) highest = value;
  }
  return highest;
}

/**
 * The comparison, with nothing else attached.
 *
 * One rule for both engines, so they cannot drift into disagreeing about what counts as
 * accounted for.
 */
export function compareAccountProgress(sequenceFloor, accountSequence) {
  const floor = sequence(sequenceFloor, 'VAULT_CONTINUITY_FLOOR_INVALID');
  const chain = sequence(accountSequence, 'VAULT_CONTINUITY_OBSERVATION_INVALID');
  // The account cannot go backwards. Either this is a different account or network than
  // the one this copy signed for, or an endpoint is serving an old state. Both are
  // reasons to stop rather than to catch up, and neither is fixed by signing — which is
  // why this one has no acknowledgement anywhere that leads past it.
  if (chain < floor) return {status: 'impossible-rewind', maySign: false, unaccountedFor: '0', reason: 'VAULT_CONTINUITY_CHAIN_BEHIND_RECORD'};
  if (chain === floor) return {status: 'accounted-for', maySign: true, unaccountedFor: '0'};
  return {status: 'unaccounted-activity', maySign: false, unaccountedFor: (chain - floor).toString(), reason: 'VAULT_CONTINUITY_UNACCOUNTED_ACTIVITY'};
}

/**
 * What a restored backup looks like, said once so it is not rediscovered each time.
 *
 * From the file alone a restored backup and a second live copy are the same thing: both
 * are a vault whose record stops earlier than the account did. This is why the check is
 * against the chain and not against anything on disk, and why a backup is safe to keep
 * but never safe to use in parallel.
 *
 * Served by the continuity route so the screen can show it where it is needed, rather
 * than sitting here as text nobody meets.
 */
export const VAULT_BACKUP_POLICY = Object.freeze({
  schema: 'realdex.vault-backup-policy.v1',
  acknowledgement: ACKNOWLEDGEMENT,
  rules: Object.freeze([
    'Keep backups. Losing the vault loses the account, and no one here can recover it.',
    'Restore a backup only when the copy it replaces is gone for good. A restored backup and a second live copy are the same thing to everything except the person who made them.',
    'After restoring, expect unaccounted-for activity and establish what it was before signing. The gap is the transactions the backup was taken before.',
    'Do not run two copies. Nothing here can stop you, and nothing here can see the second one until it signs.',
    'The account sequence on the chain is the only counter every copy shares. That is what this checks against, which is also why it cannot tell a copy from you using a different tool.',
  ]),
});

/** The sentence a person has to produce to accept a gap. Exported so callers cannot
 *  invent their own wording and quietly make it a checkbox. */
export const VAULT_CONTINUITY_ACKNOWLEDGEMENT = ACKNOWLEDGEMENT;
