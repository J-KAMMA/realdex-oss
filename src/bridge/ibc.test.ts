import { toBech32 } from "@cosmjs/encoding";
import { describe, expect, it, vi } from "vitest";
import { assertExecutableRoute } from "./engine";
import { IBC_ROUTES, canRequestIbcEstimate, extractIbcPacketTracking, isIbcDirection, readIbcChannel, validateIbcAmount, validateIbcRecipient } from "./ibc";

const address = (prefix: string) => toBech32(prefix, new Uint8Array(20).fill(7));

describe("IBC ICS-20 testnet route", () => {
  it("keeps both directions behind reviewed executable manifests", () => {
    expect(() => assertExecutableRoute(IBC_ROUTES["noble-to-osmosis"])).not.toThrow();
    expect(() => assertExecutableRoute(IBC_ROUTES["osmosis-to-noble"])).not.toThrow();
    expect(isIbcDirection("noble-to-osmosis")).toBe(true);
    expect(isIbcDirection("base-to-solana")).toBe(false);
  });

  it("pins the reciprocal ICS-20 channels and traced Osmosis denom", () => {
    expect(IBC_ROUTES["noble-to-osmosis"].sourceEndpoint).toBe("transfer/channel-22");
    expect(IBC_ROUTES["noble-to-osmosis"].destinationEndpoint).toBe("transfer/channel-4280");
    expect(IBC_ROUTES["osmosis-to-noble"].supportedAssets[0].assetId).toBe("ibc/DE6792CF9E521F6AD6E9A4BDF6225C9571A3B74ACC0A529F92BC5122A39D2E58");
  });

  it("rejects ambiguous amounts and wrong bech32 destination prefixes", () => {
    expect(validateIbcAmount("1.123456")).toBe("1.123456");
    expect(() => validateIbcAmount("1.1234567")).toThrow();
    expect(() => validateIbcAmount("1e3")).toThrow();
    expect(validateIbcRecipient("noble-to-osmosis", address("osmo"))).toMatch(/^osmo1/);
    expect(() => validateIbcRecipient("noble-to-osmosis", address("noble"))).toThrow();
    expect(canRequestIbcEstimate("osmosis-to-noble", "1", address("noble"))).toBe(true);
  });

  it("extracts exactly one reviewed send_packet identity for finality recovery", () => {
    const tracking = extractIbcPacketTracking("noble-to-osmosis", "A".repeat(64), [{ type: "send_packet", attributes: [
      { key: "packet_sequence", value: "17" }, { key: "packet_src_channel", value: "channel-22" }, { key: "packet_dst_channel", value: "channel-4280" }
    ] }], Date.now() + 60_000);
    expect(tracking).toMatchObject({ sequence: "17", sourceChannel: "channel-22", destinationChannel: "channel-4280" });
    expect(() => extractIbcPacketTracking("noble-to-osmosis", "A".repeat(64), [], Date.now() + 60_000)).toThrow("IBC_PACKET_TRACKING_MISSING");
  });

  it("reads channel state only through the bounded credential-free GET boundary", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ channel: { state: "STATE_OPEN", version: "ics20-1", counterparty: { channel_id: "channel-4280" } } }), { status: 200 }));
    await expect(readIbcChannel("https://rest.example.org", "channel-22", request as typeof fetch)).resolves.toEqual({ state: "STATE_OPEN", version: "ics20-1", counterparty: "channel-4280" });
    expect(request).toHaveBeenCalledWith("https://rest.example.org/ibc/core/channel/v1/channels/channel-22/ports/transfer", expect.objectContaining({ credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" }));
    await expect(readIbcChannel("https://rest.example.org", "unsafe-channel", request as typeof fetch)).rejects.toThrow("IBC_CHANNEL_ID_INVALID");
  });
});
