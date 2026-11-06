# RealDEX Agent Wallet v0.8 API

Local experimental interface; not ERC-7715, ERC-4337, an on-chain permission, or a custody service. No private key or generic signing endpoint is provided. JSON decimal strings are mandatory for atomic monetary amounts.

## AI HTTP

Endpoint: `http://127.0.0.1:8790/agent/v1/{method}`. Use POST with `Content-Type: application/json`, `Authorization: Bearer <agent capability>`, and `X-RealDEX-Agent: 1`. No browser Origin or CORS. Maximum body 16 KiB. Token creation/activation is owner-only. Never send the UI startup capability here.

| Method | Body | Result / side effects |
|---|---|---|
| status | `{}` | This grant, public account, local unlock expiry; no wallet secrets |
| balance | `{}` | Granted asset and native gas balance; RPC observation |
| transfer | `{idempotencyKey, recipient, amountAtomic, note?}` | Reserve; validate; manual queue or explicitly authorized bounded auto |
| result | `{idempotencyKey, refresh?: boolean}` | Durable result. Optional read-only receipt observation; never signs/rebroadcasts |
| history | `{}` | This grant's requests only; no raw signed bytes |

Unknown fields fail closed. Chain, account, asset, gas, calldata, allowance, price, recipient list and permission changes are not parameters accepted by `transfer`. The client may only select an already allowed recipient and an in-budget atomic amount.

All responses use coded errors without echoing secrets. An error or truncated response after `transfer` is not proof no payment was made. Query the original idempotency key. Avoid logging addresses/amounts when sensitive, even though they are not signing keys.

Rate limits: 60 agent operations/minute per policy, separate global agent request bucket, max four in-flight preparation/read calls. Exceeding a read limit does not grant any signing authority. Owner emergency controls have a separate path from ordinary rate quota.

## Owner-only additions

All owner endpoints retain exact-origin and owner capability checks. AI tokens cannot invoke them.

- `transfers/prepare {accountId, chainId, transfer:{asset,recipient,amount}}` — exact decimal conversion on signer side; produces review, no signature.
- `transfers/balance {accountId,chainId,asset}` — selected token and gas balances.
- `transfers/receive {accountId,chainId,asset,amount?}` — chain-qualified ERC-681 subset URI.
- `transfers/parse-uri {chainId,uri}` — validated transfer form only.
- `agents/prepare {policy}` — bound preview digest and 60-second confirmation draft.
- `agents/create {draftId,digest,confirmation}` — commit permission and return fresh token once after latest backup verification.
- `agents/activate {id,confirmation}` — replace old capability; preserve consumed budget; revoked/expired grants cannot activate.
- `agents/revoke {id}` — permanently revoke this grant.
- `agents/stop {}` — deactivate all grants; explicit owner action needed for a fresh capability.
- `agents/cancel {requestId}` — only unsigned requests may release reservations.
- `agents/history {}` — owner view of all grants' requests.

Existing owner review, lock, encrypted backup/restore, journal/reconciliation and same-bytes rebroadcast remain. A manual agent request is a distinct local pending approval; the ordinary dapp bridge cannot approve it.

## Policy input

Required fields: `label, accountId, chainId, asset, recipients, mode, expiresAt, limits`. Asset is `native` or an explicitly configured ERC20 address. `mode` is `manual` or `auto`; owner UI defaults to manual. `expiresAt` is integer Unix milliseconds, at most seven days from creation.

`limits` contains six positive uint256 decimal strings: `perTransferAtomic, rolling24hAtomic, lifetimeAtomic, perTxFeeWei, rolling24hFeeWei, lifetimeFeeWei`, with per ≤ rolling ≤ lifetime. `maxTransfers` is integer 1–512; `minIntervalMs` integer 0–86400000. Recipients must be unique nonzero addresses, max16; self-transfer is denied.

The normalized policy includes genesis hash and a fingerprint of the full network configuration. Changing RPCs, token pins, fee settings etc invalidates the old grant until an appropriate new grant is reviewed. These are local checks, not new data in the EVM signature.

## Durable states and counting

```
reserved → awaiting-approval → signed
    └───────────┴────────→ failed-before-sign / cancelled
```

Signature state and broadcast state are separate. A signed request references exactly one journal record. `signed`, `broadcast-unknown`, `broadcast`, `reported-confirmed`, and `reported-reverted` are all charged. Amount is the requested transfer quantity; gas is the signed transaction's maximum execution fee, not an automatically reconciled actual fee.

While unsigned, the full configured perTx fee is reserved. Pending reservations never disappear from rolling usage merely because they are old. At signing, the actual signed maximum fee replaces this reservation in the same atomic encrypted commit as the signature and nonce record. Lifetime usage always includes signed requests; the rolling window uses signing time, not the later on-chain settlement time.

A repeated request with the same key and canonical body returns the previous result without executing again. A different body under the same key fails. Scope is one policy. New keys or newly owner-created grants are not globally deduplicated invoices.

`result(...,{refresh:true})` only checks a stored signed transaction belonging to this grant. Missing receipt is `not-found-does-not-prove-failure`. A successful RPC receipt can include `receiptObservation` with `transactionReportedSuccessful`, matching Transfer event fields, and always `actualBalanceChangeVerified:false, finalityVerified:false`. Token event logs are not certified state changes.

## MCP

`node wallet/agent/mcp.mjs` implements newline JSON-RPC over stdio, five tools, `initialize`, `ping`, `tools/list`, `tools/call`; protocol versions 2025-11-25 and 2025-06-18. Tool names correspond to `realdex_agent_` plus HTTP method above. Tool arguments never carry the API capability; the process reads `REALDEX_AGENT_TOKEN` and supplies it to the local HTTP client. `REALDEX_WALLET_URL` optionally changes the loopback origin.

No Streamable HTTP MCP server, OAuth, model sampling, prompts, filesystem resources or general shell tools are implemented. Standard output contains protocol messages only. Overlong lines (>16KiB) and >32 concurrent protocol requests are rejected. No state-changing tool invocation is accepted as a notification without request ID.

Tool annotations are descriptive hints, not access control. A host with the token can call the local API directly but gets the same signer-side checks. A host with full OS access or the owner UI capability is a different, stronger threat outside this policy boundary.
