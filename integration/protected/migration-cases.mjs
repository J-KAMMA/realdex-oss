/**
 * UP03's official migration scenario registry.
 *
 * The ids are deliberately independent of the test implementation.  Keep this
 * list stable: the parent migration test registers the scenarios from here and
 * the official runner selects each one by its exact name.
 */
const cases = [
  ['UP03-M01', 'Protected migration freezes source, imports one exact target and retires source after signed receipt'],
  ['UP03-M02', 'Export is idempotent after freeze and never generates a second migration package'],
  ['UP03-M03', 'Destination import is idempotent and returns the exact signed receipt'],
  ['UP03-M04', 'Migration ciphertext is target-bound and cannot be imported into another protected pair'],
  ['UP03-M05', 'Wrong password leaves destination generation zero and source frozen'],
  ['UP03-M06', 'Source without a verified current backup cannot enter migration'],
  ['UP03-M07', 'Unresolved transaction state cannot migrate and cannot freeze the source'],
  ['UP03-M08', 'Persistent agent authority is revoked in the migrated encrypted payload'],
  ['UP03-M09', 'Tampering package ciphertext, migration metadata or target descriptor is rejected before destination write'],
  ['UP03-M10', 'Forged or modified destination receipt cannot retire source'],
  ['UP03-M11', 'Receipt is bound to the exact package and source migration ID'],
  ['UP03-M12', 'Crash after migration package write freezes normal source and rerun reconstructs marker without new ciphertext'],
  ['UP03-M13', 'Crash after destination ciphertext commit but before receipt can resume without writing a second generation'],
  ['UP03-M14', 'Destination already containing another Vault is never overwritten'],
  ['UP03-M15', 'Source remains byte-identical while pending and retired; migration never rewrites the old ciphertext'],
  ['UP03-M16', 'Migrated destination preserves account identity/settings but carries distinct storage pair and provenance'],
  ['UP03-M17', 'Target descriptor is stable across restarts and is tied to its stored Ed25519 private key'],
  ['UP03-M18', 'Target descriptor, package and receipt validators reject extra fields and bad signatures'],
  ['UP03-M19', 'Migration files use owner-only regular files and normal target can open only after imported ciphertext exists'],
  ['UP03-M20', 'There is deliberately no source migration abort API after export'],
  ['UP03-M21', 'Migration source and destination pair must be distinct'],
];

export const MIGRATION_CASES = Object.freeze(cases.map(([id, name]) => Object.freeze({id, name})));
