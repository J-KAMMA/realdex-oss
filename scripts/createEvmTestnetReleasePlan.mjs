import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_SOURCE_PATHS = Object.freeze([
  "contracts/LocalSwapFactory.sol",
  "contracts/LocalSwapPool.sol",
  "contracts/LocalSwapRouter.sol",
  "contracts/test/MockERC20.sol",
  "hardhat.config.cjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".node-version",
  "scripts/createEvmTestnetReleasePlan.mjs",
  "src/release/v01-profile.ts",
  "src/release/v01-profile-reader.ts",
  "src/release/evm-public-testnet.ts",
  "src/release/evm-json-rpc-reader.ts",
  "src/main.tsx",
  "src/v01/V01App.tsx",
  "src/v01/V01CandidatePanel.tsx",
  "src/v01/runtime.ts",
  "src/v01/fees.ts",
  "src/v01/active-operation.ts",
  "src/v01/send-attempt.ts",
  "src/v01/recovery-intent.ts",
  "src/v01/candidate-reconciliation.ts",
  "src/v01/candidate-adoption.ts",
  "src/v01/history-retention.ts",
  "src/v01/replacement-recovery.ts",
  "src/v01/V01HistoryRetention.tsx",
  "src/v01/v01.css",
  "src/swap/evm-swap-recovery.ts",
  "src/swap/evm-transaction-lifecycle.ts",
  "src/swap/EvmSwapRecoveryCard.tsx",
  "src/swap/evm-local-amm.ts",
  "src/wallet/errors.ts",
  "src/swap/local-amm-code-identities.json"
].sort());

/** Local planning only; missing build inputs are fatal, never silently omitted. */
export async function createEvmTestnetReleasePlan({
  readSource = path => readFile(resolve(root, path), "utf8"),
  now = Date.now()
} = {}) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("RELEASE_PLAN_TIME_INVALID");
  const entries = await Promise.all(RELEASE_SOURCE_PATHS.map(async path => ({ path, content: await readSource(path) })));
  const digest = createHash("sha256");
  for (const entry of entries) {
    if (typeof entry.content !== "string" || !entry.content.length) throw new Error("RELEASE_PLAN_SOURCE_EMPTY");
    digest.update(`${entry.path.length}:${entry.path}:${Buffer.byteLength(entry.content, "utf8")}:`, "utf8");
    digest.update(entry.content, "utf8");
  }
  // Metadata and digest use the same read, not two independently changing files.
  const codeIdentities = JSON.parse(entries.find(entry => entry.path === "src/swap/local-amm-code-identities.json").content);
  const bundleDigest = digest.digest("hex");

  return {
    schema: "realdex.evm-public-testnet-release-plan.v1",
    releaseId: `base-sepolia-${bundleDigest.slice(0, 12)}`,
    status: "design-gate",
    environment: "public-testnet",
    network: { caip2: "eip155:84532", name: "Base Sepolia" },
    source: {
      bundleSha256: `sha256:${bundleDigest}`,
      files: [...RELEASE_SOURCE_PATHS],
      solidity: codeIdentities.solidity,
      optimizerRuns: codeIdentities.optimizerRuns,
      factoryRuntimeCodeHash: codeIdentities.factoryRuntimeCodeHash,
      routerRuntimeCodeHash: codeIdentities.routerRuntimeCodeHash
    },
    requiredBeforeDeployment: [
      "explicit user authorization for this exact release and network",
      "disposable public-testnet deployer with test ETH only",
      "clean compiler artifact/runtime identity check",
      "independent security review scope recorded"
    ],
    requiredAfterDeployment: [
      "Factory and Router successful deployment receipts",
      "exact runtime bytecode observed by two independent RPC readers",
      "source bundle and explorer evidence published for review",
      "funded-wallet swap and recovery exercise before any mainnet decision"
    ],
    prohibited: ["mainnet", "real assets", "automatic liquidity", "private keys in files or output", "implicit publish or deployment"],
    generatedAt: now
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await createEvmTestnetReleasePlan(), null, 2)}\n`);
}
