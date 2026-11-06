import { Interface, Wallet, keccak256 } from "ethers";
import { describe, expect, it, vi } from "vitest";
import type { ExternalEvmV2ReadClient, ExternalEvmV2VenueIdentity } from "./external-evm-v2";
import {
  canonicalSignedExternalEvmV2VenueManifestPayload,
  createExternalEvmV2PublicReadClient,
  createExternalEvmV2PublicReadQuorum,
  externalEvmV2VenueSourceFingerprint,
  serializeExternalEvmV2VenueIdentity,
  verifyExternalEvmV2VenueQuorum,
  verifySignedExternalEvmV2VenueManifest,
  type ExternalEvmV2QuorumReader,
  type ExternalEvmV2VenueSourceDescriptor,
  type SignedExternalEvmV2VenueManifest
} from "./external-evm-v2-source";

const now = Date.parse("2026-09-01T00:00:00.000Z");
const router = "0x1000000000000000000000000000000000000001";
const factory = "0x2000000000000000000000000000000000000002";
const token0 = "0x3000000000000000000000000000000000000003";
const token1 = "0x4000000000000000000000000000000000000004";
const pair = "0x5000000000000000000000000000000000000005";
const routerCode = "0x6001600055";
const factoryCode = "0x6002600055";
const pairCode = "0x6003600055";

const venue: ExternalEvmV2VenueIdentity = {
  schema: "realdex.external-evm-v2-venue.v1",
  venueId: "example-v2-path",
  chainId: 84532n,
  router: { address: router, runtimeCodeHash: keccak256(routerCode) },
  factory: { address: factory, runtimeCodeHash: keccak256(factoryCode) },
  path: [token0, token1],
  pairs: [{ address: pair, runtimeCodeHash: keccak256(pairCode), token0, token1 }],
  feeBps: 30,
  evidenceUrls: ["https://source.example.org/deployment", "https://explorer.example.net/address"]
};

async function signedFixture(overrides: Partial<Omit<SignedExternalEvmV2VenueManifest, "signature">> = {}) {
  const signer = Wallet.createRandom();
  const source: ExternalEvmV2VenueSourceDescriptor = {
    schema: "realdex.external-evm-v2-source.v1",
    id: "example.external-v2",
    name: "Example reviewed V2 source",
    signerAddress: signer.address,
    allowedChainIds: ["eip155:84532"],
    evidenceUrls: ["https://source.example.org/policy"]
  };
  const unsigned: Omit<SignedExternalEvmV2VenueManifest, "signature"> = {
    schema: "realdex.signed-external-evm-v2-venues.v1",
    sourceId: source.id,
    sourceFingerprint: externalEvmV2VenueSourceFingerprint(source),
    revision: 4,
    issuedAt: "2026-08-31T00:00:00.000Z",
    expiresAt: "2026-09-30T00:00:00.000Z",
    venues: [serializeExternalEvmV2VenueIdentity(venue)],
    evidenceUrls: ["https://source.example.org/revision/4"],
    ...overrides
  };
  const signature = await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(unsigned));
  return { signer, source, unsigned, signed: { ...unsigned, signature } };
}

function readClient(overrides: Partial<ExternalEvmV2ReadClient> = {}): ExternalEvmV2ReadClient {
  const code = (address: string) => ({ [router.toLowerCase()]: routerCode, [factory.toLowerCase()]: factoryCode, [pair.toLowerCase()]: pairCode }[address.toLowerCase()] ?? "0x");
  return {
    chainId: async () => 84532n,
    code: async (address) => code(address),
    routerFactory: async () => factory,
    factoryPair: async () => pair,
    pairFactory: async () => factory,
    pairTokens: async () => [token0, token1],
    pairReserves: async () => [1_000_000n, 2_000_000n],
    routerAmountsOut: async (_router, amountIn) => [amountIn, amountIn * 2n],
    ...overrides
  };
}

describe("signed External EVM V2 venue sources", () => {
  it("binds a JSON-safe venue manifest to its exact signer, source, and design gate", async () => {
    const { source, signed } = await signedFixture();
    const verified = verifySignedExternalEvmV2VenueManifest(signed, source, { now });
    expect(verified.status).toBe("verified-design-gate");
    expect(verified.executionEnabled).toBe(false);
    expect(verified.recoveredSigner).toBe(source.signerAddress);
    expect(verified.sourceFingerprint).toBe(externalEvmV2VenueSourceFingerprint(source));
    expect(verified.identities[0].chainId).toBe(84532n);
    expect(verified.identities[0].router.address).toBe(router);
  });

  it("rejects signer substitution, expiry, disallowed chains, and unknown unsigned claims", async () => {
    const { signer, source, signed } = await signedFixture();
    const substitutedSource = { ...source, signerAddress: Wallet.createRandom().address };
    const substitutedUnsigned = { ...signed, sourceFingerprint: externalEvmV2VenueSourceFingerprint(substitutedSource) };
    const { signature: _substitutedSignature, ...substitutedPayload } = substitutedUnsigned;
    const substituted = { ...substitutedPayload, signature: await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(substitutedPayload)) };
    expect(() => verifySignedExternalEvmV2VenueManifest(substituted, substitutedSource, { now })).toThrow("EXTERNAL_V2_MANIFEST_SIGNER_NOT_PINNED");
    expect(() => verifySignedExternalEvmV2VenueManifest(signed, source, { now: Date.parse("2026-10-01T00:00:00.000Z") })).toThrow("EXTERNAL_V2_MANIFEST_EXPIRED");
    const restrictedSource = { ...source, allowedChainIds: ["eip155:1"] };
    const restrictedUnsigned = { ...signed, sourceFingerprint: externalEvmV2VenueSourceFingerprint(restrictedSource) };
    const { signature: _restrictedSignature, ...restrictedPayload } = restrictedUnsigned;
    const restricted = { ...restrictedPayload, signature: await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(restrictedPayload)) };
    expect(() => verifySignedExternalEvmV2VenueManifest(restricted, restrictedSource, { now })).toThrow("EXTERNAL_V2_MANIFEST_CHAIN_NOT_ALLOWED");
    expect(() => verifySignedExternalEvmV2VenueManifest(signed, { ...source, evidenceUrls: ["https://source.example.org/substituted-policy"] }, { now })).toThrow("EXTERNAL_V2_MANIFEST_SOURCE_MISMATCH");
    expect(() => verifySignedExternalEvmV2VenueManifest({ ...signed, executionEnabled: true }, source, { now })).toThrow("EXTERNAL_V2_MANIFEST_INVALID");
    expect(() => verifySignedExternalEvmV2VenueManifest({ ...signed, venues: [{ ...signed.venues[0], trusted: true }] }, source, { now })).toThrow("EXTERNAL_V2_MANIFEST_VENUE_INVALID");
  });

  it("blocks rollback and same-revision equivocation while allowing exact replay", async () => {
    const { signer, source, signed } = await signedFixture();
    const verified = verifySignedExternalEvmV2VenueManifest(signed, source, { now });
    const head = { revision: verified.manifest.revision, payloadHash: verified.payloadHash };
    expect(verifySignedExternalEvmV2VenueManifest(signed, source, { now, previousHead: head }).payloadHash).toBe(head.payloadHash);

    const rollbackUnsigned = { ...verified.manifest, revision: 3 };
    const { signature: _signature, ...rollbackPayload } = rollbackUnsigned;
    const rollback = { ...rollbackPayload, signature: await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(rollbackPayload)) };
    expect(() => verifySignedExternalEvmV2VenueManifest(rollback, source, { now, previousHead: head })).toThrow("EXTERNAL_V2_MANIFEST_ROLLBACK_BLOCKED");

    const changedUnsigned = { ...rollbackPayload, revision: 4, evidenceUrls: ["https://source.example.org/revision/4-changed"] };
    const changed = { ...changedUnsigned, signature: await signer.signMessage(canonicalSignedExternalEvmV2VenueManifestPayload(changedUnsigned)) };
    expect(() => verifySignedExternalEvmV2VenueManifest(changed, source, { now, previousHead: head })).toThrow("EXTERNAL_V2_MANIFEST_REVISION_CONFLICT");
  });

  it("rejects duplicate venues and non-canonical JSON chain identifiers", async () => {
    const { source, signed } = await signedFixture();
    expect(() => verifySignedExternalEvmV2VenueManifest({ ...signed, venues: [...signed.venues, signed.venues[0]] }, source, { now })).toThrow("EXTERNAL_V2_MANIFEST_VENUE_DUPLICATE");
    expect(() => verifySignedExternalEvmV2VenueManifest({ ...signed, venues: [{ ...signed.venues[0], chainId: "084532" }] }, source, { now })).toThrow("EXTERNAL_V2_MANIFEST_CHAIN_INVALID");
  });
});

describe("External EVM V2 two-reader venue quorum", () => {
  it("requires exactly two named readers and returns no execution authority", async () => {
    const readers = [{ id: "rpc-a.example", ...readClient() }, { id: "rpc-b.example", ...readClient() }] as [ExternalEvmV2QuorumReader, ExternalEvmV2QuorumReader];
    const verified = await verifyExternalEvmV2VenueQuorum(venue, readers);
    expect(verified.status).toBe("verified-design-gate");
    expect(verified.executionEnabled).toBe(false);
    expect(verified.observations.map((item) => item.readerId)).toEqual(["rpc-a.example", "rpc-b.example"]);
    await expect(verifyExternalEvmV2VenueQuorum(venue, [readers[0]])).rejects.toThrow("EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID");
    await expect(verifyExternalEvmV2VenueQuorum(venue, [{ ...readers[0] }, { ...readers[1], id: readers[0].id }])).rejects.toThrow("EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID");
  });

  it("fails closed when either reader reports changed code or chain identity", async () => {
    const good = { id: "rpc-a.example", ...readClient() };
    const changedCode = { id: "rpc-b.example", ...readClient({ code: async (address) => address === router ? "0x6004" : readClient().code(address) }) };
    await expect(verifyExternalEvmV2VenueQuorum(venue, [good, changedCode])).rejects.toThrow("EXTERNAL_V2_ROUTER_CODE_MISMATCH");
    const wrongChain = { id: "rpc-c.example", ...readClient({ chainId: async () => 1n }) };
    await expect(verifyExternalEvmV2VenueQuorum(venue, [good, wrongChain])).rejects.toThrow("EXTERNAL_V2_CHAIN_MISMATCH");
  });
});

describe("public External EVM V2 JSON-RPC reader", () => {
  it("requires exactly two distinct public HTTPS hosts", () => {
    expect(createExternalEvmV2PublicReadQuorum(["https://rpc-a.example.org", "https://rpc-b.example.org"])).toHaveLength(2);
    expect(() => createExternalEvmV2PublicReadQuorum(["https://rpc.example.org/a", "https://rpc.example.org/b"])).toThrow("DEPLOYMENT_RPC_ENDPOINTS_NOT_INDEPENDENT");
    expect(() => createExternalEvmV2PublicReadQuorum(["https://127.0.0.1", "https://rpc-b.example.org"])).toThrow("DEPLOYMENT_RPC_URL_NOT_PUBLIC");
    expect(() => createExternalEvmV2PublicReadQuorum(["https://rpc-a.example.org"])).toThrow("EXTERNAL_V2_SOURCE_RPC_QUORUM_INVALID");
  });

  it("uses only read methods and strictly decodes all V2 calls", async () => {
    const routerAbi = new Interface(["function factory() view returns (address)", "function getAmountsOut(uint256,address[]) view returns (uint256[])"]);
    const factoryAbi = new Interface(["function getPair(address,address) view returns (address)"]);
    const pairAbi = new Interface(["function factory() view returns (address)", "function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112,uint112,uint32)"]);
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: string; data: string }] };
      let result = "0x14a34";
      if (body.method === "eth_getCode") result = routerCode;
      if (body.method === "eth_call") {
        const data = body.params[0].data;
        const selector = data.slice(0, 10);
        if (selector === routerAbi.getFunction("factory")!.selector || selector === pairAbi.getFunction("factory")!.selector) result = routerAbi.encodeFunctionResult("factory", [factory]);
        else if (selector === factoryAbi.getFunction("getPair")!.selector) result = factoryAbi.encodeFunctionResult("getPair", [pair]);
        else if (selector === pairAbi.getFunction("token0")!.selector) result = pairAbi.encodeFunctionResult("token0", [token0]);
        else if (selector === pairAbi.getFunction("token1")!.selector) result = pairAbi.encodeFunctionResult("token1", [token1]);
        else if (selector === pairAbi.getFunction("getReserves")!.selector) result = pairAbi.encodeFunctionResult("getReserves", [1_000n, 2_000n, 99]);
        else if (selector === routerAbi.getFunction("getAmountsOut")!.selector) result = routerAbi.encodeFunctionResult("getAmountsOut", [[100n, 190n]]);
        else throw new Error("unexpected selector");
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200 });
    });
    const reader = createExternalEvmV2PublicReadClient("https://rpc.example.org", fetchMock as typeof fetch);
    await expect(reader.chainId()).resolves.toBe(84532n);
    await expect(reader.code(router)).resolves.toBe(routerCode);
    await expect(reader.routerFactory(router)).resolves.toBe(factory);
    await expect(reader.factoryPair(factory, token0, token1)).resolves.toBe(pair);
    await expect(reader.pairFactory(pair)).resolves.toBe(factory);
    await expect(reader.pairTokens(pair)).resolves.toEqual([token0, token1]);
    await expect(reader.pairReserves(pair)).resolves.toEqual([1_000n, 2_000n]);
    await expect(reader.routerAmountsOut(router, 100n, [token0, token1])).resolves.toEqual([100n, 190n]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(["eth_chainId", "eth_getCode", "eth_call"]).toContain(JSON.parse(String(init?.body)).method);
      expect(init?.credentials).toBe("omit");
      expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.cache).toBe("no-store");
    }
  });

  it("rejects malformed RPC responses and times out without retrying", async () => {
    const malformed = createExternalEvmV2PublicReadClient("https://rpc.example.org", async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 99, result: "0x1" })));
    await expect(malformed.chainId()).rejects.toThrow("EXTERNAL_V2_SOURCE_RPC_RESPONSE_INVALID");
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const timeout = createExternalEvmV2PublicReadClient("https://rpc.example.org", fetchMock as typeof fetch, 5);
    await expect(timeout.chainId()).rejects.toThrow("EXTERNAL_V2_SOURCE_RPC_TIMEOUT");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
