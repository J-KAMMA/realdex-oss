# RealDEX v0.5 マルチチェーン開発版：起動手順

日付：2026-09-05 / Node追加層：0.5.0-dev.20260905

## 目的と現在の範囲

138候補・15系統の読み取りアダプター、任意EVM候補の追加、公開EVMカタログのローカル一括取り込み、EVM89候補の契約配置計画、検索・照合画面を追加しています。**ウォレット・秘密鍵・資産・取引署名は追加層に渡しません。全チェーンのDEXが完成した版ではありません。**

通常の追加ノード起動・CLI・Node試験に `npm install` は不要です。今回の検証環境はLinux、Node 22.16.0です。Windows実機と複数PCの通信は未検証です。ルートのReact/Hardhatアプリは別の依存関係・Node要件を持ち、今回その全ビルドは再確認していません。

## 1. ノードと画面

ZIPを展開してリポジトリのルートで実行します。

```sh
node node/cli.mjs init --directory .realdex/my-node --port 8787
node node/cli.mjs start --config .realdex/my-node/config.json
```

既存の設定がある場合は `init` せず `start` のみ実行してください。初期化の上書きは行いません。

- ノード画面：`http://127.0.0.1:8787/node/`
- 今回のチェーン画面：`http://127.0.0.1:8787/node/chains/`
- 前回の署名付き交換ラボ：`http://127.0.0.1:8787/node/exchange/`

チェーン画面は検索・系統別絞り込みに対応します。選択後、利用者が確認した2〜4個のRPC URLを入力します。URLのオリジンは別々でなければなりません。ただし別ドメインや別ポートが別運営者であることまでは確認しません。既存のFactory候補共有はEVM限定のままであり、今回の非EVMメタデータを自動でゴシップしません。

外部公開には従来どおり明示設定が必要です。NAT越え、TLS証明書、自動ポート開放、リレー、DHTは追加していません。公開RPCのCORS・レート制限がブラウザを拒否する場合があります。CLIが動いてもブラウザ結合の成功とは別です。

## 2. 候補と状態を確認

```sh
node node/chains.mjs list
node node/chains.mjs inspect --chain eip155:8217
node node/chains.mjs inspect --chain solana:mainnet-beta
```

すべての候補は `candidate-unverified` または `deprecated` です。ネットワーク名、通貨記号、EVMという分類だけで実行できるとは判断しません。初期識別値の固定が必須なのはSolana、Substrate、TRON、TONです。期待値は別経路で確認してください。

## 3. CLIで同じ読み取りを実行

`node/examples/multichain/` に15系統の要求ひな型があります。`.invalid` のURLは置換用で、そのままでは接続できません。編集したコピーをリポジトリ外などへ保存し、次で実行します。

```sh
node node/chains.mjs probe --input my-evm-request.json
```

EVMの要求の形は次のとおりです。

```json
{
  "schema": "realdex.chain-probe-request.v1",
  "chainId": "eip155:1",
  "endpoints": [
    "https://YOUR-FIRST-PROVIDER.invalid",
    "https://YOUR-SECOND-PROVIDER.invalid"
  ]
}
```

複数チェーンは、各要求を `jobs` 配列へ格納した `realdex.chain-probe-jobs.v1` 形式で指定します。

```sh
node node/chains.mjs probe-many --input my-chain-jobs.json
```

最大256ジョブ、CLI既定2並列、ライブラリ上限4並列です。全RPCが同じネットワーク・同じ高さのブロックを返すことを照合し、再読み取りで変化も調べます。Solanaの欠落スロット、剪定された履歴、不一致、不明なネットワーク、期限切れは停止します。「代わりに最新を読む」という暗黙の回避はしません。

この結果は価格・トークン・プールの検証ではありません。RPC同士が共謀すれば同じ虚偽を返せます。コンセンサス証明・ブロック実行の検証・運営主体の独立性はすべて未検証です。Substrateの時刻は今回取得しないため、鮮度確認も未完了と表示します。

## 4. 任意のEVMを追加

```sh
node node/chains.mjs custom-evm --chain-id 12345 --output my-evm-candidates.json
node node/chains.mjs inspect --registry my-evm-candidates.json --chain eip155:12345
```

`12345` は構文例です。実際のチェーンIDへ置き換えてください。追加した設定で既存送信UIが開放されることはありません。

公開 `ethereum-lists/chains` 形式のJSONをローカルに用意した場合は次で取り込みます。

```sh
node node/chains.mjs import-evm --input chains.json --output imported-candidates.json
node node/chains.mjs list --registry imported-candidates.json
node node/chains.mjs plans --registry imported-candidates.json --all --output imported-evm-plans
```

最大20,000件。大きなchainIdは桁落ちしない文字列にしてください。重複ID・不正エントリは記録し、RPC URL・Factoryアドレス・送信許可は取り込みません。全世界の現行カタログを今回のZIPへ収録したわけではありません。10,000件の合成入力による試験は、10,000実チェーンの接続確認ではありません。取り込んだレジストリはCLIで利用でき、画面の候補ファイルへ自動反映しません。

## 5. EVM契約の配置準備

`node/examples/evm-network-plans/` に89候補の計画、共通 `compiler-input.json`、`bundle.json` を同梱しています。すべて `compiled:false / deployed:false / executable:false` です。

新しい空の出力先へ再生成できます。

```sh
node node/chains.mjs plans --all --output my-evm-plans
node node/chains.mjs plans --chain eip155:84532 --output my-base-sepolia-plan
```

既存ディレクトリへの上書きは禁止です。計画は元の `LocalSwapFactory` / `LocalSwapPool` / `LocalSwapRouter` を参照します。FactoryとRouterのconstructor引数はありません。Pool作成には別途、検証した二つのトークンと料率が必要です。

共通入力はSolidity `0.8.24+commit.e11b9ed9`、optimizer 500、明示的なEVM target `paris`。これは候補用設定であり、全EVMでの互換性証明ではありません。元のコンパイル条件とは異なり得るため、旧runtime hashを流用してはいけません。ZKsync系・機密VM等は個別ツールチェーン検証が必要です。

信頼済みコンパイラで標準JSON入力をコンパイルした後、出力の構造を確認する入口は次です。

```sh
node node/chains.mjs inspect-build --input my-evm-plans/compiler-input.json --build compiler-output.json
```

**このコマンドはコンパイラを実行しません。** 合成出力で構造確認を試験した段階です。出力が通ってもコンパイラ真正性・コードの意味・Factory storage・Pool由来・デプロイは証明しません。デプロイと費用支出は別の明示承認が必要です。

## 6. 再試験

```sh
node node/test/run-tests.mjs --with-release
```

今回の選択試験は804件（追加451、既存ノード347、既存release計画6）。模擬RPC2台ずつの実HTTP試験が15系統分含まれます。実チェーンの試験ではありません。

TypeScriptを別途用意した環境では次も実行できます。

```sh
tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --lib ES2023,DOM node/test/multichain-types-smoke.mts
```

画面の任意オフラインDOM試験はPython・Playwright・Chromiumが必要です。通常ノードの依存ではありません。

```sh
python node/test/multichain-browser-offline.py --output /YOUR/NEW/OUTPUT
```

この画面試験は合成のローカルレジストリだけを供給し、RPCへのアクセスを禁止しています。HTTP・CSP・CORS・実資産の試験の代替ではありません。

## 注意すべき未完成部分

非EVMのネイティブPool/Factory、資産の実残高取得・交換見積りの全系統統合、実取引、ブリッジ経路の追加、ブリッジの受取・復旧、今回の候補から既存送信UIへの昇格は未実装です。既存の前回版の未解決事項も残っています。本番資産を扱う版ではありません。
