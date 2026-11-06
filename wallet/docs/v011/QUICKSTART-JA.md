# RealDEX v0.11 — 起動・実EVM検証・更新手順

## 目的
自己管理ウォレット、AI制限付き送金、読み取りノードをローカルで動かし、本番前の不具合と実EVMの挙動を検証します。未監査の開発版です。実資産を入れたり、メインネット制限を解除したりしないでください。

## アプリの起動
リポジトリのルート（app/、wallet/、node/がある場所）で実行します。

```sh
node app/cli.mjs start
```

追加のローカルNodeサービスはnpm依存なしで起動します。ウォレットにはターミナルに表示される所有者専用URLからアクセスしてください。`#key=`付きURL、パスワード、バックアップ復号情報をAIや共有ノードへ渡してはいけません。通常の読み取りノードは `http://127.0.0.1:8787/node/` です。

一括起動の既定保存先は `~/.realdex-app/`。単体の `node wallet/cli.mjs start` は `~/.realdex-wallet/` です。既存データを自動移行しません。今回もTauriアプリ・Windowsインストーラーではありません。

## 既存版からの更新
暗号化バックアップを保全し、旧アプリを正常終了してから、新版を別フォルダーへ展開してください。同じ保管庫を二つのプロセスで開かないでください。データの形式とKDFを変更していないため、v0.10で正常だったファイルについて変換は不要です。ただし旧版の壊れたファイルを自動修復する機能ではありません。

パスワード変更時に保存エラーが起きた場合、新版は即時ロックします。保存前なら旧パスワード、置換後なら新パスワードのファイルが残っている可能性があります。成功したと決め付けたり、新旧のファイルを上書きしたりせず、ファイルを保全して実際に解除できる版を確認してください。新パスワードに変更できた場合は、新しいバックアップの復元確認が必要です。

## 実EVMの送金試験（Linux x86-64）
この試験は、React、Hardhat、Solidityコンパイラを必要としません。別途、固定したAnvil実行ファイルが必要です。アプリの通常起動にはAnvilは不要です。

`integration/anvil/pin.json` に、取得元、アーカイブ・実行ファイルのSHA-256、バージョン、commit、対象hardforkを固定しています。既存の `foundry-linux-test-toolchain.zip` または指定リリースのtar.gzを使えます。

```sh
python3 integration/anvil/provision.py \
  --archive /absolute/path/foundry-linux-test-toolchain.zip \
  --output /absolute/path/new-realdex-test-tools

export REALDEX_ANVIL_BINARY=/absolute/path/new-realdex-test-tools/anvil

node integration/anvil/run.mjs --output anvil-native-evidence
```

`--output` は未作成の場所を指定します。provisionはダウンロードや実行をせず、ハッシュを検査してAnvilだけを取り出します。試験コマンドは、使い捨ての鍵と保管庫・ループバックのAnvilを作成し、終了時に片付けます。既存ウォレット設定・本物の資産・公開RPCは使いません。Anvilは単一ノードで、二つのHTTP転送口は独立した検証ノードではありません。

成功時は `anvil-native-evidence/anvil-native.json` と `native-payments.tap` ができます。Anvilがなければ `blocked`／終了コード2、不一致や試験失敗なら非ゼロで停止します。自動で模擬RPCへ代替しません。

## 全体検証

```sh
node app/verify.mjs --full --output acceptance-new
```

`REALDEX_ANVIL_BINARY` が設定されていれば、既存の選択試験に加えて独立した `native-real-evm` ゲートを実行します。`REALDEX_SOLC_BINARY` は別の固定Solidityコンパイラです。両者は互いの代用品ではありません。

全Reactビルドと旧来のHardhat契約試験には、package.jsonにある正規依存とNodeの固定版が必要です。`productionReady` は今回もfalseです。ネイティブ送金試験が通っても、AMMのコンパイル・実行や、公開チェーン・非EVM・ブリッジの完了を意味しません。

## 機能の範囲
EVMの制限付き送信、所有者用DEX画面、AIの6個の制限付きMCPツールなど、既存機能の制限を維持しています。今回、AIへのswap/bridge/任意署名/保管庫解除権限は追加していません。164ネットワーク候補という旧版の登録数は、送信対応・実測済みチェーン数ではありません。
