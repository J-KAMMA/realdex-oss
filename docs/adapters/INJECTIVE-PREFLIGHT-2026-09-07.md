# INJ-03: indexer -> chain preflight -> unsigned simulation

## Fixed base and implemented path

Issue #24 continues PR #23 at f4089ba5c29990a4111e2f7715c35b9955e2810f
(tree d69ae9e369246c4c61bbb13e857413ad55084802). This adds an actual HTTP/CLI
pipeline around the existing indexer reader and unsigned-order preparation; it
does not modify the reconciler, journal, shared wallet or any signer/CI gates.
The supported chain identifier is **injective-888 (testnet) only**.

1. Read an explicitly selected Injective indexer through existing observeSpot.
2. Build the existing unsigned limit-order plan; validate public key/address.
3. Read a fresh REST block, then require the exact x-cosmos-block-height response
   on every account, market, spendable balance/deposit and simulation query.
4. Compare chain market ID/status/denoms/decimals/ticks/minimum/taker fee against
   the indexer observation. Check account identity/public key/uint64 counters.
5. Check exact spendable funds and caller-selected fee caps before simulation.
6. Construct TxBody/AuthInfo/SignDoc with account number and sequence retained as
   integers, a transaction timeout height, no memo/fee-grant/arbitrary messages.
7. POST only to /cosmos/tx/v1beta1/simulate, with exactly one empty simulation
   signature, then check reported gas and the caller's margin. Re-read the anchor
   block and reject hash/height/time changes or an expired observation.
8. Return a frozen, self-hashed owner-review document. No approval or submission.

## CLI and network disclosure

```sh
node node/spot-preflight.mjs --request /private/preflight-request.json
# Remote access additionally requires each endpoint's exact HTTPS origin:
node node/spot-preflight.mjs --request /private/preflight-request.json \
  --allow-remote https://YOUR-INDEXER-HOST --allow-remote https://YOUR-REST-HOST
```

The input contains exactly selection (provider/network/endpoint/marketId), input
(the existing requestKey/sender/subaccountId/side/quantity/limitPrice object),
endpoint (REST origin), publicKeyHex (33-byte compressed public key) and policy:

```json
{
  "gasLimit": "300000",
  "gasPriceAtomic": "500000000",
  "maxGasFeeAtomic": "150000000000000",
  "maxTradingFeeBps": 50,
  "gasMarginBps": 12500,
  "timeoutBlocks": 20,
  "maxAgeMs": 30000
}
```

These policy values are EXAMPLES, not current fee recommendations. All monetary
amounts are strings in atomic units, gas price is INJ atoms per gas. Do not put
private keys/credentials in the file. Querying reveals the public account,
subaccount, market, unsigned order and network address to chosen providers.
Local-only is the default; both origins are checked before any indexer request.
The CLI refuses duplicate/unknown flags, links and oversized/nonregular files,
prints JSON to stdout, and does not modify files or wallet state.

## Accounting and conservative restrictions

Gas reserve is ceil(gasLimit * caller gasPrice). It must be within maxGasFeeAtomic.
The maximum of current nonnegative maker/taker rates must fit maxTradingFeeBps;
no discount/rebate is used to increase spending power. Buy reserve is
ceil(limit notional) + ceil(limit notional * cap / 10000). Sell reserve is the
base quantity; fees deducted from quote proceeds are shown in quote units.
Default subaccounts use only bank SPENDABLE balance, ignoring additional exchange
funds: this may reject an otherwise affordable order, never double-counts funds.
Nondefault subaccounts use floor(exchange AVAILABLE deposit), not total balance.
When default spending and gas use INJ, both reserves are added against ONE balance.
A new account with null chain pubkey still needs a supplied valid public key whose
Ethereum-style address equals the sender. Unknown account types are rejected.
Unsupported REST envelopes/header behavior fail closed; no latest-state fallback.

## Trust limits: not a trading capability

The selected endpoint supplies all chain data and the simulation result. Equal
height/hash headers are **consistency observations, not state proofs, signature
verification, validator consensus or independent quorum authentication**. A
malicious endpoint can fabricate a consistent result. The self-hash is unkeyed.
The same-block snapshot can become obsolete immediately; mempool activity,
subsequent account sequence changes, fee changes and reorgs are not ruled out.
Signing integration MUST revalidate state, ownership, exact reviewed bytes,
permission and unresolved-transaction guards, not trust readyForOwnerReview.

Gas price is caller-selected, not a chain fee quote. A successful simulation is
not a guarantee of later inclusion, execution, fill or settlement. An order's
trading-fee cap is NOT enforced by these unsigned order messages. Transaction
expiry does NOT cancel a resting GTC order. No withdrawal/cancel/owner-signature
execution or reservation release is added in this change. All ownerApproved,
chainStateAuthenticated, signingEnabled, broadcastEnabled, executable and
settlementVerified flags remain false, with explicit blockers in each result.
Only bounded plain data is supported; JavaScript Proxy traps/hostile same-process
code, privileged filesystem races, Windows and browser CORS are not certified.

## Reproduction and evidence scope

```sh
node --test --test-reporter=tap node/external/test/injective-preflight.test.mjs
node app/ci.mjs --suite external --jobs 1 --output /new/external-evidence
node app/ci.mjs --suite all --jobs 3 --output /new/source-evidence
```

Tests use an actual loopback HTTP server and an actual child CLI process but
synthetic chain/indexer responses. Independent Python reconstructs all order/
transaction protobuf bytes and Decimal fee arithmetic from original inputs.
These are not tests against a funded live Injective account or an Injective VM.
Public testnet simulation, signing/broadcast, complete venue lifecycle and
cryptographic account/state authentication remain unverified. GitHub integration
runs other previously configured runtimes but cannot substitute for these tests.

## Primary protocol references inspected

- InjectiveFoundation/injective-core commit de8a811d4c198b2723a52453cb6b61ee6c38b931:
  proto/injective/exchange/v1beta1/query.proto (REST paths, response envelopes)
  and exchange.proto (SpotMarket, Deposit, ticks/decimals/fee fields).
- InjectiveLabs/injective-ts commit ce88885e5142a344975434f466e271fb954b285b:
  packages/sdk-ts/src/core/tx/api/TxRestApi.ts, simulate(): one empty signature
  when unsigned and POST /cosmos/tx/v1beta1/simulate.
- https://docs.injective.network/defi/transactions
- https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/tx/v1beta1/tx.proto
- https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/bank/v1beta1/query.proto

No upstream code is vendored and no package or protocol version pin is changed.

## INJ-04 real-node compatibility correction

The first real-node run against official v1.20.3-safeharbor.2 exposed three
assumptions that the original synthetic fixtures did not test. The preflight now
accepts exact `x-cosmos-block-height` OR `grpc-metadata-x-cosmos-block-height`;
when both exist, both must match the requested height. Missing/conflicting
headers still reject. It explicitly queries the v2 market API and converts human
price/quantity/notional units to the existing atom representation using exact
scaling, without guessing units from a v1 route. The review names the v2 API.

The real simulation reports the chain simulation gas meter as `gas_wanted`
(150,000,000 in the local fixture), while the signed transaction remains capped
at 1,000,000 gas. Equality between those two distinct values is no longer required.
The reported meter must cover gas used; the original user gas limit, fee cap and
gas-used margin still all apply. No caller cap is increased. Native gas charged
in the actual included transaction is checked separately in the local test.

See INJECTIVE-LOCAL-ACCEPTANCE-2026-09-07.md for real-node evidence and remaining
limitations. None of this authenticates an arbitrary public REST provider.
