# v0.12 所有者DEX APIの追加
ローカル所有者のBearer権限とorigin検査が必要です。AIトークンでは使用できません。公開インターネットへこの署名サービスを公開しないでください。

## POST /api/dex/quote-route
```json
{
  "chainId": "31337",
  "quote": {
    "router": "0x…登録Router…",
    "pools": ["0x…1番目Pool…", "0x…2番目Pool…"],
    "tokenIn": "0x…入力ERC20…",
    "amount": "0.5",
    "slippageBps": 50
  }
}
```
上記の省略アドレスは構造説明用です。実際には20バイトのhexアドレスを指定します。入力は1〜4 Pool、循環不可、全区間のERC20が登録必須です。

応答schemaは `realdex.local-route-quote.v1`。router、pools、tokenPath、tokenIn/Out、入力/出力/最低出力の最小単位文字列、表示数量、各hop、同一blockHash、observedAt、expiresAtを返します。
`executionReady:false`、`additionalFeesIncluded:false`、`routeSearchPerformed:false`、`automaticApproval:false`。許容差はネットワークのローカル上限以下、最低出力は切上げで算出します。全hopでPoolの準備高とERC20残高が一致しない場合は保守的に拒否し、勝手なsyncや資金移動はしません。任意のトークン挙動の証明ではありません。

## POST /api/dex/prepare
既存のowner専用エンドポイントへ次のoperationを追加しました。
```json
{
  "accountId": "所有者のローカルEVM口座ID",
  "chainId": "31337",
  "operation": {
    "action": "route-swap",
    "router": "0x…登録Router…",
    "pools": ["0x…1番目Pool…", "0x…2番目Pool…"],
    "tokenIn": "0x…入力ERC20…",
    "amount": "0.5",
    "minimumOutput": "0.49",
    "recipient": "0x…受取先…",
    "ttlSeconds": 180
  }
}
```
最低受取量は実見積りとローカル許容差から決めてください。この例の0.49が常に許可される意味ではありません。数量は署名サービスで厳密に最小単位へ変換します。戻り値は承認待ちID・intent ID・確認内容であり、署名・送信・承認変更は行いません。既存 `/api/approve` で受取先を明示確認して初めて進みます。

## 署名検査
Routerの経路は `resolveLocalRoute` で1〜4 hop、登録Pool、連続したpair、重複Poolなし・重複tokenなしを検証します。全中間ERC20もcontractPinsへ追加し、署名直前のコードハッシュと桁数確認へ含めます。
ERC20の新規非ゼロ承認時は `allowance(owner,spender)` が0である必要があります。`ALLOWANCE_RESET_REQUIRED` は自動再試行せず、所有者が既存の取消操作を行う必要があることを意味します。形の不正な応答は `TOKEN_ALLOWANCE_RESPONSE_INVALID`。

## 変更しない権限
Agent MCPはstatus/balance/preview/transfer/result/historyの6ツールのままです。approve、swap、bridge、unlock、設定編集は追加しません。共有ノードも鍵や署名権を取得しません。
