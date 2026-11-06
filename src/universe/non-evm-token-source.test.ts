import { describe, expect, it, vi } from "vitest";
import {
  createCosmosRestDenomReader,
  createCosmosRestDenomReaderQuorum,
  createSolanaJsonRpcMintReader,
  createSolanaJsonRpcMintReaderQuorum,
  verifyCosmosAssetOnChain,
  verifyCosmosAssetOnChainQuorum,
  verifySolanaAssetOnChain,
  verifySolanaAssetOnChainQuorum,
  verifyUniversalAssetOnChain
} from "./non-evm-token-source";
import type { UniversalAsset } from "./types";

const solanaAsset: UniversalAsset = {
  assetType: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/spl:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  symbol: "USDC", name: "Solana Devnet USDC", decimals: 6, provenance: "signed-list", execution: "design-gate"
};

const cosmosAsset: UniversalAsset = {
  assetType: "cosmos:grand-1/denom:uusdc",
  symbol: "USDC.n", name: "Noble Testnet USDC", decimals: 6, provenance: "signed-list", execution: "design-gate"
};

describe("non-EVM token metadata verification", () => {
  it("marks a matching Solana mint partial because symbol and name are not mint fields", async () => {
    const reader = {
      id: "solana-a.example.org",
      genesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      readMint: async () => ({ ownerProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6, initialized: true })
    };
    await expect(verifySolanaAssetOnChain(solanaAsset, reader)).resolves.toMatchObject({ status: "partial", observed: { decimals: 6 } });
    await expect(verifySolanaAssetOnChain(solanaAsset, { ...reader, genesisHash: async () => "11111111111111111111111111111111" })).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifySolanaAssetOnChain(solanaAsset, { ...reader, readMint: async () => ({ ownerProgram: "11111111111111111111111111111111", decimals: 6, initialized: true }) })).resolves.toMatchObject({ status: "mismatch" });
    await expect(verifySolanaAssetOnChain(solanaAsset, { ...reader, readMint: async () => ({ ownerProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 9, initialized: true }) })).resolves.toMatchObject({ status: "mismatch" });
  });

  it("fully verifies only exact Cosmos bank metadata", async () => {
    const reader = {
      id: "cosmos-a.example.org",
      chainId: async () => "grand-1",
      readDenomMetadata: async () => ({ base: "uusdc", display: "USDC", name: "Noble Testnet USDC", symbol: "USDC.n", denomUnits: [{ denom: "uusdc", exponent: 0 }, { denom: "USDC", exponent: 6 }] })
    };
    await expect(verifyCosmosAssetOnChain(cosmosAsset, reader)).resolves.toMatchObject({ status: "verified", observed: { decimals: 6 } });
    await expect(verifyCosmosAssetOnChain(cosmosAsset, { ...reader, chainId: async () => "other-1" })).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifyCosmosAssetOnChain(cosmosAsset, { ...reader, readDenomMetadata: async () => ({ ...(await reader.readDenomMetadata()), symbol: "FAKE" }) })).resolves.toMatchObject({ status: "mismatch" });
  });

  it("requires two independent Solana readers and never promotes symbol or name", async () => {
    const matching = (id: string) => ({
      id,
      genesisHash: async () => "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      readMint: async () => ({ ownerProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 6, initialized: true })
    });
    await expect(verifySolanaAssetOnChainQuorum(solanaAsset, [matching("a.example.org")])).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifySolanaAssetOnChainQuorum(solanaAsset, [matching("a.example.org"), matching("a.example.org")])).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifySolanaAssetOnChainQuorum(solanaAsset, [matching("a.example.org"), matching("b.example.org")])).resolves.toMatchObject({ status: "partial", observed: { decimals: 6 } });
    await expect(verifySolanaAssetOnChainQuorum(solanaAsset, [matching("a.example.org"), { ...matching("b.example.org"), readMint: async () => ({ ownerProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", decimals: 9, initialized: true }) }])).resolves.toMatchObject({ status: "mismatch" });
    await expect(verifySolanaAssetOnChainQuorum(solanaAsset, [matching("a.example.org"), { ...matching("b.example.org"), genesisHash: async () => { throw new Error("offline"); } }])).resolves.toMatchObject({ status: "not-checked" });
  });

  it("verifies Cosmos only when two independent readers agree exactly", async () => {
    const matching = (id: string) => ({
      id,
      chainId: async () => "grand-1",
      readDenomMetadata: async () => ({ base: "uusdc", display: "USDC", name: "Noble Testnet USDC", symbol: "USDC.n", denomUnits: [{ denom: "uusdc", exponent: 0 }, { denom: "USDC", exponent: 6 }] })
    });
    await expect(verifyCosmosAssetOnChainQuorum(cosmosAsset, [matching("a.example.org"), matching("b.example.org")])).resolves.toMatchObject({ status: "verified" });
    await expect(verifyCosmosAssetOnChainQuorum(cosmosAsset, [matching("a.example.org"), { ...matching("b.example.org"), chainId: async () => "other-1" }])).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifyCosmosAssetOnChainQuorum(cosmosAsset, [matching("a.example.org"), { ...matching("b.example.org"), readDenomMetadata: async () => ({ ...(await matching("b.example.org").readDenomMetadata()), symbol: "FAKE" }) }])).resolves.toMatchObject({ status: "mismatch" });
  });

  it("dispatches by namespace and fails closed when a reader is absent", async () => {
    await expect(verifyUniversalAssetOnChain(solanaAsset, {})).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifyUniversalAssetOnChain(cosmosAsset, {})).resolves.toMatchObject({ status: "not-checked" });
    await expect(verifyUniversalAssetOnChain({ ...cosmosAsset, assetType: "bip122:abc/slip44:0" }, {})).resolves.toMatchObject({ status: "not-checked" });
  });

  it("uses bounded credential-free Solana JSON-RPC reads", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { id: number; method: string };
      const result = request.method === "getGenesisHash"
        ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
        : { value: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { program: "spl-token", parsed: { type: "mint", info: { decimals: 6, isInitialized: true } } } } };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { status: 200 });
    });
    const reader = createSolanaJsonRpcMintReader("https://solana.example.org", fetchMock as typeof fetch);
    expect(reader.id).toBe("solana.example.org");
    await expect(reader.genesisHash()).resolves.toBe("EtWTRABZaYq6iMfeYKouRu166VU2xqa1");
    await expect(reader.readMint("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")).resolves.toMatchObject({ decimals: 6, initialized: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  });

  it("reads Cosmos node identity and bank metadata over REST", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("node_info")
        ? { default_node_info: { network: "grand-1" } }
        : { metadata: { base: "uusdc", display: "USDC", name: "Noble Testnet USDC", symbol: "USDC.n", denom_units: [{ denom: "uusdc", exponent: 0 }, { denom: "USDC", exponent: 6 }] } };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const reader = createCosmosRestDenomReader("https://cosmos.example.org/api/", fetchMock as typeof fetch);
    expect(reader.id).toBe("cosmos.example.org");
    await expect(reader.chainId()).resolves.toBe("grand-1");
    await expect(reader.readDenomMetadata("uusdc")).resolves.toMatchObject({ base: "uusdc", symbol: "USDC.n" });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("cosmos/bank/v1beta1/denoms_metadata/uusdc");
  });

  it("rejects secret-bearing and private endpoints before any request", () => {
    for (const endpoint of ["http://rpc.example.org", "https://user:pass@rpc.example.org", "https://localhost:1317", "https://10.0.0.1", "https://rpc.example.org?key=secret"]) {
      expect(() => createSolanaJsonRpcMintReader(endpoint)).toThrow("NON_EVM_ENDPOINT_NOT_PUBLIC");
      expect(() => createCosmosRestDenomReader(endpoint)).toThrow("NON_EVM_ENDPOINT_NOT_PUBLIC");
    }
  });

  it("requires exactly two distinct public hosts when constructing a quorum", () => {
    expect(() => createSolanaJsonRpcMintReaderQuorum(["https://a.example.org", ""])).toThrow("NON_EVM_READER_QUORUM_REQUIRED");
    expect(() => createSolanaJsonRpcMintReaderQuorum(["https://a.example.org/one", "https://a.example.org/two"])).toThrow("NON_EVM_READER_QUORUM_NOT_INDEPENDENT");
    expect(createSolanaJsonRpcMintReaderQuorum(["https://a.example.org", "https://b.example.org"]).map((reader) => reader.id)).toEqual(["a.example.org", "b.example.org"]);
    expect(createCosmosRestDenomReaderQuorum(["https://a.example.org", "https://b.example.org"]).map((reader) => reader.id)).toEqual(["a.example.org", "b.example.org"]);
  });
});
