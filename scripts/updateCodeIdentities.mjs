#!/usr/bin/env node
// Regenerates src/swap/local-amm-code-identities.json from the compiled artifacts.
//
// The frontend refuses any factory or router whose deployed runtime does not hash
// to the value pinned in that file, so the file has to move whenever a contract
// does. It was maintained by hand, which is the same shape of hazard the reviewed
// profile had before it was generated: a hash copied by a person is a hash that can
// be copied wrongly, or forgotten. Changing LocalSwapRouter is what surfaced it.
//
// MockERC20 is deliberately not derived here. It carries an immutable `decimals`,
// so its artifact holds a placeholder rather than the runtime any instance really
// has; that value has to come from a deployed instance and is left as it stands.
//
// Usage: npx hardhat compile && node scripts/updateCodeIdentities.mjs [--check]
// With --check it writes nothing and exits non-zero when the file is out of date.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "src/swap/local-amm-code-identities.json");
const checkOnly = process.argv.includes("--check");

const artifact = (name) => {
  const file = path.join(root, "artifacts/contracts", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(file)) throw new Error(`no artifact for ${name}; run npx hardhat compile first`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
};

const current = JSON.parse(fs.readFileSync(target, "utf8"));
const next = {
  ...current,
  factoryRuntimeCodeHash: keccak256(artifact("LocalSwapFactory").deployedBytecode),
  routerRuntimeCodeHash: keccak256(artifact("LocalSwapRouter").deployedBytecode)
};

const changed = Object.keys(next).filter(key => JSON.stringify(current[key]) !== JSON.stringify(next[key]));
const serialised = `${JSON.stringify(next, null, 2)}\n`;

if (!changed.length) {
  console.log("code identities already match the compiled artifacts");
} else if (checkOnly) {
  console.error(`code identities are stale: ${changed.join(", ")}; run node scripts/updateCodeIdentities.mjs`);
  process.exitCode = 1;
} else {
  fs.writeFileSync(target, serialised);
  for (const key of changed) console.log(`${key}: ${current[key]} -> ${next[key]}`);
  console.log(`written, sha256:${createHash("sha256").update(serialised).digest("hex")}`);
}
