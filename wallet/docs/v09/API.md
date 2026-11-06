# RealDEX Wallet v0.9 API追加分

詳細な認可境界・既存APIは v0.8/API.md と v0.9/SECURITY-JA.md を参照。

## 所有者専用 /api

全てPOST JSON、loopback接続、厳密Host、ウォレット自身のOrigin、所有者capabilityが必要です。以下は外部アプリやAIへ公開するものではありません。

| route | body | 挙動 |
|---|---|---|
| `/api/dex/catalog` | `{chainId}` | 所有者の契約設定を返す。RPC問合せ・自動採用なし |
| `/api/dex/quote` | `{chainId,quote:{tokenIn,tokenOut,amount,slippageBps}}` | 登録直接Pool最大16個、同一ブロック照合。予算予約・署名なし |
| `/api/dex/prepare` | `{accountId,chainId,operation}` | 所有者の承認待ち依頼を作成。署名・送信は別 |
| `/api/networks/review` | `{network}` | 既存同一chain/genesisの設定差分と期限付きdigestを返す |
| `/api/networks/replace` | `{id,digest,confirmation}` | 確認後にロック・接続停止・設定置換。署名実行中は拒否 |
| `/api/reconcile` | `{id}` | 以前に成功・失敗観測を返した取引も再照合可能 |

`amount`およびDEX数量は人が読む小数の**文字列**です。最小単位への変換はサーバー側。operationの正確なshapeは `wallet/lib/dex.mjs` と `wallet/test/dex.test.mjs` を参照。create-pool / approve / revoke / swap / add-liquidity / remove-liquidity の6種類だけです。

quoteの `highestGrossOutputPool` は追加ガス・承認費用を控除する前の順位です。`executionReady:false`、`additionalFeesIncluded:false`。照合失敗の候補はexcludedへ入れ、comparisonComplete=falseとします。30秒で失効し、利用前に再検査します。古いquoteを署名意図の代わりに渡すAPIはありません。

networkレビューの公開情報は所有者のJSONです。コードの第三者認証は常にfalse。入力JSONの署名だけから設定を昇格する処理ではありません。永続化コールバックは同期的な原子的保存を前提とする内部インターフェースです。

## AI /agent/v1/preview

同じAI Bearer token、`X-Realdex-Agent: 1`、ブラウザOrigin不可という従来の条件です。

入力: `{idempotencyKey,recipient,amountAtomic,note?}`。amountAtomicは指定資産の整数最小単位の文字列です。過去と同じキー・同じ内容なら保存済み結果、同じキー・異なる内容なら拒否。

新規のpreviewは現在の許可、残高、ガス上限、残予算、権限の有効性を再検査します。canRequest=trueは将来の予約や支払い保証ではありません。リクエスト保存・予算予約・自動ロック延長をしません。

SDK: `AgentWalletClient.preview(request)`。

MCP: `realdex_agent_status` / `realdex_agent_balance` / `realdex_agent_preview` / `realdex_agent_transfer` / `realdex_agent_result` / `realdex_agent_history` の6ツール。既存の2025-11-25/2025-06-18プロトコル交渉を維持し、最新MCP全機能への対応とは主張しません。stdio専用の限定実装です。

## 受取証の変更

`result(key,{refresh:true})` は以前に成功観測した取引も再照合します。journal reportは `realdex.settlement-observation.v1`。主な項目は `observation`, `observedAt`, `confirmations`, `policySatisfied`, `transactionReportedSuccessful`（true/false/null）, `deliveryObserved`, `reorgObserved`。

receiptの不存在やエラーでは最新の成功・受取・確認数条件を解除します。観測エラーはHTTPエラーになる場合がありますが、永続journalは更新するため、UIはfinallyで再読込します。ロックepochが変わった場合は旧処理を保存しません。AI予算やnonce予約を取り消す処理ではありません。

`lastKnownReceipt` は過去の観測摘要であって、現在の最終性ではありません。`finalityVerified:false` と `actualBalanceChangeVerified:false` を維持します。
