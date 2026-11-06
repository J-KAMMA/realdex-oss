import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAddress } from "ethers";

// The one place the QA scripts learn which deployment they are testing.
//
// These used to be constants in each script. After a redeploy that is the worst
// kind of green: the checks keep passing against a retired deployment and say
// nothing about the one that is live. Reading the record means a stale address
// cannot survive a redeploy unnoticed.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function v01Deployment (chainId = "84532", outDir = "artifacts-v01") {
  const file = path.resolve(root, outDir, `deployment-${chainId}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployment record at ${file}`);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  if (record.chainId !== chainId) throw new Error(`record is for chain ${record.chainId}, not ${chainId}`);
  return {
    record,
    deployer: getAddress(record.deployer),
    ambr: getAddress(record.addresses.ambr),
    jade: getAddress(record.addresses.jade),
    pool: getAddress(record.addresses.pool),
    router: getAddress(record.addresses.router),
    factory: getAddress(record.addresses.factory)
  };
}
