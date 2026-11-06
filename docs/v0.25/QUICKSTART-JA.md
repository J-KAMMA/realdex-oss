# RealDEX v0.25 起動・更新・外部板の試算

## 更新

v0.24を唯一の親とする累積版です。旧プロセスを正常終了し、暗号化バックアップと設定を保全してから別フォルダーへ展開してください。保管庫の保存形式・鍵・署名権限は今回変更していません。所有者専用URLをAIや他人へ渡さないでください。

```sh
node app/cli.mjs start
```

追加画面は `http://127.0.0.1:8787/node/spot/`。通常Nodeサービスはnpm installなしで起動できます。React全体のビルド完了という意味ではありません。

## 通信を使わない確認

画面の「架空データで試す」を押すか、次を実行します。

```sh
node node/spot.mjs
node node/spot.mjs --provider hypercore --amount 1
```

Injectiveのデモは基準taker手数料を使った参考値を返します。HyperCoreのデモは取引手数料を不明として返します。架空のDEMO/USDxであり、市場価格ではありません。

## 自分で確認した接続先を使う

接続先はroot originだけを許可します。HTTPSの外部接続は、画面の明示許可またはCLIの`--allow-origin`が必要です。平文HTTPはリテラルloopbackのみ。認証情報をURLに埋め込めません。自動リダイレクト・別業者への切替はしません。

```sh
node node/spot.mjs --provider injective \
 --endpoint "$INJECTIVE_INDEXER_ORIGIN" --allow-origin "$INJECTIVE_INDEXER_ORIGIN" \
 --network injective-1 --market "$SPOT_MARKET_ID" --side sell-base --amount 1

node node/spot.mjs --provider hypercore \
 --endpoint "$HYPERCORE_API_ORIGIN" --allow-origin "$HYPERCORE_API_ORIGIN" \
 --network mainnet --market "$SPOT_PAIR_INDEX" --side buy-base --amount 10
```

ネットワークラベルは利用者の指定であり、独立して認証したchain IDではありません。接続先の選定は[SOURCES](../../node/external/SOURCES.md)の公式資料と照合してください。今回、公開endpointとの適合試験は未実施です。送信署名は作れません。

`--limit`は人が読むQuote/Base価格で、売りでは下限、買いでは上限。HyperCoreの市場は現物pair indexを指定し、裸のBTC/ETHという先物名を指定しません。`--output`は新規ファイルだけに保存します。

## 表示の読み方

数量は資産の最小単位へ正確に変換されます。価格刻み・ロット・板の順序・交差・時刻・メタデータの変更を検査します。

`filled`は現在の板と指定条件で投入分を計算できた意味で、実約定ではありません。`residual-input`はロットや費用による残量、`depth-exhausted`は見えている板の不足、`limit-reached`は価格条件で停止した意味です。ガス・入出金・橋の費用は未計算です。

受取額はexchange-subaccount/HyperCore spot残高の場所までの参考値で、外部ウォレットへの着金ではありません。Injectiveは基準taker rateだけを使い、口座割引やatomic-order倍率は未モデル化です。

## 試験

```sh
node --test node/external/test/*.test.mjs
node app/verify.mjs --output /path/to/new-acceptance
node app/roadmap.mjs
node app/render-roadmap.mjs
```

独立fixture生成は `python node/external/test/reference.py`（protobufが必要）。画面の独立したオフライン検査は `python node/external/test/browser.py --offline-dom --output /path/to/browser-result`（Playwright/Chromiumが必要）。通常起動には不要です。

既存IBCの再検証には従来どおり固定の診断用ツールを使います。`--ibc`を要求してツールがなければ成功として返しません。正式な公開ゲートは `node app/verify.mjs --full --output /path/to/new-full-acceptance` です。
