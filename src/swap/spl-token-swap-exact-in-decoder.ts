import { base58 } from "@scure/base";
import { AccountRole } from "@solana/kit";
import type { DecodedSolanaSwapInstruction, SolanaSwapInstructionDecoder, SolanaVenueDescriptor } from "./solana-swap-boundary";

export const SPL_TOKEN_SWAP_EXACT_IN_DECODER_ID = "spl-token-swap-exact-in-v1";

export type SplTokenSwapExactInRouteDescriptor = {
  schema: "realdex.spl-token-swap-exact-in-route.v1";
  venueId: string;
  revision: number;
  chainId: `solana:${string}`;
  programAddress: string;
  programOwner: string;
  programDataAddress: string;
  programDataSha256: string;
  tokenProgramAddress: string;
  swapState: string;
  swapAuthority: string;
  poolSourceTokenAccount: string;
  poolDestinationTokenAccount: string;
  poolMint: string;
  poolFeeAccount: string;
  sourceMint: string;
  destinationMint: string;
  hostFeeAccount: string | null;
  evidenceUrls: string[];
};

export function validateSplTokenSwapExactInRouteDescriptor(value: unknown): SplTokenSwapExactInRouteDescriptor {
  const keys = ["schema", "venueId", "revision", "chainId", "programAddress", "programOwner", "programDataAddress", "programDataSha256", "tokenProgramAddress", "swapState", "swapAuthority", "poolSourceTokenAccount", "poolDestinationTokenAccount", "poolMint", "poolFeeAccount", "sourceMint", "destinationMint", "hostFeeAccount", "evidenceUrls"] as const;
  if (!isRecord(value) || !exactKeys(value, keys) || value.schema !== "realdex.spl-token-swap-exact-in-route.v1" || !bounded(value.venueId, 100) || !Number.isSafeInteger(value.revision) || Number(value.revision) <= 0 || typeof value.chainId !== "string" || !/^solana:[1-9A-HJ-NP-Za-km-z]{32}$/.test(value.chainId) || typeof value.programDataSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(value.programDataSha256) || (value.hostFeeAccount !== null && typeof value.hostFeeAccount !== "string")) fail("SPL_TOKEN_SWAP_ROUTE_INVALID");
  const addresses = [value.programAddress, value.programOwner, value.programDataAddress, value.tokenProgramAddress, value.swapState, value.swapAuthority, value.poolSourceTokenAccount, value.poolDestinationTokenAccount, value.poolMint, value.poolFeeAccount, value.sourceMint, value.destinationMint, ...(value.hostFeeAccount ? [value.hostFeeAccount] : [])];
  if (addresses.some((address) => !isAddress(address))) fail("SPL_TOKEN_SWAP_ROUTE_INVALID");
  const poolAddresses = [value.swapState, value.swapAuthority, value.poolSourceTokenAccount, value.poolDestinationTokenAccount, value.poolMint, value.poolFeeAccount, value.sourceMint, value.destinationMint, ...(value.hostFeeAccount ? [value.hostFeeAccount] : [])];
  if (new Set(poolAddresses).size !== poolAddresses.length) fail("SPL_TOKEN_SWAP_ROUTE_INVALID");
  if (!Array.isArray(value.evidenceUrls) || value.evidenceUrls.length < 2 || value.evidenceUrls.length > 8 || new Set(value.evidenceUrls).size !== value.evidenceUrls.length || value.evidenceUrls.some((url) => typeof url !== "string" || !isHttps(url))) fail("SPL_TOKEN_SWAP_ROUTE_INVALID");
  return {
    schema: value.schema, venueId: value.venueId, revision: Number(value.revision), chainId: value.chainId as `solana:${string}`,
    programAddress: value.programAddress as string, programOwner: value.programOwner as string, programDataAddress: value.programDataAddress as string,
    programDataSha256: value.programDataSha256.toLowerCase(), tokenProgramAddress: value.tokenProgramAddress as string, swapState: value.swapState as string,
    swapAuthority: value.swapAuthority as string, poolSourceTokenAccount: value.poolSourceTokenAccount as string,
    poolDestinationTokenAccount: value.poolDestinationTokenAccount as string, poolMint: value.poolMint as string, poolFeeAccount: value.poolFeeAccount as string,
    sourceMint: value.sourceMint as string, destinationMint: value.destinationMint as string, hostFeeAccount: value.hostFeeAccount as string | null,
    evidenceUrls: [...value.evidenceUrls] as string[]
  };
}

export function createSplTokenSwapExactInVenue(route: SplTokenSwapExactInRouteDescriptor): SolanaVenueDescriptor {
  assertRoute(route);
  return {
    schema: "realdex.solana-venue.v1",
    venueId: route.venueId,
    revision: route.revision,
    chainId: route.chainId,
    programAddress: route.programAddress,
    programOwner: route.programOwner,
    programDataAddress: route.programDataAddress,
    programDataSha256: route.programDataSha256.toLowerCase(),
    tokenProgramAddress: route.tokenProgramAddress,
    executionTarget: route.swapState,
    evidenceUrls: [...route.evidenceUrls]
  };
}

export function createSplTokenSwapExactInDecoder(route: SplTokenSwapExactInRouteDescriptor): SolanaSwapInstructionDecoder {
  assertRoute(route);
  const expectedCount = route.hostFeeAccount ? 15 : 14;
  return ({ data, accounts }) => {
    if (!(data instanceof Uint8Array) || data.length !== 17 || data[0] !== 1 || !Array.isArray(accounts) || accounts.length !== expectedCount) fail();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const amountIn = view.getBigUint64(1, true);
    const minimumOut = view.getBigUint64(9, true);
    if (amountIn <= 0n || minimumOut <= 0n) fail();

    exactAccount(accounts, 0, route.swapState, [AccountRole.READONLY]);
    exactAccount(accounts, 1, route.swapAuthority, [AccountRole.READONLY]);
    exactSigner(accounts, 2);
    exactWritable(accounts, 3);
    exactAccount(accounts, 4, route.poolSourceTokenAccount, [AccountRole.WRITABLE]);
    exactAccount(accounts, 5, route.poolDestinationTokenAccount, [AccountRole.WRITABLE]);
    exactWritable(accounts, 6);
    exactAccount(accounts, 7, route.poolMint, [AccountRole.WRITABLE]);
    exactAccount(accounts, 8, route.poolFeeAccount, [AccountRole.WRITABLE]);
    exactAccount(accounts, 9, route.sourceMint, [AccountRole.READONLY]);
    exactAccount(accounts, 10, route.destinationMint, [AccountRole.READONLY]);
    exactAccount(accounts, 11, route.tokenProgramAddress, [AccountRole.READONLY]);
    exactAccount(accounts, 12, route.tokenProgramAddress, [AccountRole.READONLY]);
    exactAccount(accounts, 13, route.tokenProgramAddress, [AccountRole.READONLY]);
    if (route.hostFeeAccount) exactAccount(accounts, 14, route.hostFeeAccount, [AccountRole.WRITABLE]);

    return {
      authority: accounts[2].address,
      sourceMint: route.sourceMint,
      destinationMint: route.destinationMint,
      sourceTokenAccount: accounts[3].address,
      destinationTokenAccount: accounts[6].address,
      tokenProgramAddress: route.tokenProgramAddress,
      executionTarget: route.swapState,
      amountInBaseUnits: amountIn.toString(),
      minimumOutBaseUnits: minimumOut.toString()
    } satisfies DecodedSolanaSwapInstruction;
  };
}

function assertRoute(route: SplTokenSwapExactInRouteDescriptor): void {
  validateSplTokenSwapExactInRouteDescriptor(route);
}

function exactSigner(accounts: Array<{ address: string; role: number }>, index: number): void {
  if (!isAddress(accounts[index]?.address) || ![AccountRole.READONLY_SIGNER, AccountRole.WRITABLE_SIGNER].includes(accounts[index].role)) fail();
}
function exactWritable(accounts: Array<{ address: string; role: number }>, index: number): void {
  if (!isAddress(accounts[index]?.address) || accounts[index].role !== AccountRole.WRITABLE) fail();
}
function exactAccount(accounts: Array<{ address: string; role: number }>, index: number, address: string, roles: readonly number[]): void {
  if (accounts[index]?.address !== address || !roles.includes(accounts[index].role)) fail();
}
function isAddress(value: unknown): value is string { try { return typeof value === "string" && base58.decode(value).length === 32; } catch { return false; } }
function bounded(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key)); }
function isHttps(value: string): boolean { try { const url = new URL(value); return value.length <= 2_048 && url.protocol === "https:" && !url.username && !url.password; } catch { return false; } }
function fail(message = "SPL_TOKEN_SWAP_INSTRUCTION_INVALID"): never { throw new Error(message); }
