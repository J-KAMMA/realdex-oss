# v0.13 所有者専用の非EVM API

すべて同じPCのウォレットHTTPサーバーのPOST `/api/non-evm/...` です。厳密なHost・Originと所有者capabilityが必要です。`Content-Type: application/json`、`Authorization: Bearer <owner capability>`。AIのMCPトークン、アプリ接続session、共有ノード鍵は使えません。所有者トークンをAIへ渡さないでください。

| 末尾 | 入力 | 内容 |
|---|---|---|
| `networks/add` | network, confirmation | local Solana設定の明示追加。保存前ロック |
| `history` | 空オブジェクト | 暗号化履歴の所有者向け読み取り。署名付きデータを含む |
| `solana/balance` | accountId, networkId | RPC観測のSOL残高 |
| `solana/prepare` | accountId, networkId, payment | 未署名シミュレーション後、所有者承認待ちを作成 |
| `approve` | id, intentId, confirmation, broadcast | 最終再検査、署名、永続化。SOLのみ任意の初回送信 |
| `solana/submit` | id, confirmation | state=signedの保存済み署名を初回送信。confirmationは完全な署名ID |
| `solana/reconcile` | id | 状態を再照合するだけ。再署名・再送しない |
| `icp/prepare` | accountId, payment | ICRC-1オフライン署名要求を準備 |

## SOLのpayment

```json
{"requestKey":"invoice-001","to":"YOUR_BASE58_RECIPIENT","amount":"0.001"}
```

`amount` の代わりに整数文字列 `lamports` も受け付けます。両方を同時に指定できません。指数表記、負数、9桁を超える小数、JSON浮動小数点でのamount指定は拒否します。JSON-RPCから安全整数の範囲を超えた金額が返る場合も、丸めて続行せず拒否します。

prepareが `alreadyRecorded:true` を返すときは以前の署名済み記録です。承認待ちや新規署名は作りません。結果不明の場合は別キーに変更せず、同じ記録を照合してください。

承認の `confirmation` は完全な受取先です。`broadcast` は必須booleanです。SOLだけtrueを許可し、ネットワーク設定で送信有効の場合に限ります。署名だけ保存して後から送る場合のsubmitでは、保存済み署名IDを完全一致させます。送信済み／結果不明を再送するAPIは追加していません。

## ICPのpayment

```json
{
  "requestKey":"icp-invoice-001",
  "networkId":"icp:local-development",
  "ledger":"YOUR_LEDGER_CANISTER_ID",
  "to":{"owner":"RECIPIENT_PRINCIPAL"},
  "amountAtomic":"100000",
  "feeAtomic":"10000"
}
```

任意の `fromSubaccount`、`to.subaccount`、`memoHex` は64桁hexです。省略subaccountはゼロ。省略memoは初回にランダム32バイトを生成して記録します。数量・手数料は手動の最小単位整数（実装上256bitまで）です。ICPのapproveで `broadcast:true` を指定すると拒否します。

`created_at_time`、memo、呼出先・引数・caller・署名を固定保存します。鍵の変更、生成されたmemoの差替え、失敗したから時刻を変えて再送といった機能は提供しません。履歴から出力した署名付き要求には資産を動かす権限があるため、秘密情報として扱ってください。

## 状態と保証

`nonEvmJournal` はEVMのjournalと別の任意フィールドで、最大128件。保存制限に達したら拒否します。暗号化容量制限も適用され、削除・自動圧縮による履歴消失は行いません。

SOL: `signed` → `broadcast-unknown`（送信前に保存）→ `broadcast`。再照合結果は `reported-finalized` / `reported-reverted` / 未解決です。成功の観測が消えれば撤回します。`signed`記録を読み取り照合して未観測だった場合はsignedのままです。

ICP: `signed` のみで、ネットワーク送信はありません。

`/api/status` の新しい `nonEvmCapabilities` で系統別能力を返します。旧来の曖昧な `icpSolanaSubmission` 合成フラグは返さなくなりました。Solanaの能力trueはローカルSOLのみで、公開チェーン／SPL／swapを意味しません。`agentSubmission:false` は今回の非EVM機能についてです。既存のEVM限定AI送金を変更したものではありません。

内部コードのプロパティやネットワーク観測を証明書と混同しないでください。保管庫を操作できる同一OS利用者やマルウェアへのサンドボックス化は別課題です。
