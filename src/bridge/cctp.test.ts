import { describe, expect, it } from "vitest";
import { CCTP_EXECUTION_BLOCK_CODE, CCTP_ROUTES, assertCctpExecutionAvailable, canRequestCctpQuote, cctpBurnProgressFromEvent, directionForFamilies, validateCctpAmount, validateRecipient } from "./cctp";
import { assertExecutableRoute } from "./engine";

describe("CCTP testnet route", () => {
  it("maps both Base/Solana directions", () => {
    expect(directionForFamilies("evm", "solana")).toBe("base-to-solana");
    expect(directionForFamilies("solana", "evm")).toBe("solana-to-base");
    expect(directionForFamilies("evm", "evm")).toBeNull();
  });

  it("fails all Base-dependent CCTP routes closed until current asset evidence receives explicit release approval", () => {
    for (const route of Object.values(CCTP_ROUTES)) {
      expect(route.status).toBe("disabled");
      expect(() => assertExecutableRoute(route)).toThrow("ROUTE_NOT_VERIFIED");
    }
    expect(() => assertCctpExecutionAvailable()).toThrow(CCTP_EXECUTION_BLOCK_CODE);
  });

  it("rejects ambiguous amounts and wrong destination address formats", () => {
    expect(validateCctpAmount("1.123456")).toBe("1.123456");
    expect(() => validateCctpAmount("1.1234567")).toThrow();
    expect(() => validateCctpAmount("1e3")).toThrow();
    expect(validateRecipient("solana-to-base", "0x1111111111111111111111111111111111111111")).toMatch(/^0x/);
    expect(() => validateRecipient("base-to-solana", "0x1111111111111111111111111111111111111111")).toThrow();
    expect(canRequestCctpQuote("base-to-solana", "1", "11111111111111111111111111111111")).toBe(false);
    expect(canRequestCctpQuote("solana-to-base", "1", "11111111111111111111111111111111")).toBe(false);
    expect(canRequestCctpQuote("base-to-arbitrum", "1", "0x1111111111111111111111111111111111111111")).toBe(false);
  });

  it("accepts only an exact successful burn event as early recovery evidence", () => {
    const txHash = `0x${"a".repeat(64)}`;
    expect(cctpBurnProgressFromEvent({ protocol: "cctp", version: "v2", method: "burn", values: { name: "burn", state: "success", txHash, explorerUrl: `https://example.invalid/tx/${txHash}` } }, "CCTPV2BridgingProvider")).toMatchObject({ state: "pending", steps: [{ txHash }] });
    expect(cctpBurnProgressFromEvent({ protocol: "cctp", version: "v2", method: "approve", values: { name: "approve", state: "success", txHash } }, "CCTPV2BridgingProvider")).toBeUndefined();
    expect(cctpBurnProgressFromEvent({ protocol: "cctp", version: "v2", method: "burn", values: { name: "burn", state: "pending", txHash } }, "CCTPV2BridgingProvider")).toBeUndefined();
    expect(cctpBurnProgressFromEvent({ protocol: "cctp", version: "v2", method: "burn", values: { name: "burn", state: "success", txHash, explorerUrl: "http://unsafe.invalid" } }, "CCTPV2BridgingProvider")).toBeUndefined();
  });
});
