# v0.14 Owner-only API additions

All routes require the existing in-memory owner capability and same-origin loopback HTTP. These are NOT bridge routes or AI/MCP methods. Ordinary service start needs no npm dependencies. See `expanded-api.d.ts` for payload types.

| Route | Body | Action |
|---|---|---|
| `/api/non-evm/spl/accounts` | networkId, owner, mint | Read existing classic token accounts. No signing |
| `/api/non-evm/spl/prepare` | accountId, networkId, payment | Verify registered mint/accounts, simulation, fee, create immutable owner request |
| `/api/non-evm/bitcoin/prepare` | accountId, payment | Regtest P2WPKH plan only |
| `/api/non-evm/cosmos/prepare` | accountId, payment | Local standard SDK MsgSend plan only |
| `/api/non-evm/stellar/prepare` | accountId, payment | Standalone XLM Payment plan only |
| `/api/non-evm/aptos/prepare` | accountId, payment | Chain 4 native transfer plan only |
| `/api/non-evm/approve` | id, intentId, confirmation, broadcast | Exact recipient confirmation; offline families MUST have broadcast=false |
| `/api/non-evm/history` | empty | Read owner records |
| `/api/non-evm/solana/submit` | id, confirmation=signature | Explicit first-send for saved SOL or SPL; exact immutable bytes |
| `/api/non-evm/solana/reconcile` | id | Read and bind reported outcome; no automatic resend |

SPL `payment` fields: requestKey, mint, source, destination, to, and exactly one of amount (decimal string) or amountAtomic (integer string). `to` is the recipient token account's internal owner, not the token account address. Network splTokens is at most 64 entries, each {mint,symbol,decimals,maxTransferAtomic}. Tokenkeg only, decimals 0..18. Data-decode and u64 amount paths preserve token amounts above JavaScript's safe integer range. Native SOL/metadata JSON still reject unsafe numeric integers.

Offline payment schemas are given in QUICKSTART-JA.md and `wallet/non-evm/expanded-api.d.ts`. All require acknowledgeUnverifiedState=true. Bitcoin is native SegWit P2WPKH, SIGHASH_ALL, no RBF or PSBT import. Cosmos is SIGN_MODE_DIRECT, one standard MsgSend and standard compressed secp256k1 account derivation (not Ethermint). Stellar uses TransactionV1, one native Payment, one signature, PRECOND_TIME. Aptos uses legacy Ed25519 TransactionAuthenticator and a fixed EntryFunction payload; rotated accounts, arbitrary Move calls, multiagent and sponsored transactions are not supported.

All operations are retained in the existing encrypted nonEvmJournal. A duplicate request key with different normalized content fails. Bitcoin outpoints and Cosmos/Stellar/Aptos sequence keys already present in that journal cannot be signed again. Reservations are not globally enforced and do not make rollback/cross-device signing safe.

`node wallet/non-evm/verify-export.mjs --input FILE` verifies signature/content without secrets or RPC. It does not authenticate the wallet owner or validate current chain state. Export formats: raw Bitcoin witness transaction, Cosmos TxRaw base64, Stellar envelope XDR base64, Aptos signed transaction BCS hex. The existing ICP envelope format is unchanged. Do not distribute signed artifacts as harmless logs.
