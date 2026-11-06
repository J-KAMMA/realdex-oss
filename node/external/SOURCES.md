# 外部現物板アダプターの一次資料

確認日: 2026-09-06。コードやwire schemaの参照元であり、公開APIとの相互運用を実測した記録ではありません。

1. InjectiveLabs公式protobuf。Market, MarketRequest, OrderbookV2, PriceLevel, TokenMetaとfield番号・uint64/sint32/sint64を照合。
   https://github.com/InjectiveLabs/injective-proto/blob/5ad1071de2529b6699efb9996563d589d51f00cf/all_protos/exchange/injective_spot_exchange_rpc.proto
2. Injective公式SDKのchain/human price conversion。価格はquoteDecimals-baseDecimals、数量はbaseDecimalsで換算。
   https://github.com/InjectiveLabs/injective-ts/blob/ce88885e5142a344975434f466e271fb954b285b/packages/sdk-ts/src/utils/numbers.ts
   https://docs.injective.network/developers/concepts/calculation-min-price-tick-size
3. Injective公式のIndexer読取り手順。
   https://docs.injective.network/developers-native/query-indexer/spot
4. gRPC-Webのフレーミング・最終トレーラ・status。今回のクライアントは非圧縮binary unaryのみ。
   https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md
5. Hyperliquid公式Python SDK。spotMetaのtoken indexとpair mapping、/info type:l2Bookを照合。
   https://github.com/hyperliquid-dex/hyperliquid-python-sdk/blob/2fdb18f9517675ea03695a0962bd19eece9c83f0/hyperliquid/info.py
6. Hyperliquid公式のtick/lot条件。spotのMAX_DECIMALS=8、サイズのszDecimalsと価格の5桁制限・整数例外。
   https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/tick-and-lot-size

## 今回の独自実装上の限定

価格・金額の演算は自作の有理数/BigInt処理。Python Fractionとprotobufによる独立fixtureを併用。
Injectiveはindexerの基準takerFeeRateを使う参考計算で、atomic market orderの倍率や口座別割引・実約定時の精算を検証していない。
HyperCoreは口座情報を取得しないため実手数料は不明のまま。両系統とも数量・価格・最小notionalを表示するが注文送信はしない。
公開endpointの稼働・本当のネットワーク・資産metaの正しさは独立認証していない。HTTP/codec試験の応答は明記した合成fixture。
