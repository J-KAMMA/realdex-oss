const base = require("./hardhat.config.cjs");

module.exports = {
  ...base,
  defaultNetwork: "hardhat",
  networks: {
    hardhat: {
      chainId: 84532,
      // Test-only: return a receipt for deliberately reverted transactions so the
      // adapter can preserve on-chain failure evidence. Production config is unchanged.
      throwOnTransactionFailures: false
    }
  }
};
