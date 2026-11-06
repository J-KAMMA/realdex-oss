# RealDEX v0.25 外部現物板API

## 権限

市場・板を読むJavaScriptモジュールであり、秘密鍵・口座・ウォレット接続・注文・承認・取引送信を受け取りません。新しい署名用HTTP APIもありません。既存ノードの `/node/spot/` は静的画面で、サーバー側の任意URLプロキシではありません。

## 観測

`node/external/observer.mjs` の `observeSpot(selection, options)` を使います。

```js
import { observeSpot } from './node/external/observer.mjs';
import { quoteSpot } from './node/external/quote.mjs';

// 自分で確認した公開origin。コード内に認証情報を埋め込まないでください。
const endpoint = process.env.INJECTIVE_INDEXER_ORIGIN;
const snapshot = await observeSpot({
  provider: 'injective', network: 'injective-1', endpoint,
  marketId: process.env.SPOT_MARKET_ID,
}, { access: { mode: 'explicit-remote', allowedOrigins: [endpoint] } });

const estimate = quoteSpot(snapshot, {
  side: 'sell-base', inputAtomic: '1000000000000000000',
  // 上の投入数量はbaseDecimals=18なら1単位。メタデータを必ず確認してください。
  slippageBps: 50,
});
console.log(estimate);
```

HyperCoreは `provider:'hypercore'`, `network`, `endpoint`, `pairIndex` の4項目を使います。市場の表示名ではなく、spotMetaが返す現物ペア番号を指定します。ネットワーク名は利用者のラベルで、APIの実ネットワークを独立認証した値ではありません。

既定の板の有効期間は30秒。選択条件以外の項目は拒否し、メタデータ→板→メタデータの順で取得します。選択市場のメタデータが途中で変わった場合は拒否します。板の内容や時刻が本当であることを暗号学的に証明する機能ではありません。

## 試算

`quoteSpot(snapshot, request)` は、売りならbase資産の最小単位、買いならquote資産の最小単位を `inputAtomic` に指定します。浮動小数点の数量ではなく、10進整数文字列が必要です。`limitPrice` は人間向けのQuote/Base価格で、売りでは下限、買いでは上限です。

主な結果は以下です。

|項目|意味|
|---|---|
|`consumedInputAtomic` / `remainingInputAtomic`|板の試算で使えた投入量／残量|
|`quoteNotionalAtomic`|試算したquote側の取引元本|
|`tradingFeeQuoteAtomic`|把握した基準レートでの手数料。未知ならnull|
|`estimatedOutputAfterTradingFeeAtomic`|基準レート控除後の試算。手数料不明などではnull|
|`hypotheticalSlippageFloorAtomic`|試算額から指定率を引いた仮定値。取引に強制される最低受取ではない|
|`fullInputConsumed` / `fillStatus`|計算上の全量処理／残量や価格条件・板不足の理由|
|`actualTradingFeeVerified`|常にfalse。口座別料金や実清算を未確認|
|`additionalCostsKnown`|常にfalse。gas、入出金、bridge費用は未計算|
|`executable` / `fillGuaranteed` / `deliveredToWallet`|常にfalse|

Injectiveはindexerの基準takerFeeRateを使う参考計算です。口座別割引やatomic-order倍率などを検証しません。HyperCoreは口座情報を取得しないため、手数料と控除後出力をnullにします。買いの数量も手数料不明なら予算内の実行保証ではありません。

## 比較と取消し

`compareIndicativeQuotes(quotes)` は、正確な資産ID、桁数、残高の場所、投入量、方向、価格条件が一致し、期限内・全量・基準手数料既知・最低注文条件既知のものだけを並べます。並びは取引手数料だけの参考順位で、`netBest:null` のままです。異なるチェーンの同名トークン、ラップ資産、先物建玉、外部ウォレットでの受取と混在させません。

`createObservationSession()` の `cancel()` は、その読取り要求の結果を破棄します。既存ウォレットやチェーン上の取引を取り消す操作ではありません。価格を予約する機能もありません。

型宣言と使用例は `node/external/*.d.mts` と `node/external/test/types.mts`。ローカルHTTP試験は公式wire形式に沿った合成サーバーであり、公開Injective・HyperCoreの適合確認ではありません。
