import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { createEvmTestnetReleasePlan, RELEASE_SOURCE_PATHS } from "./createEvmTestnetReleasePlan.mjs";

const now = 1_788_316_000_000;
const readSource = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("release inputs are sorted, complete and bounded to the testnet plan", async () => {
  const plan = await createEvmTestnetReleasePlan({ now });
  assert.deepEqual(plan.source.files, [...new Set(RELEASE_SOURCE_PATHS)].sort());
  for (const path of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".node-version", "contracts/test/MockERC20.sol", "scripts/createEvmTestnetReleasePlan.mjs", "src/main.tsx", "src/v01/V01App.tsx", "src/v01/runtime.ts", "src/v01/active-operation.ts", "src/v01/v01.css"]) assert.ok(plan.source.files.includes(path));
  // Post-deployment configuration contains this digest; it needs separate review, not a self-reference.
  assert.ok(plan.source.files.includes("src/v01/fees.ts"));
  assert.ok(plan.source.files.includes("src/swap/evm-swap-recovery.ts"));
  assert.ok(plan.source.files.includes("src/swap/evm-local-amm.ts"));
  assert.ok(plan.source.files.includes("src/wallet/errors.ts"));
  assert.ok(!plan.source.files.includes("src/v01/reviewed-profile.ts"));
  assert.equal(plan.status, "design-gate");
  assert.equal(plan.environment, "public-testnet");
  assert.equal(plan.network.caip2, "eip155:84532");
  assert.ok(plan.requiredBeforeDeployment.some(text => text.includes("explicit user authorization")));
  assert.ok(plan.prohibited.includes("mainnet"));
});

test("identical input bytes yield the same release ID independent of planning time", async () => {
  const first = await createEvmTestnetReleasePlan({ now });
  const later = await createEvmTestnetReleasePlan({ now: now + 1 });
  assert.equal(first.releaseId, later.releaseId);
  assert.deepEqual(first.source, later.source);
  assert.notEqual(first.generatedAt, later.generatedAt);
});

test("every tracked input change produces a different bundle and release ID", async () => {
  const original = await createEvmTestnetReleasePlan({ now });
  for (const target of RELEASE_SOURCE_PATHS) {
    const changed = await createEvmTestnetReleasePlan({ now, readSource: async path => (await readSource(path)) + (path === target ? "\n" : "") });
    assert.notEqual(changed.source.bundleSha256, original.source.bundleSha256, target);
    assert.notEqual(changed.releaseId, original.releaseId, target);
  }
});

test("missing or empty lockfiles fail rather than yielding a partial plan", async () => {
  await assert.rejects(createEvmTestnetReleasePlan({ now, readSource: path => path === "pnpm-lock.yaml" ? Promise.reject(new Error("missing lock")) : readSource(path) }), /missing lock/);
  await assert.rejects(createEvmTestnetReleasePlan({ now, readSource: path => path === "pnpm-lock.yaml" ? "" : readSource(path) }), /RELEASE_PLAN_SOURCE_EMPTY/);
});

test("identity metadata is read exactly once, from the same bytes hashed in the plan", async () => {
  const counts = new Map();
  const plan = await createEvmTestnetReleasePlan({ now, readSource: path => {
    counts.set(path, (counts.get(path) ?? 0) + 1);
    assert.equal(counts.get(path), 1);
    return readSource(path);
  } });
  const identity = JSON.parse(await readSource("src/swap/local-amm-code-identities.json"));
  assert.equal(plan.source.factoryRuntimeCodeHash, identity.factoryRuntimeCodeHash);
  assert.equal(plan.source.routerRuntimeCodeHash, identity.routerRuntimeCodeHash);
});

test("invalid planning times are rejected before reading inputs", async () => {
  for (const value of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(createEvmTestnetReleasePlan({ now: value, readSource: () => { throw new Error("must not read"); } }), /RELEASE_PLAN_TIME_INVALID/);
  }
});
