# RealDEX v0.12 — 起動・経路スワップ・実AMM試験
日付: 2026-09-05 / 開発用・未監査・実資産禁止

## 更新と起動
旧アプリを正常終了し、暗号化バックアップを保全してから別ディレクトリへ展開します。保管形式・保存先は変更していません。古い保管庫の自動修復や、口座・デプロイ情報の自動移行は行いません。

```sh
node app/cli.mjs start
```
ウォレットと読み取りノードは別プロセスです。ウォレットはターミナルに表示された所有者専用URLを同じPCで開きます。`#key=`を含むURL、パスワード、保管庫をAIや共有ノードへ渡さないでください。ウォレット単独は `node wallet/cli.mjs start`。ローカルサービスの通常起動にnpm installは不要ですが、React全体のビルドは別です。

## 1〜4プールを通る所有者の交換
ネットワークの登録契約を読み込み、「経路スワップ」を選びます。Router、入力トークン、通過するPoolアドレスを順番にカンマ区切りで指定します。全Poolと全中間トークンを所有者の契約設定に登録している必要があります。同じプールやトークンを繰り返す循環経路は拒否します。

入力数量、最終トークンの最低受取数量、受取先、30〜600秒の期限を設定します。「指定した経路を見積もる」は、同じブロックに固定して全区間のコード・桁数・ペア・手数料・準備高・実残高・整数式・Routerの見積りを照合します。表示するのはプール手数料控除後、追加ガス代・承認費用控除前の値であり、最適経路の自動探索ではありません。

見積りを入力欄へ反映しても署名はしません。必要な承認は別操作で有限額だけ与え、その後「内容を照合して承認待ちへ」を使います。確認画面で全経路・最低受取・ガス上限・受取先を見直し、送信チェックを明示します。ロック・入力変更・30秒の見積り期限超過後の結果は採用しません。署名直前に再検査し、状況が変われば止まります。

## 承認額の変更
現在のallowanceが非ゼロの状態では、同じ相手へ別の非ゼロ値を上書きできません。必要なら「承認の取消」を別取引として行い、チェーン状態でゼロになったことを確認してから新しい有限額を承認します。署名サービスも初回照合と署名直前にゼロを再確認します。取消と新規承認は原子的な一取引ではなく、すでに許可された支出を取り消したり、チェーン再編を防いだりする機能ではありません。

## 検証の再現
基本の選択試験・全体判定:
```sh
node app/verify.mjs --full --output acceptance-new
```
正式コンパイラは従来どおりSolidity 0.8.24です。足りないツールや依存はblockedとなり、nightlyへフォールバックしません。終了コード2は未達を含む判定です。

### 補助AMM試験（Linuxで確認、正式リリース判定とは別）
二つの別添ZIP、`foundry-linux-test-toolchain.zip` と `RealDEX-Experimental-Solc-Nightly-Toolchain-2026-09-05.zip` を取得します。どちらも通常のウォレット起動には不要です。以下のパスは手元の配置に合わせて変更します。

```sh
python3 integration/anvil/provision.py --archive /path/foundry-linux-test-toolchain.zip --output /path/tools/anvil
python3 integration/amm/provision-experimental.py --archive /path/RealDEX-Experimental-Solc-Nightly-Toolchain-2026-09-05.zip --output /path/tools/soljson-experimental.cjs
export REALDEX_ANVIL_BINARY=/path/tools/anvil/anvil
export REALDEX_EXPERIMENTAL_SOLJSON=/path/tools/soljson-experimental.cjs
node integration/amm/run.mjs --output amm-evidence-new --profile experimental
```
展開時にZIP、compiler本体、Git blobの同一性を確認し、コンパイラを実行する直前も固定SHA-256を確認します。未知ファイル・シンボリックリンク・書込み可能な共有ファイルは拒否します。証拠出力先は新規ディレクトリを指定してください。

試験はローカルAnvilを起動し、元のFactory／Pool／Routerとテスト用トークンを配置します。配置・初期流動性の作成に使うimpersonated accountはテスト準備だけです。ウォレット操作は実際の署名を作り、EVMの残高で検証します。二つのRPC転送口の背後は一つのEVMであり、独立した二台の合意を検証しません。自動的に公開テストネットやメインネットへ接続しません。

正式基準のコンパイラがある場合だけ:
```sh
export REALDEX_SOLC_BINARY=/path/to/verified-solc-0.8.24
node integration/amm/run.mjs --output amm-pinned-new
```
この成功経路は今回未実行です。補助試験の成功でも `baselineCompilerGateSatisfied` と `productionReady` はfalseのままです。

## 未達
固定0.8.24による実AMM・既存公開デプロイとの同一性、全体Reactビルド・全テスト、実ブラウザHTTP/CSP、公開テストネット、Windows、OS鍵保護、独立監査は未達。非EVM送信、実ブリッジ、分割取引実行、秘密資産送金、自動NAT接続も今回追加していません。
