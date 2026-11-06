> **v0.4追加：** 署名付き候補を2系統以上のRPCで照合する読み取り専用ラボは `/node/exchange/`。新CLIは `node node/verify.mjs --help`。新しい[日本語手順](../docs/REALDEX_VERIFIED_QUICKSTART_JA_2026-09-05.md)と[検証報告](../docs/REALDEX_VERIFIED_DISCOVERY_2026-09-05.md)を優先してください。元のノード起動・peer設定は下記を継続使用します。古い試験件数はv0.3当時の記録です。

# RealDEX Node Preview — 個人PCノード開発版

2026-09-05 / `0.3.0-dev.20260905`

この追加パッケージは、個人PCで起動できる**読み取り専用の発見ノード**と、費用控除後の交換候補を比較する**純粋な計算モジュール**です。元のRealDEXのFactory・Pool・Router・ウォレット実行コードを置き換えるものではありません。全チェーン対応DEX、ブリッジの検証者ネットワーク、実資産向け公開版はまだ完成していません。

## すぐ動かす

リポジトリのルートで実行します。追加ノードはNode.js標準ライブラリだけを使い、`npm install`は不要です。今回確認した環境はLinux x86-64、Node.js **22.16.0**です。元のReact／Hardhatアプリは別で、元の`package.json`に指定されたNode.js 24.14.0／pnpm 11.25.0と依存パッケージが必要です。Windows実機試験は未実施です。

最初に、保存不要のデモを実行できます。

```sh
node node/demo.mjs
```

3つの一時ノードを同一PCのloopback上に立ち上げ、AのFactory候補がB経由でCへ届くこと、B停止後にCのコンソールが応答することを検査し、終了します。秘密鍵をファイルに保存せず、RPC・ウォレット・外部ノードへ接続しません。出力の価格とアドレスは架空です。

通常起動は次のとおりです。

```sh
node node/cli.mjs init --directory .realdex/my-node --port 8787
node node/cli.mjs start --config .realdex/my-node/config.json
```

ブラウザで `http://127.0.0.1:8787/node/` を開きます。終了は `Ctrl+C` です。初期状態は相手なし・Factory候補なしで正常です。

`init`は既存ディレクトリを上書きしません。生成する`identity.json`は**ノード情報の署名専用鍵**で、ウォレット鍵ではありません。シード、秘密鍵、資産をここへ入れないでください。作業ツリーやOneDrive等の同期対象外に置く場合は、`--directory`に任意の外部パスを指定できます。公開鍵以外は共有しません。

公開鍵の再表示：

```sh
node node/cli.mjs identity --config .realdex/my-node/config.json
```

## 2台以上で接続する

各PCがそれぞれ`init`し、自分の鍵を持ちます。**同じidentity.jsonを複製しないでください。** 同じ鍵で別の候補一覧を発信すると、同一改訂番号の内容不一致として拒否されます。

相手の公開鍵を別経路で照合したうえで、自分の`config.json`の`peers`に登録します。次は置換が必要な部分例です。

```json
{
  "peers": [
    {
      "url": "https://YOUR-PEER-HOST.example",
      "publicKey": "REPLACE_WITH_PEER_64_LOWERCASE_HEX_PUBLIC_KEY"
    }
  ]
}
```

公開鍵・URLは相手が広告した値を自動採用しません。相手側にもこちらを登録すると双方向に情報を取得できます。A→B→Cの中継でCがAの情報を受け取るには、Cの`publishers`にAの公開鍵も登録します。Bを信頼しただけでBの全情報源を信頼しない設計です。

通信先はHTTPS、または同一PCの`http://127.0.0.1:PORT`／`http://[::1]:PORT`に限定します。`http://localhost`やLANアドレスへの平文HTTPは拒否します。HTTPSには実際に到達できるTLS終端が必要です。TLSリバースプロキシを使う場合は、Node側をloopbackのままにし、プロキシで公開するHost名を`allowedHosts`へ追加してください。プロキシの設定・証明書・OSのアクセス制御はこのソフトが変更しません。

`host`を`0.0.0.0`または`::`へ変更して外部インターフェースで待ち受ける場合に限り、追加の明示フラグが必要です。

```sh
node node/cli.mjs start --config PATH/TO/config.json --allow-network
```

**このフラグはTLS、認証済みトンネル、ポート転送、NAT越えを用意しません。** HTTPSによる複数実機接続、自動NAT越え、大規模公開ネットワークは今回の試験範囲外です。インターネットへ公開する前にネットワーク防御を別途検証してください。

## Factory候補を公開する

`catalogue.factories`はEVMのRealDEX CPMM v1 Factoryの**所在候補**です。登録してもデプロイ・プール作成・取引送信は行いません。

```json
{
  "catalogue": {
    "revision": 2,
    "factories": [
      {
        "chainId": "eip155:84532",
        "address": "REPLACE_WITH_REVIEWED_LOWERCASE_0x_FACTORY_ADDRESS",
        "protocol": "realdex-cpmm-v1"
      }
    ]
  }
}
```

候補一覧を変更・削除するときは、改訂番号`revision`を必ず増やします。複数候補は`chainId + '/' + address`の順にソートし、重複させません。設定変更後はノードを再起動します。署名は「その発信者がこの情報を出したこと」だけを示し、コードの安全性、チェーンの正しさ、流動性の存在、資金使用権を示しません。

コンソールには常に**未検証・実行不可**として表示されます。既存`src/swap/evm-venue-discovery.ts`のコードハッシュ・プール由来・トークン検証へ通してから利用する接続処理は次段階です。現在の取引UIへ自動登録しません。

## 最適化モジュール

`node/optimizer/quote-objective.mjs`は、同じ入力・出力資産と入力額に対応する候補を、次の値で比較します。

```text
評価値 = minimumOut − 出力資産へ換算した追加費用
```

ガス、承認、送信先で必要な費用、リレイヤー費用などを追加費用に指定します。既に`minimumOut`へ織り込まれたプール・ブリッジ費用は`included-in-output`とし、二重に引きません。換算できない費用はゼロではなく`incomplete`です。異なるチェーンに同名トークンがある場合も、別のCAIP資産として区別します。

価格比は人間向けの小数価格ではなく、**各資産の最小単位同士の比**です。例えば入力費用資産が18 decimals、出力資産が6 decimalsなら、その桁差を`numerator / denominator`へ含めます。端数は費用側を切り上げます。価格情報源の信頼性・価格の取得・費用の網羅性は呼び出し側の責任です。期限フィールドを設けただけで価格オラクルの安全性が保証されるわけではありません。

TypeScript用`.d.mts`も同梱しています。既存型を取り込む`adaptBoundRouteQuote`は、元の`assertBoundQuote`に代わる検証器ではありません。アカウント・受取人・セッション・スリッページ等の束縛を従来どおり確認してください。

`node/optimizer/discrete-split.mjs`は、入力を一定刻みに分け、独立プールへ配分する動的計画法です。最大8候補、128刻み、4分割。候補ごとのプールID重複、スナップショット不一致、チェーンをまたぐ分割、不明・期限切れのサンプルを拒否します。IDが本物のプールと対応すること、共通スナップショットが本物であることも呼び出し側で検証します。

**厳密最適なのは、渡された候補・費用・刻み・最大分割数の範囲だけです。** 取引価格やガス代の将来値を保証しません。プールを共有する経路、連続量全体の最適化、クロスチェーン分割は対象外です。既存Routerはこの分割案の実行に対応していないため、結果は`executable: false`のままです。

## 元のDEX画面を同じPCから配信する場合

まず元の依存関係を取得し、リポジトリルートの既存`build`を実行して`dist`を生成する必要があります。今回このビルドは未実施です。

その後、ノードの`serveDex`を`true`にすると、起動時に`dist/release-id.txt`が元のリリース計画のソースIDと一致するか確認します。不一致・未生成なら起動しません。このstampは任意のファイル改ざんに耐える配布署名ではありません。配布全体の完全性確認は別途必要です。

`/`は元の固定Base Sepolia画面、`/node/`は追加コンソールになります。未承認デプロイへの接続・署名を拒む元の制約は変更していません。新規ノードコードは元のrelease IDの対象に含まれないので、この配布ZIPには別のハッシュ記録を用意しています。

## 保存・停止・障害時の扱い

`heads.json`は各発信者の最大改訂番号と内容の指紋です。古い情報への巻き戻しを拒むため、候補の有効期限が切れても残します。ノード停止中に通信は継続せず、再起動後に期限内の候補を再取得します。候補本体は恒久保存しません。

同一データ領域への同時起動は`instance.lock`で拒否します。通常終了で消えます。強制終了などで残った場合は、`instance.lock/process.json`を確認し、同じノードが動いていないことを確かめてからロックだけを手動削除してください。自動的なロック奪取はしません。`heads.json`が壊れた場合も黙って初期化しません。削除すると巻き戻し履歴を失うため、復旧・情報源の再照合が必要です。

1発信者最大16候補、1ノード最大32発信者、接続先最大16。過去の発信者のheadも枠に残ります。大量の公開鍵を追加すると無期限には拡張できません。永続headの剪定・鍵失効の運用は次段階です。

## 試験

```sh
node --test node/test/*.test.mjs
node --test scripts/createEvmTestnetReleasePlan.test.mjs
node node/demo.mjs
# TypeScriptが別途利用可能な場合
 tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext node/test/types-smoke.mts
```

任意のブラウザ試験にはPython、Playwright、Chromiumが別途必要です。

```sh
python node/test/browser-smoke.py --output node/evidence/browser
```

今回の実行環境ではChromiumの管理ポリシーがHTTPナビゲーションを拒否しました。ポリシーは変更せず、以下でローカルHTML/CSS/JSをメモリ上に読み込み、取得済み状態データを注入する**DOM試験**を行いました。

```sh
python node/test/browser-smoke.py --offline-dom --output node/evidence/browser
```

これは実ブラウザHTTP／CSPの結合試験ではありません。HTTP・署名・中継・停止・再起動はNodeの実通信試験で別に検証しています。詳細は`evidence/`と[実装レポート](../docs/REALDEX_NODE_IMPLEMENTATION_2026-09-05.md)を参照してください。
