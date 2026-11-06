# Injective spot-order preparation (v0.26)

This adds unsigned `MsgCreateSpotLimitOrder` and `MsgCancelSpotOrder` generation.
It does NOT sign, submit, cancel a real order, verify market authenticity, estimate
actual account fees, or prove fills. No wallet authority is added.

The limit request is checked against the observed market: sender/subaccount
relationship, base-atom quantity, lot size, quote-atom/base-atom price tick, minimum
notional, and observation expiry. Human decimals are not rounded to fit a tick.
LegacyDec protobuf fields receive an additional exact 10^18 scaling, independently
of the two token decimal counts. Only ordinary BUY/SELL limit order enums are used.
The fee recipient is fixed to the supplied sender. The client order ID is stable
for (network, sender, requestKey); a different payload has a different input hash.
This is identification, NOT a completed persistent idempotency service.

GTC can rest or partially fill. The observation expiry is NOT an on-chain order
expiry. A prepared cancellation is NOT proof that the order has been cancelled.
`orderProgress` never authorizes retry, fund-reservation release or settlement.

Run the synthetic offline example: `node node/spot-order.mjs`.
Run tests: `node --test node/external/test/injective-orders.test.mjs`.

## Pinned primary specifications

- SDK message scaling: https://github.com/InjectiveLabs/injective-ts/blob/ce88885e5142a344975434f466e271fb954b285b/packages/sdk-ts/src/core/modules/exchange/msgs/MsgCreateSpotLimitOrder.ts
- Protocol: https://github.com/InjectiveLabs/injective-proto/blob/5ad1071de2529b6699efb9996563d589d51f00cf/all_protos/injective/exchange/v1beta1/exchange.proto
- Transaction types: https://github.com/InjectiveLabs/injective-proto/blob/5ad1071de2529b6699efb9996563d589d51f00cf/all_protos/injective/exchange/v1beta1/tx.proto

The independent Python test checks Decimal scaling and protobuf bytes for 16
combinations. It is not execution by Injective SDK or a live venue.

## Next vertical implementation

Authenticate the selected network and market; fetch subaccount ownership, funds,
fee rules and sequence; connect an owner-reviewed Injective-specific signer;
persist before first submission; reconcile partial fills and cancel races;
verify withdrawals on a supported public testnet. Keep all gates blocked until
those steps actually run.
