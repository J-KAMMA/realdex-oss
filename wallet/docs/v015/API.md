# v0.15 owner-only Bitcoin API

既存の所有者URL、Bearer capability、Origin/Host、JSON body、サイズ制限を使用します。AI/MCP/dappには公開しません。秘密鍵、Cookie内容、任意RPC URLを送金要求の引数にしません。型宣言は `wallet/non-evm/bitcoin-api.d.ts`。

| POST /api/ 以下 | 入力 | 動作 |
|---|---|---|
| non-evm/bitcoin-online/networks/add | network, confirmation | 設定を検査。`ADD bitcoin:regtest <checkpointHash>`を確認し、保存前にロック |
| non-evm/bitcoin-online/utxos | accountId, networkId | 自口座を走査。未使用状態、成熟、予約を表示。署名・予約なし |
| non-evm/bitcoin-online/prepare | accountId, networkId, payment | UTXO等を照合し60秒の承認要求を作る。署名・予約なし |
| non-evm/approve | id, intentId, confirmation, broadcast | 既存共通API。受取先全文確認、再検査、署名・暗号化保存、明示許可時のみ初回送信 |
| non-evm/bitcoin-online/submit | id, confirmation | 保存記録がsignedの場合だけtxid全文確認して初回送信 |
| non-evm/bitcoin-online/reconcile | id | 保存した取引の状態を読み取り再照合。送信なし |
| non-evm/history | {} | 既存の所有者履歴。公開用・AI用ログではない |

paymentは `requestKey`, `to`, `feeAtomic`, `maxFeeRateSatVb`, `utxos` と `amount`（BTC小数文字列）または `amountAtomic`（satoshi整数文字列）の一方だけです。入力はtxid、vout、amountAtomic、scriptHex。ネットワーク・送信者・お釣りはサーバーが固定します。

例（値は形式例。実在する自分のregtest UTXOに置き換えない限り署名できません）:

```json
{
  "accountId": "wallet-account-id",
  "networkId": "bitcoin:regtest",
  "payment": {
    "requestKey": "invoice-001",
    "to": "bcrt1-recipient-address",
    "amount": "0.001",
    "feeAtomic": "1000",
    "maxFeeRateSatVb": "50",
    "utxos": [{"txid":"64-lowercase-hex","vout":0,"amountAtomic":"200000","scriptHex":"0014-own-pubkey-hash"}]
  }
}
```

主な状態: signed、broadcast-unknown、broadcast、reported-confirmed。最後も独立した最終確定の証明ではありません。reportに観測時刻・確認数・ブロック・Merkle inclusion・receivedを保持し、PoW合意を証明したとは返しません。

重複キー・同内容は元の記録を返し、再送しません。キー同じ・内容異なる場合はPAYMENT_KEY_CONTENT_CONFLICT。別キーでも署名に使用した入力はBITCOIN_OUTPOINT_ALREADY_RESERVED。旧offline記録のonline転用はBITCOIN_ONLINE_RECORD_REQUIRED。broadcast-unknown等の再送はBITCOIN_REBROADCAST_NOT_IMPLEMENTED。

設定指紋にはCookieファイルパス・URL・確認数・上限・送信可否も含みます。変更でBITCOIN_RECORD_NETWORK_CHANGEDとなり、暗黙に移行しません。同一Coreへ二つの入口を設定しても独立証拠とは表現しません。
