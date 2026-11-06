/** Test-only fault injection. Never used by the wallet or a public RPC client. */
import assert from 'node:assert/strict';

/**
 * Require THIS injected persistence failure, one reached write, zero submissions,
 * and a locked Vault. Always restore the writer. Preserve both failures if
 * assertion/operation and cleanup fail; never mask a read failure with unlock.
 */
export async function assertStoreFailure({store, vault, operation, submissions, unlock}) {
  assert.equal(typeof store?.write, 'function', 'IBC_FAULT_STORE_REQUIRED');
  for (const callback of [operation, submissions, unlock])
    assert.equal(typeof callback, 'function', 'IBC_FAULT_CALLBACK_REQUIRED');
  assert.equal(vault.status().locked, false, 'IBC_FAULT_REQUIRES_UNLOCKED_VAULT');
  const original = store.write;
  const count = submissions();
  const injected = new Error('TEST_SAVE_FAILURE');
  let writes = 0, primary, primaryFailed = false, cleanup, cleanupFailed = false;
  store.write = () => { writes++; throw injected; };
  try {
    let rejected = false;
    try { await operation(); }
    catch (error) {
      rejected = true;
      // The owner HTTP boundary serializes errors; require the exact code AND
      // one reached injection below, not object identity across that boundary.
      if (!(error instanceof Error) || error.message !== injected.message) throw error;
    }
    assert.equal(rejected, true, 'IBC_EXPECTED_INJECTED_SAVE_FAILURE');
    assert.equal(writes, 1, 'IBC_EXPECTED_EXACTLY_ONE_STORE_WRITE');
    assert.equal(submissions(), count, 'IBC_SAVE_FAILURE_MUST_NOT_SUBMIT');
    assert.equal(vault.status().locked, true, 'IBC_SAVE_FAILURE_MUST_LOCK');
  } catch (error) { primaryFailed = true; primary = error; }
  finally {
    store.write = original;
    try { if (vault.status().locked) await unlock(); }
    catch (error) { cleanupFailed = true; cleanup = error; }
  }
  if (primaryFailed && cleanupFailed)
    throw new AggregateError([primary, cleanup], 'IBC_FAULT_PRIMARY_AND_CLEANUP');
  if (primaryFailed) throw primary;
  if (cleanupFailed) throw cleanup;
  assert.equal(submissions(), count, 'IBC_CLEANUP_MUST_NOT_SUBMIT');
  return {writes, submissions: submissions() - count, writerRestored: store.write === original};
}
