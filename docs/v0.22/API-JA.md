# v0.22 IBC 所有者API

全操作は既存の所有者専用 `/api/` 認証、Origin検査、ロック、待機数制限を使います。外部アプリ接続の `/bridge` とは別です。AI MCP、共有ノード、接続アプリに新規権限を付与しません。金額は整数文字列または小数字符列を使い、JavaScriptの浮動小数点金額を受け付けません。

## 経路

`IbcRoute` は `schema: realdex.ibc-route.v1`、`id: ibc-...`、name、source、destination、asset、maxTransferAtomic、minTimeoutSeconds、maxTimeoutSecondsです。

source/destinationは既存`CosmosNetwork`の完全な設定、channel-N、connection-N、07-tendermint-Nを含みます。chainIdは`realdex-local-...-1`等の末尾revisionを持ち、source/destinationは異なるチェーンでなければなりません。2〜4組のloopback RPC/REST、既知checkpoint、資産・費用・確認数上限を固定します。最大16経路で、同じchainIdに矛盾した設定を登録できません。

assetはbaseDenom、originChainId、decimals、symbolです。baseDenomは限定した英数字ネイティブdenomです。外向きの受取資産は `ibc/SHA256(transfer/<destinationChannel>/<baseDenom>)`、帰路ではそのtraceを検査して元資産へ戻します。複数hop、packet memo、hooks、PFM、rate-limit等のmiddleware versionは未対応です。タイムアウトは30〜3600秒の経路内範囲、送金量はネットワーク上限と2^128−1以下です。

## HTTP POST

| パス | 入力 | 動作 |
|---|---|---|
| `ibc/routes` | `{}` | 登録一覧。送信なし |
| `ibc/routes/inspect` | `{route}` | 正規化と指紋。送信なし |
| `ibc/routes/add` | `{route,confirmation}` | `ADD IBC <fp>`確認、保存、ロック |
| `ibc/balance` | `{routeId,accountId}` | 双方のlane状態、口座残高、手数料残高 |
| `ibc/prepare` | `{routeId,accountId,payment}` | unsigned simulation、確認待ち生成 |
| `ibc/approve` | `{id,intentId,confirmation,broadcast}` | 全文確認後、署名保存。trueのときだけ初回送信 |
| `ibc/submit` | `{id,confirmation}` | 保存済み未送信レコードのみ。確認は取引ID全文 |
| `ibc/history` | `{}` | 署名と経路を検査した記録一覧 |
| `ibc/reconcile` | `{id,destinationTxHash?,settlementTxHash?}` | 元の取引・パケット・実行結果の読み取り再照合 |
| `ibc/relay-plan` | `{id}` | 公開パケット情報だけ。署名権限・秘密鍵なし |

paymentはrequestKey、receiver、feeAtomic、gasLimit、timeoutSecondsと、amountまたはamountAtomicのいずれか一方です。固定MsgTransfer、空packet memo、SIGN_MODE_DIRECTだけに限定します。所有者の確認文は `BRIDGE <receiver> TO <destinationChainId>`。署名前と初回送信前にlane、残高、sequence、期限を再照合します。

確認期限は最大60秒で、packet期限より前です。source取引自体のtimeoutHeightと、destination基準のpacket timeoutTimestampは別です。ブロック時間を検査して値を固定し、再照合で新しい期限に書き換えません。

## 保存・重複・状態

同一account/sourceNetwork/requestKeyは同一支払いとして扱います。同じキーでamount・receiver・経路・費用等が異なる場合は拒否します。署名とsequence予約を同じ暗号化書込みで保存し、送信開始前にbroadcast-unknownを保存します。保存失敗時は送信せず、結果不明の署名を自動再署名・再送しません。

report.stage: signed、source-unresolved、awaiting-receive、awaiting-ack、awaiting-refund、reported-delivered、reported-refunded、source-failed、inconsistent。

`received/refunded/completed`は厳密な観測条件を満たした場合だけtrueです。`finalityProven`、`stateProofVerified`、`eventDataAuthenticated`は常にfalseです。デスクトップの観測をオンチェーンの資金解放権限に変換しません。未解決の記録がある間、同一送信口座の通常Cosmos・authz等を含む新規署名を保留します。パケット中継者は別口座で処理できます。

型宣言: `wallet/bridge/api.d.ts`。署名済みTxRawは送信能力を持つため、公開の診断ログへ含めないでください。test fixtureにある既知の試験鍵・取引とは区別してください。
