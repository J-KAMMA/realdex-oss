/** Owner-only payloads. The owner capability must never be sent to an AI or dapp. */
export type EvmAddress = `0x${string}`;
export type IntegerString = `${bigint}`;
export interface SmartAccountDescriptor {
  id: string; label: string; ownerAccountId: string; chainId: IntegerString;
  genesisHash: `0x${string}`; factory: EvmAddress; address: EvmAddress; salt: `0x${string}`;
  /** Absent means the immutable legacy artifact; non-legacy registrations must bind an explicit known artifact. */
  artifactId?: string;
}
export interface Payment {
  asset: 'native' | EvmAddress; recipient: EvmAddress; amount: string;
}
export type SmartOperation =
  | {type: 'deploy'}
  | {type: 'fund'; amount: string}
  | {type: 'payments'; transfers: Payment[]; validUntil?: IntegerString}
  | {type: 'swap'; router: EvmAddress; pools: EvmAddress[]; tokenIn: EvmAddress;
     amount: string; minimumOutput: string; recipient: EvmAddress; validUntil?: IntegerString}
  | {type: 'grant-session'; sessionAccountId: string; asset: 'native' | EvmAddress;
     recipient: EvmAddress; perCall: string; daily: string; total: string; validUntil: IntegerString}
  | {type: 'session-transfer'; sessionAccountId: string; amount: string}
  | {type: 'revoke-session'; key: EvmAddress}
  | {type: 'revoke-all'}
  | {type: 'invalidate-signatures'};
export interface OwnerSmartPayloads {
  'smart/catalog': Record<string, never>;
  'smart/register/prepare': {ownerAccountId: string; chainId: IntegerString; factory: EvmAddress; salt: `0x${string}`; label: string};
  'smart/register/commit': {draftId: string; digest: string; confirm: string};
  'smart/inspect': {id: string; sessionAccountId?: string};
  'smart/prepare': {id: string; operation: SmartOperation};
  'smart/message/prepare': {id: string; message: string; validUntil: IntegerString};
  'smart/messages': Record<string, never>;
  'smart/message/verify': {messageId: string};
}
/** UTC calendar day. Budgets reset only on a new explicit owner grant, not on wallet unlock. */
export interface OnchainSessionObservation {
  key: EvmAddress; recipient: EvmAddress; token: EvmAddress; tokenCodeHash: `0x${string}`;
  perCall: IntegerString; daily: IntegerString; total: IntegerString; spent: IntegerString;
  daySpent: IntegerString; validUntil: IntegerString; day: IntegerString; epoch: IntegerString;
  generation: IntegerString; sessionNonce: IntegerString;
}
