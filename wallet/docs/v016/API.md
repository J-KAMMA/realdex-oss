# RealDEX v0.16 — Owner-only account-chain API

These endpoints belong to the existing owner loopback WalletServer. An owner capability plus the allowed same origin is required. No additional dapp, shared-node or MCP/agent permission is granted. Never put the owner capability in model prompts or pass it to an agent.

## Configuration
`POST /api/non-evm/account-online/networks/add`

Body: `{network, confirmation}`. Confirmation is `ADD <network.id> <network.checkpoint.hash>`. Only a new unique profile can be added; two profiles maximum. Adding locks the vault and invalidates old approvals. A settings save failure requires process restart.

Schema is validated by `account-network.mjs` and described by `account-api.d.ts`. IDs are `stellar:standalone` and `aptos:local-4`. Stellar's passphrase is exactly `Standalone Network ; February 2017`. Aptos chain ID is exactly 4. RPC URLs are distinct, explicit 127.0.0.1 HTTP endpoints with a port, `/` for Stellar and `/v1/` for Aptos. Redirects, query/fragment/auth on base URLs, DNS names, remote HTTPS and unknown fields are rejected. A nonzero checkpoint at height >=1 is mandatory.

`maxTransferAtomic`, `maxFeeAtomic` are decimal integer strings. `broadcastEnabled` is a boolean. `minConfirmations` is 1..100. This is a local policy, not an on-chain spending restriction.

## Balance and review
`POST /api/non-evm/account-online/balance`: `{accountId, networkId}`.
Returns native balance, sequence, head, exact decimals, observation time and `finalityProven:false`. Stellar also exposes reserve and liabilities in its account projection.

`POST /api/non-evm/account-online/prepare`: `{accountId, networkId, payment}`.
Stellar payment: `{requestKey, to, amount, feeAtomic, memo?}`.
Aptos payment: `{requestKey, to, amount, maxGasAmount, gasUnitPrice}`.
`amount` is a decimal string in XLM (7 places) or APT (8 places). API callers may instead use `amountAtomic`, never both. The service parses without floating-point rounding. `requestKey` is 1..80 ASCII alphanumeric/underscore/hyphen characters.

The service fills sequence and 180-second transaction expiry from the checked view. Aptos sequence is the current sequence; Stellar uses current sequence +1. The unsigned Aptos simulation contains a zero signature. No actual signature or transaction submission occurs at review.

Returns approval `{id, intentId, summary}` or `{alreadyRecorded:true, record, submittedAgain:false}` for an identical saved request. Intent binds the account, recipient, amounts, caps, profile fingerprint, checkpoint, sequence and expiry. The stable idempotency hash intentionally does not change with newly observed sequence or expiry. Changing the user's payment fields for the same request key is rejected.

## Owner approval and initial submission
`POST /api/non-evm/approve`: `{id, intentId, confirmation, broadcast}`.
Confirmation must exactly equal the recipient shown in the review. `broadcast` defaults to false in the UI and is mandatory as a boolean at the API. True additionally requires the profile to permit submission. Existing vault lock, backup verification and persisted-sequence reservation checks remain mandatory.

`POST /api/non-evm/account-online/submit`: `{id, confirmation}`.
Only the initial submission of a `signed` online record is allowed. Confirmation must exactly equal the saved transaction ID. Rechecks use the original signed transaction; no automatic re-signing, expiry change or different sequence is allowed.

Before any real signature bytes leave the process, the controller durably records `broadcast-unknown`. Only endpoint 0 receives the initial submission. Other endpoints are for agreement checks, not hidden failover broadcasting. A reply or timeout does not prove receipt. Post-send write failures lock the vault; a restart/reopen preserves the already-saved unknown state.

## Reconciliation
`POST /api/non-evm/account-online/reconcile`: `{id}`.
Reads only. Checks the saved signature, network fingerprint and chain-specific receipt. A previously observed receipt that disappears or becomes inconsistent loses its received display. Durable signature/sequence reservations remain.

States: `signed`, `broadcast-unknown`, `broadcast`, `reported-confirmed`, `reported-reverted`.
Reported-confirmed is an observation, never a consensus/finality proof.
Every report sets `assurance: "RPC observation only; no consensus/finality proof"` and `finalityProven:false`.

Stellar binds raw envelope, result XDR, source, consumed sequence, fees, one native-payment operation and ledger; `balanceDeltaVerified:false`.
Aptos binds Ed25519 signature/public key, fixed entry function, all arguments/fee limits, version/hash mapping, and historical account/coin-view balances and sequence at version-1/version; `balanceDeltaVerified:true` only when those RPC deltas match. Extra storage refunds, unavailable/pruned history or other deviations remain unknown rather than being guessed.

`reported-reverted` requires an observed included failed transaction and the configured confirmation threshold. It does not refund fees or erase consumed sequence reservations.

## Scope exclusions
No trustline creation, Stellar account creation, Soroban, muxed addresses, fee bumps, multi-signature, arbitrary Aptos functions, rotated keys, arbitrary assets, automatic resend, replace/cancel/unlock-reservation operation, independent state proof, public chain support or AI authority is added.

The synthetic test fixture verifies real signatures but implements ledger state changes in JavaScript. It is not Stellar Core or Aptos VM.
