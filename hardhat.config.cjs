require("./integration/offline-solc.cjs").enableOfflineCompiler();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const fs = require("node:fs");

// Base Sepolia test-only signer. The key is never stored in this repository:
// it is read from REALDEX_V01_SIGNER_PRIVATE_KEY, or from the JSON file named by
// REALDEX_V01_SIGNER_KEY_FILE. Without either, the network is defined without
// accounts and can only read. Deployment still requires the approved v0.1 gate
// and an explicit per-operation authorization; this config grants neither.
function testOnlySignerAccounts() {
  const direct = process.env.REALDEX_V01_SIGNER_PRIVATE_KEY;
  if (direct) return [direct];
  const keyFile = process.env.REALDEX_V01_SIGNER_KEY_FILE;
  if (!keyFile || !fs.existsSync(keyFile)) return [];
  const { privateKey } = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  return privateKey ? [privateKey] : [];
}

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 500 } }
  },
  networks: {
    // The in-process node answers with the public testnet's chain id so a local
    // run produces the same asset identifiers the reviewed routes use. Nothing
    // here reaches a public network; only the number is shared.
    hardhat: { chainId: 84532 },
    localhost: { url: "http://127.0.0.1:8545" },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
      chainId: 84532,
      accounts: testOnlySignerAccounts()
    }
  }
};
