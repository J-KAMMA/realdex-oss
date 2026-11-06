# RealDEX v0.17 — Cosmos SDK ローカル送金

版日付: 2026-09-06（日本時間）。基準: RealDEX v0.16 / SHA-256 `1825e879e49795d5f18c41873e3954906ffe9cdd6885cb0d78215931c9c6b75b`。

## 利用条件

未監査の開発版です。実資産・本番の秘密鍵・本番の復元フレーズを使用しないでください。今回追加した送金先は `realdex-local-*` というIDを持つ自設Cosmos SDKチェーンだけです。Cosmos Hub、Osmosis、その他公開チェーンへの送信対応ではありません。

接続URLは127.0.0.1限定です。ただし、ローカルの中継が公開チェーンにつながっていないことをURLだけでは証明できません。使い捨ての専用試験口座を作成してください。台帳の情報、memo、送金先は非公開情報ではなくなり得ます。

## 更新と起動

旧プロセスを正常終了し、暗号化バックアップと元の保管庫を保全します。新ZIPは別のフォルダーへ展開してください。保存先の自動移行はしません。

```sh
node app/cli.mjs start
```

ウォレット単独の従来保存先を使う場合:

```sh
node wallet/cli.mjs start
```

追加ローカルサービスの通常起動にはNode 22.16以降が必要です。通常起動にnpm installやsimdは不要です。ルートReactアプリの固定環境は別で、package.jsonのNode・pnpm・依存指定を参照してください。

ターミナルの所有者専用URLを同じPCで開きます。`#key=`を含むURLは所有者の操作権限です。AI・共有ノード・他人へ渡さないでください。

## Cosmosの接続設定

CometBFT JSON-RPCとSDK RESTをそれぞれ公開する自分のノードが必要です。2〜4組の接続先を登録します。URL数は独立したノード数ではありません。

`wallet/examples/cosmos-local.draft.json`をコピーし、chainId、HRP、RPC/RESTポート、denomと表示桁数、支払い上限、手数料上限を自分の環境に合わせます。`broadcastEnabled`はfalseで開始します。テンプレートのcheckpoint hashはダミーであり信頼根ではありません。

```sh
node wallet/non-evm/cosmos-config.mjs --input draft-local-cosmos.json --output checked-local-cosmos.json
```

このCLIは指定高さのブロックについてRPCが報告した値を取得するだけです。設定や署名権限をアプリへ自動登録しません。取得したcheckpointを、別の信頼できる方法で自分のチェーンと照合してください。出力先の上書きは拒否します。

画面の「Cosmos SDK · 所有者のオンライン送金」でJSONを入力し、`ADD <id> <checkpoint hash>`を全文入力して登録します。適用前にロックし、既存の承認待ち・アプリ接続・AI許可を無効化します。再解除後、口座と接続先を選択します。

初回送信まで試す場合は、チェックポイントを独立確認した後、**アプリへの初回登録前**に `broadcastEnabled` をtrueへ変更し、その全文を確認して登録してください。既存IDの上書き編集は未実装です。falseで登録した設定を使う場合は、読み取り・署名のみの試験に留めます。署名済み記録の指紋が固定されるため、後から設定を変えて送信制限を迂回することはできません。

表示名・桁数はこの設定による宣言であり、自動認証したトークン情報ではありません。今回の試験の `stake` / `SIM` は無価値のテスト資産です。6桁表示はUIの選択であってATOMの対応を意味しません。

## 送金

1. Cosmosの試験口座を作成し、暗号化バックアップを保存・読み戻し検証します。
2. 受取先、表示単位の数量、feeDenomの最小単位による手数料、ガス上限、必要ならmemoを入力します。
3. 「取引を照合して承認待ちへ」を押します。この段階では署名しません。残高、公開鍵、accountNumber、sequence、期限を照合し、ゼロ署名でシミュレーションします。
4. 承認画面で全条件を読み、受取先を全文再入力します。送信チェックは既定OFFです。署名だけを保存することもできます。
5. 「署名・保存後にローカルRPCへ送信する」を明示した場合、再検査・永続保存後にだけ初回送信します。ネットワーク設定の送信フラグもtrueである必要があります。

初回署名後にbroadcastEnabledを変更すると、保存した取引と設定のfingerprintが一致しなくなります。保存済み署名を後から別設定へ移す操作ではありません。設定を確定した後に新しい試験を始めてください。

手数料は送金額と別です。同じdenomなら両方を残高から差し引けることを確認し、別denomなら双方の残高を確認します。`feeAtomic`はこの取引に固定する総手数料、`gasLimit`はガス使用量の上限です。ネットワークの最低ガス価格を自動取得・認証する機能はありません。

## 結果不明と再照合

`broadcast`はCheckTx受付の観測で、決済完了ではありません。履歴の「COSMOSの状態を再照合」で、保存したTxRaw・取引ハッシュ・ブロックのMerkle包含・実行コード・送金イベント・sequenceを照合します。

`reported-confirmed`でもRPCに依存した観測です。独立したヘッダーチェーン、validator投票、アプリ状態証明は検証しません。受取証が消えた場合は成功観測を撤回します。新たに署名可能になる判断は、独立した決済証明ではありません。

送信済み・結果不明の取引の再送、RBF相当の置換、期限変更、nonceの手動解放はありません。未解決取引がある口座・ネットワークでは新規署名を止め、既存オフライン経路からの迂回も拒否します。同じ依頼キー・内容は保存済み結果を返します。別キーは別の支払いであり、同じ請求かどうかの判定ではありません。

## バックアップ互換性

従来の履歴の読み込みは維持します。新しいCosmosオンライン記録を保存した保管庫を、旧版で開いたり上書きしたりしないでください。現行バックアップの復元で署名履歴・sequence予約を保持する試験を実施しています。ただし古いバックアップ、別端末、別アプリまで含む巻戻し防止は未実装です。復元を署名の取消しとして扱わないでください。

## 実simd試験の再現

通常利用とは別の試験依存です。Linux x86-64向け公式CIアーカイブ `RealDEX-Cosmos-Simd-Test-Toolchain-2026-09-06.zip` を使います。

- ZIP: SHA-256 `7705b99457444bebaca99e056f6ba2d6e03765e4071236274fd9a5ad9395789d`
- 実行ファイル `simd-linux-amd64`: SHA-256 `8bd38fcc35329b331fb73caabdb0287f4cfde62f6593c36fd32e27664619f838`、129,343,704 bytes
- Cosmos SDK公式repository、commit `c1126e4e5460571378bf9bd9c49cce476b0791e2`、Actions run `33866406573`、artifact `9934164663`。
- 開発ビルド `0.0.0-c1126e4e54` / SDK `v0.55.0`。安定版や本番推奨バイナリとしての採用ではありません。

ZIPを検査してから専用ディレクトリへ展開し、他の利用者が書けない権限にします。

```sh
sha256sum RealDEX-Cosmos-Simd-Test-Toolchain-2026-09-06.zip
unzip RealDEX-Cosmos-Simd-Test-Toolchain-2026-09-06.zip -d cosmos-test-tools
chmod 700 cosmos-test-tools/simd-linux-amd64
export REALDEX_SIMD_BINARY=/absolute/path/cosmos-test-tools/simd-linux-amd64
node integration/cosmos/demo.mjs
node --test --test-concurrency=1 --test-reporter=tap integration/cosmos/Payments.test.mjs
node app/verify.mjs --cosmos --output acceptance-cosmos-new
```

試験は独自の一時home、試験用validator、公開された無価値の試験鍵を使います。既存のノード・ユーザー保管庫を開きません。P2P接続先を設定せず、RPC/REST/P2Pはloopback、pprofは無効です。二つのHTTP接続口の背後は同じ一つのsimdです。試験終了後にその一時環境を削除します。

完全な検証コマンドは `node app/verify.mjs --full --output acceptance-full-new` です。依存や実行環境が欠ける項目はblocked、実行失敗はfailedとして記録し、本番合格へ置き換えません。
