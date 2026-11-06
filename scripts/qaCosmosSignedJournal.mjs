import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { toBech32 } from "@cosmjs/encoding";

// Storage/lock integration only; the seeded receipt is synthetic, never signing evidence.
const [modules, executablePath] = process.argv.slice(2);
if (!modules || !executablePath) throw new Error("Usage: node scripts/qaCosmosSignedJournal.mjs <runtime-node_modules> <browser-executable>");
const { chromium } = createRequire(join(resolve(modules), "package.json"))("playwright");
const server = await createServer({ server: { host: "127.0.0.1", port: 0, open: false } });
let browser;
const assert = (value, message) => { if (!value) throw new Error(message); };
try {
  await server.listen();
  const address = server.httpServer.address();
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ headless: true, executablePath });
  const context = await browser.newContext();
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/__journal_qa__") return route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Synthetic journal QA</title>" });
    return route.continue();
  });
  const slot = { chainId: "cosmos:osmo-test-5", authority: toBech32("osmo", new Uint8Array(20).fill(9)), sequence: "7" };
  const first = await context.newPage(), second = await context.newPage();
  async function initialize(page) {
    await page.goto(`${origin}/__journal_qa__`);
    await page.evaluate(async slot => {
      window.journal = await import("/src/swap/cosmos-signed-swap-journal.ts");
      const { browserCrossTabExecutionLockManager } = await import("/src/routing/cross-tab-execution-lock.ts");
      window.manager = browserCrossTabExecutionLockManager();
      if (!window.manager) throw new Error("Native Web Locks unavailable");
      window.slot = slot;
      window.slotKey = window.journal.cosmosSignedSwapSlotKey(slot);
    }, slot);
  }
  await initialize(first);
  await initialize(second);
  await first.evaluate(async () => {
    await new Promise(resolve => {
      window.holding = window.manager.request(window.slotKey, { mode: "exclusive", ifAvailable: true }, lock => {
        if (!lock) throw new Error("First tab failed to acquire lock");
        resolve();
        return new Promise(() => {});
      });
    });
  });
  assert(await second.evaluate(() => window.manager.request(window.slotKey, { mode: "exclusive", ifAvailable: true }, lock => lock === null)), "Second tab entered held slot");
  await first.close();
  assert(await second.evaluate(() => window.manager.request(window.slotKey, { mode: "exclusive", ifAvailable: true }, lock => !!lock)), "Closed tab did not release lock");
  await second.evaluate(async () => {
    const { cryptographicFingerprint } = await import("/src/security/cryptographic-fingerprint.ts");
    const payload = {
      schema: "realdex.cosmos-signed-swap-journal.v1", ...window.slot,
      accountNumber: "11", evidenceId: `0x${"1".repeat(64)}`, acceptedAt: 1788200000000,
      transactionHash: "A".repeat(64), unsignedTransactionSha256: "b".repeat(64),
      signDocSha256: "c".repeat(64), intentSha256: "d".repeat(64), stage: "signed-observed",
      submissionStatus: "unknown", executionEnabled: false, automaticResendBlocked: true
    };
    localStorage.setItem(window.slotKey, JSON.stringify({ ...payload, recordHash: cryptographicFingerprint(payload.schema, payload) }));
  });
  await initialize(second);
  assert(await second.evaluate(async () => {
    const restored = window.journal.readCosmosSignedSwapSlot(window.slot);
    if (!restored || restored.executionEnabled !== false || restored.submissionStatus !== "unknown") return false;
    try { await window.journal.persistCosmosSignedSwapEvidence(restored); return false; }
    catch (error) { return error.message === "COSMOS_SIGNED_SWAP_EVIDENCE_NOT_AUTHENTIC"; }
  }), "Reloaded receipt gained authority");
  await second.evaluate(async () => {
    const { cryptographicFingerprint } = await import("/src/security/cryptographic-fingerprint.ts");
    const payload = {
      schema: "realdex.cosmos-signing-reservation.v1", ...window.slot,
      accountNumber: "11", preparationId: `0x${"1".repeat(64)}`, preparedAt: 1788200000000,
      expiresAt: 1788200060000, unsignedTransactionSha256: "b".repeat(64),
      signDocSha256: "c".repeat(64), intentSha256: "d".repeat(64), stage: "signing-reserved",
      signingStatus: "unknown", executionEnabled: false, automaticResendBlocked: true
    };
    localStorage.setItem(window.slotKey, JSON.stringify({ ...payload, recordHash: cryptographicFingerprint(payload.schema, payload) }));
  });
  await initialize(second);
  assert(await second.evaluate(() => {
    const restored = window.journal.readCosmosSigningSlot(window.slot);
    if (!restored || restored.stage !== "signing-reserved" || restored.executionEnabled !== false || restored.signingStatus !== "unknown") return false;
    try { window.journal.readCosmosSignedSwapSlot(window.slot); return false; }
    catch (error) { return error.message === "COSMOS_SIGNED_JOURNAL_SLOT_RESERVED"; }
  }), "Reloaded expired reservation was treated as empty or signed history");
  await second.evaluate(async () => {
    const { cryptographicFingerprint } = await import("/src/security/cryptographic-fingerprint.ts");
    const { recordHash: _hash, ...reserved } = window.journal.readCosmosSigningSlot(window.slot);
    const payload = { ...reserved, stage: "signing-requested", requestedAt: reserved.preparedAt + 1 };
    localStorage.setItem(window.slotKey, JSON.stringify({ ...payload, recordHash: cryptographicFingerprint(payload.schema, payload) }));
  });
  await initialize(second);
  assert(await second.evaluate(() => {
    const restored = window.journal.readCosmosSigningSlot(window.slot);
    if (restored?.stage !== "signing-requested" || restored.signingStatus !== "unknown") return false;
    try { window.journal.readCosmosSignedSwapSlot(window.slot); return false; }
    catch (error) { return error.message === "COSMOS_SIGNED_JOURNAL_SLOT_RESERVED"; }
  }), "Reloaded consumed reservation became reusable or proved a signature");
  assert(await second.evaluate(() => {
    localStorage.setItem(window.slotKey, "corrupted");
    try { window.journal.readCosmosSignedSwapSlot(window.slot); return false; }
    catch (error) { return error.message === "COSMOS_SIGNED_JOURNAL_RECORD_INVALID"; }
  }), "Corruption was treated as empty history");
  console.log(JSON.stringify({ nativeTwoTabExclusion: true, closedTabRelease: true, reloadRestoration: true, restoredAuthorityRejected: true, expiredReservationRetained: true, consumedReservationRetained: true, corruptionRejected: true, realWalletAccess: false }));
} finally {
  await browser?.close();
  await server.close();
}
