import { Secp256k1, ripemd160, sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { base64 } from "@scure/base";
import { describe, expect, it } from "vitest";
import { verifyCosmosSwapBoundary, type CosmosSwapIntent, type CosmosSwapReader } from "./cosmos-swap-boundary";
import {
  OSMOSIS_EXACT_IN_DECODER_ID,
  OSMOSIS_EXACT_IN_MESSAGE_TYPE,
  createOsmosisExactInDecoder,
  createOsmosisExactInVenue,
  osmosisExecutionTarget,
  type OsmosisExactInRouteDescriptor
} from "./osmosis-exact-in-decoder";

const publicKey = Secp256k1.compressPubkey(Secp256k1.makeKeypair(new Uint8Array(32).fill(9)).pubkey);
const sender = toBech32("osmo", ripemd160(sha256(publicKey)));
const route: OsmosisExactInRouteDescriptor = {
  schema: "realdex.osmosis-exact-in-route.v1",
  venueId: "osmosis-test-route",
  revision: 1,
  chainId: "cosmos:osmo-test-5",
  bech32Prefix: "osmo",
  sourceDenom: "uosmo",
  destinationDenom: "ibc/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  hops: [
    { poolId: "12", tokenOutDenom: "uion" },
    { poolId: "34", tokenOutDenom: "ibc/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
  ],
  evidenceUrls: ["https://github.com/osmosis-labs/osmosis/blob/main/proto/osmosis/gamm/v1beta1/tx.proto", "https://github.com/osmosis-labs/osmosis/blob/main/x/poolmanager/README.md"]
};

describe("Osmosis exact-input decoder", () => {
  it("binds one canonical exact-input message and derives a non-executing Cosmos venue", () => {
    const decoder = createOsmosisExactInDecoder(route);
    expect(decoder(message())).toEqual({
      authority: sender,
      recipient: sender,
      executionTarget: "osmosis:gamm:12>34",
      sourceDenom: "uosmo",
      destinationDenom: route.destinationDenom,
      amountInBaseUnits: "1000000",
      minimumOutBaseUnits: "900000"
    });
    expect(osmosisExecutionTarget(route)).toBe("osmosis:gamm:12>34");
    expect(OSMOSIS_EXACT_IN_DECODER_ID).toBe("osmosis-gamm-exact-in-v1");
    expect(createOsmosisExactInVenue(route)).toMatchObject({
      schema: "realdex.cosmos-venue.v1",
      messageTypeUrl: OSMOSIS_EXACT_IN_MESSAGE_TYPE,
      executionTarget: "osmosis:gamm:12>34",
      publicKeyTypeUrl: "/cosmos.crypto.secp256k1.PubKey"
    });
  });

  it("composes with the full TxRaw and two-reader simulation boundary without enabling execution", async () => {
    const venue = createOsmosisExactInVenue(route);
    const signerInfo = concat(
      bytesField(1, any(venue.publicKeyTypeUrl, bytesField(1, publicKey))),
      bytesField(2, bytesField(1, uintField(1, 1n))),
      uintField(3, 7n)
    );
    const fee = concat(bytesField(1, concat(bytesField(1, text("uosmo")), bytesField(2, text("2500")))), uintField(2, 250000n));
    const authInfo = concat(bytesField(1, signerInfo), bytesField(2, fee));
    const body = concat(bytesField(1, any(venue.messageTypeUrl, message())), uintField(3, 1200n));
    const transactionBase64 = base64.encode(concat(bytesField(1, body), bytesField(2, authInfo), bytesField(3, new Uint8Array())));
    const intent: CosmosSwapIntent = {
      schema: "realdex.cosmos-swap-intent.v1", venueId: route.venueId, venueRevision: route.revision,
      chainId: route.chainId, authority: sender, recipient: sender, sourceDenom: route.sourceDenom,
      destinationDenom: route.destinationDenom, amountInBaseUnits: "1000000", expectedOutBaseUnits: "950000",
      minimumOutBaseUnits: "900000", accountNumber: "11", sequence: "7", feeDenom: "uosmo",
      feeAmountBaseUnits: "2500", gasLimit: "250000", timeoutHeight: "1200",
      quoteExpiresAt: 1_788_200_120_000, transactionBase64
    };
    const reader = (id: string): CosmosSwapReader => ({
      id,
      chainId: async () => "osmo-test-5",
      blockHeight: async () => "1000",
      account: async () => ({ accountNumber: "11", sequence: "7", publicKeyTypeUrl: venue.publicKeyTypeUrl, publicKeyBase64: base64.encode(publicKey) }),
      simulate: async () => ({ gasWanted: "180000", gasUsed: "170000", authoritySpent: [{ denom: "uosmo", amount: "1002500" }], recipientReceived: [{ denom: route.destinationDenom, amount: "950000" }] })
    });
    await expect(verifyCosmosSwapBoundary({ venue, intent, readers: [reader("a.example.org"), reader("b.example.org")], decodeSwapMessage: createOsmosisExactInDecoder(route), now: 1_788_200_000_000 })).resolves.toMatchObject({ execution: "design-gate", sourceDebitBaseUnits: "1000000", destinationCreditBaseUnits: "950000" });
  });

  it("rejects unknown, reordered, and non-canonical protobuf fields", () => {
    const decoder = createOsmosisExactInDecoder(route);
    expect(() => decoder(concat(message(), bytesField(5, text("extra"))))).toThrow("OSMOSIS_EXACT_IN_MESSAGE_INVALID");
    expect(() => decoder(message({ senderLast: true }))).toThrow("OSMOSIS_EXACT_IN_MESSAGE_INVALID");
    const canonical = message();
    expect(() => decoder(concat(Uint8Array.of(0x8a, 0x00), canonical.slice(1)))).toThrow("OSMOSIS_EXACT_IN_MESSAGE_INVALID");
  });

  it("rejects substituted pools, hop denoms, input denoms, and the wrong address family", () => {
    const decoder = createOsmosisExactInDecoder(route);
    expect(() => decoder(message({ poolIds: [13n, 34n] }))).toThrow();
    expect(() => decoder(message({ outputDenoms: ["uatom", route.destinationDenom] }))).toThrow();
    expect(() => decoder(message({ inputDenom: "uatom" }))).toThrow();
    expect(() => decoder(message({ sender: toBech32("cosmos", new Uint8Array(20).fill(7)) }))).toThrow();
  });

  it("rejects zero, non-canonical amounts and invalid pool identifiers", () => {
    const decoder = createOsmosisExactInDecoder(route);
    for (const amount of ["0", "01", "-1", "1.0"]) expect(() => decoder(message({ amount }))).toThrow();
    for (const minimumOut of ["0", "0900000", "-1"]) expect(() => decoder(message({ minimumOut }))).toThrow();
    expect(() => decoder(message({ poolIds: [0n, 34n] }))).toThrow();
    expect(() => decoder(message({ poolIds: [(1n << 64n), 34n] }))).toThrow();
  });

  it("rejects cyclic, duplicate, excessive, incomplete, and weakly evidenced route descriptors", () => {
    const invalid = (change: Partial<OsmosisExactInRouteDescriptor>) => () => createOsmosisExactInDecoder({ ...route, ...change });
    expect(invalid({ hops: [{ poolId: "12", tokenOutDenom: "uion" }, { poolId: "12", tokenOutDenom: route.destinationDenom }] })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    expect(invalid({ hops: [{ poolId: "12", tokenOutDenom: "uosmo" }] })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    expect(invalid({ hops: Array.from({ length: 5 }, (_, index) => ({ poolId: String(index + 1), tokenOutDenom: `udenom${index}` })), destinationDenom: "udenom4" })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    expect(invalid({ hops: [], destinationDenom: "uion" })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
    expect(invalid({ evidenceUrls: ["https://example.org/one"] })).toThrow("OSMOSIS_EXACT_IN_ROUTE_INVALID");
  });
});

function message(options: {
  sender?: string;
  senderLast?: boolean;
  poolIds?: bigint[];
  outputDenoms?: string[];
  inputDenom?: string;
  amount?: string;
  minimumOut?: string;
} = {}): Uint8Array {
  const senderField = bytesField(1, text(options.sender ?? sender));
  const poolIds = options.poolIds ?? [12n, 34n];
  const outputDenoms = options.outputDenoms ?? ["uion", route.destinationDenom];
  const routes = poolIds.map((poolId, index) => bytesField(2, concat(uintField(1, poolId), bytesField(2, text(outputDenoms[index])))));
  const coin = bytesField(3, concat(bytesField(1, text(options.inputDenom ?? "uosmo")), bytesField(2, text(options.amount ?? "1000000"))));
  const minimum = bytesField(4, text(options.minimumOut ?? "900000"));
  return options.senderLast ? concat(...routes, senderField, coin, minimum) : concat(senderField, ...routes, coin, minimum);
}

function uintField(number: number, value: bigint): Uint8Array { return concat(varint(BigInt(number << 3)), varint(value)); }
function bytesField(number: number, value: Uint8Array): Uint8Array { return concat(varint(BigInt((number << 3) | 2)), varint(BigInt(value.length)), value); }
function any(typeUrl: string, value: Uint8Array): Uint8Array { return concat(bytesField(1, text(typeUrl)), bytesField(2, value)); }
function varint(value: bigint): Uint8Array { const result: number[] = []; do { let byte = Number(value & 0x7fn); value >>= 7n; if (value) byte |= 0x80; result.push(byte); } while (value); return Uint8Array.from(result); }
function text(value: string): Uint8Array { return new TextEncoder().encode(value); }
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
