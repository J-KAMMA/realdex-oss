import type { BridgeRoute } from "./types";

export type CctpDirection = "base-to-solana" | "solana-to-base" | "base-to-arbitrum" | "arbitrum-to-base";

export type CctpEstimate = {
  amountReceived: string;
  feeTotal: string;
  totalDebit: string;
  gasFees: Array<{ name: string; token: string; amount: string }>;
  quote: string;
  quoteExpiresAt: number | null;
};

export type CctpExecutionResult = {
  state: "pending" | "success" | "error";
  provider: string;
  steps: Array<{ name: string; state: string; txHash?: string; explorerUrl?: string; errorMessage?: string }>;
};

export const CCTP_EXECUTION_BLOCK_CODE = "CCTP_BASE_SEPOLIA_USDC_RELEASE_APPROVAL_REQUIRED";
const CCTP_EXECUTION_ENABLED = false;

export function assertCctpExecutionAvailable(): void {
  if (!CCTP_EXECUTION_ENABLED) throw new Error(CCTP_EXECUTION_BLOCK_CODE);
}

const EVIDENCE = [
  "https://developers.circle.com/cctp/concepts/supported-chains-and-domains",
  "https://developers.circle.com/cctp/references/contract-addresses",
  "https://developers.circle.com/cctp/references/solana-programs",
  "https://developers.circle.com/cctp/howtos/transfer-usdc-with-forwarding-service"
];

const BASE = {
  id: "84532",
  name: "Base Sepolia",
  family: "evm" as const,
  nativeAsset: "ETH",
  addressFormat: "EVM 20-byte hex",
  finalityLabel: "Circle CCTP finality policy"
};

const SOLANA = {
  id: "solana-devnet",
  name: "Solana Devnet",
  family: "solana" as const,
  nativeAsset: "SOL",
  addressFormat: "Solana base58 public key",
  finalityLabel: "Circle CCTP finality policy"
};

const ARBITRUM = {
  id: "421614",
  name: "Arbitrum Sepolia",
  family: "evm" as const,
  nativeAsset: "ETH",
  addressFormat: "EVM 20-byte hex",
  finalityLabel: "Circle CCTP finality policy"
};

export const CCTP_ROUTES: Record<CctpDirection, BridgeRoute> = {
  "base-to-solana": {
    id: "cctp-v2-base-sepolia-solana-devnet-usdc",
    revision: 1,
    category: "evm-to-non-evm",
    status: "disabled",
    provider: "Circle CCTP V2 + Forwarding Service",
    mechanism: "burn-mint",
    verificationModel: "issuer-attestation",
    source: BASE,
    destination: SOLANA,
    sourceEndpoint: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    destinationEndpoint: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    supportedAssets: [
      { chainId: BASE.id, assetId: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, representation: "native" },
      { chainId: SOLANA.id, assetId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6, representation: "native" }
    ],
    requiredSourceFinality: "CCTP Fast finality",
    requiredDestinationFinality: "Forwarder confirmation",
    recovery: "provider-support",
    reviewedAt: "2026-08-31T00:00:00.000Z",
    evidenceUrls: EVIDENCE
  },
  "solana-to-base": {
    id: "cctp-v2-solana-devnet-base-sepolia-usdc",
    revision: 1,
    category: "evm-to-non-evm",
    status: "disabled",
    provider: "Circle CCTP V2 + Forwarding Service",
    mechanism: "burn-mint",
    verificationModel: "issuer-attestation",
    source: SOLANA,
    destination: BASE,
    sourceEndpoint: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",
    destinationEndpoint: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    supportedAssets: [
      { chainId: SOLANA.id, assetId: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", symbol: "USDC", decimals: 6, representation: "native" },
      { chainId: BASE.id, assetId: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, representation: "native" }
    ],
    requiredSourceFinality: "CCTP Fast finality",
    requiredDestinationFinality: "Forwarder confirmation",
    recovery: "provider-support",
    reviewedAt: "2026-08-31T00:00:00.000Z",
    evidenceUrls: EVIDENCE
  },
  "base-to-arbitrum": {
    id: "cctp-v2-base-sepolia-arbitrum-sepolia-usdc",
    revision: 1,
    category: "evm-to-evm",
    status: "disabled",
    provider: "Circle CCTP V2 + Forwarding Service",
    mechanism: "burn-mint",
    verificationModel: "issuer-attestation",
    source: BASE,
    destination: ARBITRUM,
    sourceEndpoint: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    destinationEndpoint: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    supportedAssets: [
      { chainId: BASE.id, assetId: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, representation: "native" },
      { chainId: ARBITRUM.id, assetId: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6, representation: "native" }
    ],
    requiredSourceFinality: "CCTP Fast finality",
    requiredDestinationFinality: "Forwarder confirmation",
    recovery: "provider-support",
    reviewedAt: "2026-08-31T00:00:00.000Z",
    evidenceUrls: EVIDENCE
  },
  "arbitrum-to-base": {
    id: "cctp-v2-arbitrum-sepolia-base-sepolia-usdc",
    revision: 1,
    category: "evm-to-evm",
    status: "disabled",
    provider: "Circle CCTP V2 + Forwarding Service",
    mechanism: "burn-mint",
    verificationModel: "issuer-attestation",
    source: ARBITRUM,
    destination: BASE,
    sourceEndpoint: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    destinationEndpoint: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
    supportedAssets: [
      { chainId: ARBITRUM.id, assetId: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", symbol: "USDC", decimals: 6, representation: "native" },
      { chainId: BASE.id, assetId: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", decimals: 6, representation: "native" }
    ],
    requiredSourceFinality: "CCTP Fast finality",
    requiredDestinationFinality: "Forwarder confirmation",
    recovery: "provider-support",
    reviewedAt: "2026-08-31T00:00:00.000Z",
    evidenceUrls: EVIDENCE
  }
};

export function directionForFamilies(source: string, destination: string): CctpDirection | null {
  if (source === "evm" && destination === "solana") return "base-to-solana";
  if (source === "solana" && destination === "evm") return "solana-to-base";
  return null;
}

export function validateCctpAmount(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) throw new Error("Enter a USDC amount with no more than 6 decimals.");
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Amount must be greater than zero.");
  return value;
}

export function validateRecipient(direction: CctpDirection, value: string): string {
  const recipient = value.trim();
  if (direction !== "base-to-solana" && !/^0x[a-fA-F0-9]{40}$/.test(recipient)) throw new Error("Enter a valid EVM recipient address.");
  if (direction === "base-to-solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(recipient)) throw new Error("Enter a valid Solana recipient address.");
  return recipient;
}

export function canRequestCctpQuote(direction: CctpDirection | null, amount: string, recipient: string): boolean {
  if (!direction) return false;
  try { assertCctpExecutionAvailable(); validateCctpAmount(amount); validateRecipient(direction, recipient); return true; }
  catch { return false; }
}

export type CctpBrowserProviders = {
  ethereum?: unknown;
  solana?: unknown;
  phantom?: { solana?: unknown };
};

function browserProviders(): CctpBrowserProviders {
  return window as unknown as CctpBrowserProviders;
}

async function createSourceAdapter(direction: CctpDirection, selectedProviders?: CctpBrowserProviders) {
  const providers = selectedProviders ?? browserProviders();
  if (direction !== "solana-to-base") {
    const provider = providers.ethereum;
    if (!provider) throw new Error("An EIP-1193 wallet is required for Base Sepolia.");
    const { createViemAdapterFromProvider } = await import("@circle-fin/adapter-viem-v2");
    return createViemAdapterFromProvider({
      provider: provider as Parameters<typeof createViemAdapterFromProvider>[0]["provider"],
      capabilities: { addressContext: "user-controlled" }
    });
  }

  const provider = providers.phantom?.solana ?? providers.solana;
  if (!provider) throw new Error("A Solana Wallet Standard provider is required for Solana Devnet.");
  const { createSolanaKitAdapterFromProvider } = await import("@circle-fin/adapter-solana-kit");
  return createSolanaKitAdapterFromProvider({
    provider: provider as Parameters<typeof createSolanaKitAdapterFromProvider>[0]["provider"],
    capabilities: { addressContext: "user-controlled" }
  });
}

function bridgeParams(direction: CctpDirection, adapter: Awaited<ReturnType<typeof createSourceAdapter>>, amount: string, recipient: string, quote?: string) {
  const chains: Record<CctpDirection, { from: "Base_Sepolia" | "Solana_Devnet" | "Arbitrum_Sepolia"; to: "Base_Sepolia" | "Solana_Devnet" | "Arbitrum_Sepolia" }> = {
    "base-to-solana": { from: "Base_Sepolia", to: "Solana_Devnet" },
    "solana-to-base": { from: "Solana_Devnet", to: "Base_Sepolia" },
    "base-to-arbitrum": { from: "Base_Sepolia", to: "Arbitrum_Sepolia" },
    "arbitrum-to-base": { from: "Arbitrum_Sepolia", to: "Base_Sepolia" }
  };
  const { from: fromChain, to: toChain } = chains[direction];
  return {
    from: { adapter, chain: fromChain },
    to: { chain: toChain, recipientAddress: recipient, useForwarder: true as const },
    amount,
    token: "USDC" as const,
    config: { transferSpeed: "FAST" as const, feePayment: "source" as const, batchTransactions: false },
    quote
  };
}

export async function estimateCctp(direction: CctpDirection, amountInput: string, recipientInput: string, providers?: CctpBrowserProviders): Promise<CctpEstimate> {
  assertCctpExecutionAvailable();
  const amount = validateCctpAmount(amountInput);
  const recipient = validateRecipient(direction, recipientInput);
  const [{ BridgeKit }, adapter] = await Promise.all([import("@circle-fin/bridge-kit"), createSourceAdapter(direction, providers)]);
  const kit = new BridgeKit({ disableErrorReporting: true });
  const estimate = await kit.estimate(bridgeParams(direction, adapter, amount, recipient));
  if (!("quote" in estimate)) throw new Error("Circle did not return a signed receive-exact quote.");
  return {
    amountReceived: estimate.amountReceived,
    feeTotal: estimate.feeTotal,
    totalDebit: estimate.totalDebit,
    gasFees: estimate.gasFees.map((fee) => ({ name: fee.name, token: fee.token, amount: fee.fees?.fee ?? "Unavailable" })),
    quote: estimate.quote,
    quoteExpiresAt: estimate.quoteExpiry.mode === "TIMESTAMP" ? estimate.quoteExpiry.expiresAt * 1000 : estimate.quoteExpiry.blockEstimatedAt ? estimate.quoteExpiry.blockEstimatedAt * 1000 : null
  };
}

export async function executeCctp(direction: CctpDirection, amountInput: string, recipientInput: string, quote: string, providers?: CctpBrowserProviders, onProgress?: (result: CctpExecutionResult) => void): Promise<CctpExecutionResult> {
  assertCctpExecutionAvailable();
  const amount = validateCctpAmount(amountInput);
  const recipient = validateRecipient(direction, recipientInput);
  if (!quote) throw new Error("A fresh signed quote is required.");
  const [{ BridgeKit }, adapter] = await Promise.all([import("@circle-fin/bridge-kit"), createSourceAdapter(direction, providers)]);
  const kit = new BridgeKit({ disableErrorReporting: true });
  const provider = kit.providers[0]?.name;
  if (typeof provider !== "string" || !provider || provider.length > 200) throw new Error("CCTP_PROVIDER_IDENTITY_INVALID");
  const burnHandler = (payload: unknown) => { const progress = cctpBurnProgressFromEvent(payload, provider); if (progress) onProgress?.(progress); };
  kit.on("burn", burnHandler);
  try {
    const result = await kit.bridge(bridgeParams(direction, adapter, amount, recipient, quote));
    return {
      state: result.state,
      provider: result.provider,
      steps: result.steps.map((step) => ({ name: step.name, state: step.state, txHash: step.txHash, explorerUrl: step.explorerUrl, errorMessage: step.errorMessage }))
    };
  } finally {
    kit.off("burn", burnHandler);
  }
}

export function cctpBurnProgressFromEvent(value: unknown, provider: string): CctpExecutionResult | undefined {
  if (!isPlainObject(value) || value.protocol !== "cctp" || value.version !== "v2" || value.method !== "burn" || !isPlainObject(value.values) || typeof provider !== "string" || !provider || provider.length > 200) return undefined;
  const step = value.values;
  if (typeof step.name !== "string" || step.name.trim().toLowerCase() !== "burn" || step.state !== "success" || typeof step.txHash !== "string" || !validCctpTransactionId(step.txHash) || (step.explorerUrl !== undefined && (typeof step.explorerUrl !== "string" || !isHttpsUrl(step.explorerUrl))) || (step.errorMessage !== undefined && (typeof step.errorMessage !== "string" || step.errorMessage.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(step.errorMessage)))) return undefined;
  return { state: "pending", provider, steps: [{ name: step.name, state: step.state, txHash: step.txHash, explorerUrl: step.explorerUrl, errorMessage: step.errorMessage }] };
}

function validCctpTransactionId(value: string): boolean { return /^0x[0-9a-f]{64}$/i.test(value) || /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(value); }
function isHttpsUrl(value: string): boolean { try { return new URL(value).protocol === "https:"; } catch { return false; } }
function isPlainObject(value: unknown): value is Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null; }
