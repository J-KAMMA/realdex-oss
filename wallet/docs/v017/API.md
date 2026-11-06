# v0.17 Cosmos owner API

既存の所有者URL、Origin、Bearer capability、本文サイズ、要求数、ロック世代検査を共用します。公開のsharing node、bridge session、agent/MCPにこのAPIは追加しません。秘密鍵の出力、任意のProtobuf署名、任意のRPCプロキシではありません。

## 設定

`POST /api/non-evm/cosmos-online/networks/add`

```json
{"network":{"family":"cosmos","id":"cosmos:realdex-local-dev","name":"My local Cosmos","chainId":"realdex-local-dev","hrp":"cosmos","endpoints":[{"rpcUrl":"http://127.0.0.1:26657/","restUrl":"http://127.0.0.1:1317/"},{"rpcUrl":"http://127.0.0.1:26658/","restUrl":"http://127.0.0.1:1318/"}],"checkpoint":{"height":1,"hash":"REPLACE_WITH_VERIFIED_64_HEX_HASH"},"denom":"stake","decimals":6,"symbol":"SIM","feeDenom":"stake","feeDecimals":6,"maxTransferAtomic":"100000000","maxFeeAtomic":"10000","maxGasLimit":"500000","timeoutBlocks":20,"minConfirmations":1,"broadcastEnabled":false},"confirmation":"ADD cosmos:realdex-local-dev REPLACE_WITH_VERIFIED_64_HEX_HASH"}
```

上記hashはプレースホルダーなのでそのまま受理されません。接続設定は最大8件、endpointは2〜4組。既存IDの上書きはありません。設定適用はロック前提、保存が不確定なら再起動が必要です。`denom`/`feeDenom`は3〜64文字の英数字によるnative denominationに限定します。IBCのdenom traceやCW20などは受理しません。

## 残高と確認依頼

`POST /api/non-evm/cosmos-online/balance`:
`{"accountId":"uuid","networkId":"cosmos:realdex-local-dev"}`

`POST /api/non-evm/cosmos-online/prepare`:
`{"accountId":"uuid","networkId":"cosmos:realdex-local-dev","payment":{"requestKey":"invoice-unique-id","to":"cosmos1...","amount":"1.25","feeAtomic":"500","gasLimit":"200000","memo":"optional"}}`

`amount`は表示桁数に従う小数字列。代わりに`amountAtomic`を指定できますが併用は拒否します。原子的数量、fee、gasは整数文字列。受取先は既存の標準BaseAccount限定です。自身への送金を拒否します。

返却されたid、intentId、summaryはまだ署名ではありません。既存の`POST /api/non-evm/approve`へ `id, intentId, confirmation:受取先全文, broadcast:boolean` を渡すと、初めて所有者確認・署名・保存へ進みます。承認は同じ所有者APIのみです。

## 初回送信と履歴

`POST /api/non-evm/cosmos-online/submit`: `{"id":"record-id","confirmation":"TX_HASH_FULL_UPPERCASE_HEX"}`。

署名だけ保存したstate=signedの記録について、登録設定が一致し送信許可がある場合のみ初回送信します。broadcast-unknownやbroadcastからの再送は拒否します。

`POST /api/non-evm/cosmos-online/reconcile`: `{"id":"record-id"}`。

保存済み取引だけを読み取り照合します。自動再送・再署名はありません。結果stateは signed / broadcast-unknown / broadcast / reported-confirmed / reported-reverted。観測には日時・理由を付け、finalityProvenは常にfalseです。

`POST /api/non-evm/history` は既存の共通履歴です。所有者以外に公開しません。

## 読み取り・照合

CometBFT JSON-RPCでは `status`, `block`, `tx(prove=true)` のみを使用します。SDK RESTではBaseAccount、spendable_balance、zero-signature Simulate、BROADCAST_MODE_SYNCに限定します。状態取得には固定した高さを付け、返信のX-Cosmos-Block-Height不一致・欠落を拒否します。RPC返信は上限1MiB、深さ32、ノード数20,000のパーサーで、数値の丸めや同名JSONメンバーの上書きを許しません。

包含照合は、保存したTxRawから取引ハッシュとMerkle leafを再計算し、auntsとrootを検証します。ただし返却headerのhashを独立再計算せず、投票・validator set・状態証明も検証しません。`inclusionVerified=true`は返されたdata_hashに対する包含を意味するだけです。`headerHashVerified`、`stateProofVerified`、`balanceDeltaVerified`はfalseで、アプリがこれらをtrueとして保存しようとすると拒否します。

費用欄は署名で指定したfeeです。実行失敗時のfee処理を、未知のSDKチェーン全般について証明するものではありません。今回の実simd試験では正常送金時の実残高差分と一致を確認しています。

型宣言: `wallet/non-evm/cosmos-api.d.ts`。AI API・任意署名関数は追加しません。
