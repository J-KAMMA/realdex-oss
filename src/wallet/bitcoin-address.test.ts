import { base58check, bech32 } from "@scure/base";
import { getBytes, sha256 } from "ethers";
import { describe, expect, it } from "vitest";
import { validateBip122BitcoinAccount } from "./bitcoin-address";

const mainnet = "bip122:000000000019d6689c085ae165831e93";
const testnet = "bip122:000000000933ea01ad0ee984209779ba";

describe("BIP122 Bitcoin account validation", () => {
  it("accepts checksum-valid mainnet legacy, SegWit v0, and Taproot addresses", () => {
    for (const address of [
      "128Lkh3S7CkDTBZ8W7BbpsN3YYizJMp8p6",
      "35PBEaofpUeH8VnnNSorM1QZsadrZoQp4N",
      "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0"
    ]) expect(validateBip122BitcoinAccount(mainnet, address)).toBe("exact-family");
  });

  it("accepts checksum-valid testnet legacy and SegWit addresses", () => {
    expect(validateBip122BitcoinAccount(testnet, "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toBe("exact-family");
    expect(validateBip122BitcoinAccount(testnet, "tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7")).toBe("exact-family");
  });

  it("rejects wrong-network addresses and checksum mutations", () => {
    expect(validateBip122BitcoinAccount(testnet, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("invalid");
    expect(validateBip122BitcoinAccount(mainnet, "mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn")).toBe("invalid");
    expect(validateBip122BitcoinAccount(mainnet, "35PBEaofpUeH8VnnNSorM1QZsadrZoQp4M")).toBe("invalid");
    expect(validateBip122BitcoinAccount(mainnet, "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyx")).toBe("invalid");
  });

  it("rejects mixed case, wrong witness checksum family, and invalid v0 program length", () => {
    expect(validateBip122BitcoinAccount(mainnet, "bc1qCR8te4kr609gcawutmrza0j4xv80jy8z306fyu")).toBe("invalid");
    const wrongTaprootChecksum = bech32.encode("bc", [1, ...bech32.toWords(new Uint8Array(32).fill(1))]);
    const invalidV0Length = bech32.encode("bc", [0, ...bech32.toWords(new Uint8Array(10).fill(2))]);
    expect(validateBip122BitcoinAccount(mainnet, wrongTaprootChecksum)).toBe("invalid");
    expect(validateBip122BitcoinAccount(mainnet, invalidV0Length)).toBe("invalid");
  });

  it("keeps non-Bitcoin BIP122 networks at the CAIP-only design gate", () => {
    const litecoin = "bip122:12a765e31ffd4059bada1e25190f6e98";
    expect(validateBip122BitcoinAccount(litecoin, "ltc1q8c6fshw2dlwun7ekn9qwf37cu2rn755u9ym7p0")).toBe("caip-only");
    expect(validateBip122BitcoinAccount("bip122:not-a-chain", "anything12345678")).toBe("invalid");
  });

  it("rejects a valid Base58Check payload with an unsupported version byte", () => {
    const codec = base58check((value: Uint8Array) => getBytes(sha256(value)));
    const unsupported = codec.encode(Uint8Array.from([0x30, ...new Uint8Array(20).fill(3)]));
    expect(validateBip122BitcoinAccount(mainnet, unsupported)).toBe("invalid");
  });
});
