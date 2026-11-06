// Test-only contracts on the existing pinned, loopback-only Anvil fixture.
// Every signer is generated for this process and funded only by the local VM.
async function openPinnedRootEvm(hre) {
  const { startAnvil } = await import("./fixture.mjs");
  const chain = await startAnvil();
  let provider;
  try {
    provider = new hre.ethers.JsonRpcProvider(chain.url,
      { name: "pinned-local-anvil", chainId: 31337 },
      { staticNetwork: true, cacheTimeout: -1 });
    const owner = hre.ethers.Wallet.createRandom().connect(provider);
    const signer = new hre.ethers.NonceManager(owner);
    await chain.call("anvil_setBalance", [owner.address, hre.ethers.toQuantity(hre.ethers.parseEther("100"))]);
    return {
      provider, owner, signer,
      async deploy(name, ...args) {
        const factory = await hre.ethers.getContractFactory(name, signer);
        const contract = await factory.deploy(...args);
        await contract.waitForDeployment();
        return contract;
      },
      contractAt: (name, address) => hre.ethers.getContractAt(name, address, signer),
      async close() {
        try { provider.destroy(); } finally { await chain.close(); }
      },
    };
  } catch (error) {
    try { provider?.destroy(); } finally { await chain.close(); }
    throw error;
  }
}

module.exports = { openPinnedRootEvm };
