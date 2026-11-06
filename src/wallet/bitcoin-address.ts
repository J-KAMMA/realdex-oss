import { base58check, bech32, bech32m } from "@scure/base";
import { getBytes, sha256 } from "ethers";

export type Bip122AccountValidation = "exact-family" | "caip-only" | "invalid";
export type BitcoinAddressType = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | "witness-unknown";
export type DecodedBitcoinAddress = { chainId: string; type: BitcoinAddressType; scriptPubKey: Uint8Array };

type BitcoinNetwork = {
  hrp: "bc" | "tb";
  base58Versions: readonly [number, number];
};

const BITCOIN_NETWORKS: Record<string, BitcoinNetwork> = {
  "bip122:000000000019d6689c085ae165831e93": { hrp: "bc", base58Versions: [0x00, 0x05] },
  "bip122:000000000933ea01ad0ee984209779ba": { hrp: "tb", base58Versions: [0x6f, 0xc4] }
};

const bitcoinBase58Check = base58check((value: Uint8Array) => getBytes(sha256(value)));

export function validateBip122BitcoinAccount(chain: string, address: string): Bip122AccountValidation {
  if (!/^bip122:[0-9a-f]{32}$/.test(chain) || !/^[A-Za-z0-9]{14,128}$/.test(address)) return "invalid";
  const network = BITCOIN_NETWORKS[chain];
  if (!network) return "caip-only";
  return decodeBitcoinAddress(chain, address) ? "exact-family" : "invalid";
}

export function decodeBitcoinAddress(chain: string, address: string): DecodedBitcoinAddress | null {
  const network = BITCOIN_NETWORKS[chain];
  if (!network || !/^[A-Za-z0-9]{14,128}$/.test(address)) return null;
  return decodeBitcoinBase58Address(chain, address, network) ?? decodeBitcoinSegwitAddress(chain, address, network);
}

function decodeBitcoinBase58Address(chainId: string, address: string, network: BitcoinNetwork): DecodedBitcoinAddress | null {
  try {
    const payload = bitcoinBase58Check.decode(address);
    if (payload.length !== 21 || !network.base58Versions.includes(payload[0])) return null;
    const hash = payload.slice(1);
    if (payload[0] === network.base58Versions[0]) return { chainId, type: "p2pkh", scriptPubKey: bytes(0x76, 0xa9, 0x14, ...hash, 0x88, 0xac) };
    return { chainId, type: "p2sh", scriptPubKey: bytes(0xa9, 0x14, ...hash, 0x87) };
  } catch { return null; }
}

function decodeBitcoinSegwitAddress(chainId: string, address: string, network: BitcoinNetwork): DecodedBitcoinAddress | null {
  if (address.length < 14 || address.length > 74 || hasMixedCase(address)) return null;
  const normalized = address.toLowerCase();
  for (const [encoding, codec] of [["bech32", bech32], ["bech32m", bech32m]] as const) {
    try {
      const decoded = codec.decode(normalized);
      if (decoded.prefix !== network.hrp || decoded.words.length < 2) continue;
      const version = decoded.words[0];
      if (version < 0 || version > 16) continue;
      const program = codec.fromWords(decoded.words.slice(1));
      if (program.length < 2 || program.length > 40) continue;
      if (version === 0 && (encoding !== "bech32" || (program.length !== 20 && program.length !== 32))) continue;
      if (version > 0 && encoding !== "bech32m") continue;
      const opcode = version === 0 ? 0 : 0x50 + version;
      const type: BitcoinAddressType = version === 0 ? (program.length === 20 ? "p2wpkh" : "p2wsh") : version === 1 && program.length === 32 ? "p2tr" : "witness-unknown";
      return { chainId, type, scriptPubKey: bytes(opcode, program.length, ...program) };
    } catch { /* Try the other checksum family. */ }
  }
  return null;
}

function hasMixedCase(value: string): boolean {
  return value !== value.toLowerCase() && value !== value.toUpperCase();
}

function bytes(...values: number[]): Uint8Array { return Uint8Array.from(values); }
