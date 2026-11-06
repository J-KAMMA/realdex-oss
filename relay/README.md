# RealDEX v0.24：独立鍵の限定IBC中継

これは自分で運用する**ローカル開発チェーン用**の中継ワーカーです。公開チェーン用の承認済みrelayer、全チェーンブリッジ、資産ウォレットの代替ではありません。通常のウォレット・共有ノードとは別プロセス、別保管先で動きます。

## 実装したもの

`receive`、`acknowledgement`、`timeout`を、必要なTendermint client updateと同じ取引で送ります。チェーン上のIBCがヘッダーと包含/不在証明を検査します。RealDEXの画面の観測は独立した最終確定証明ではありません。

明示的に登録した元チェーンの送信取引ハッシュだけを処理します。経路は最大4、ネットワーク最大4、キュー最大32件、保存した署名は全体最大256件です。暗号化前450,000バイトの保存上限もあり、証明の大きさによっては件数上限より早く停止します。自動削除・自動アーカイブはありません。

鍵は初期化時にネットワークごとに新規生成します。既存ウォレットの鍵取込、外部アプリからの署名API、AI MCPへの接続はありません。専用口座には使い捨ての手数料資産だけを入れ、authzなどの資産権限を付けないでください。

ネットワークごとに、固定した1取引の費用、ガス上限、累計費用上限、最大署名回数を設定します。署名した時点で費用枠を消費し、失敗や結果不明でも自動返却しません。費用枠はこの署名サービス内の制御です。鍵そのものが侵害された場合のオンチェーン制限ではありません。

## 使い捨てのデモ

既存の`integration/ibc/pin.json`と`provision.py`により、取得済み診断用ツールをハッシュ確認して展開してください。通常起動ではツールは不要で、実行試験だけに使用します。

```sh
python3 integration/ibc/provision.py \
  --archive /path/to/RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip \
  --output /path/to/new-ibc-tools
export REALDEX_IBC_SIMD_BINARY=/path/to/new-ibc-tools/simd
export REALDEX_IBC_MUSL_LOADER=/path/to/new-ibc-tools/lib/ld-musl-x86_64.so.1
node integration/ibc/relay-demo.mjs
```

二つの使い捨てチェーンで経路を作り、専用中継口座に試験費用を入れ、ウォレットをロックした状態で受取・ACKを処理します。署名者も残高も試験専用です。チェーン、保管庫、秘密鍵は最後に破棄します。診断ビルドは本番承認された安定版ではありません。

## 自設ローカル環境の設定

既存の、利用者自身が検査したIBC経路を使います。キーを初期化する前に経路、チェックポイント、費用、期限を確認してください。下記のパス、経路ID、数量は実設定へ置き換えます。自動でRPCを探したり、公開RPCへfallbackしたりはしません。

```sh
node relay/policy-from-settings.mjs \
  --settings /path/to/wallet/settings.json \
  --routes ibc-local-a-to-b,ibc-local-b-to-a \
  --fee-atomic 50000 --gas-limit 5000000 \
  --total-fee-atomic 1000000 --max-txs 20 \
  --expires-in-seconds 3600 --output relay-policy.json
```

この生成は草案の作成だけです。上限はチェーンごとに設定され、上記例は両チェーン合算で1,000,000という意味ではありません。手数料は実ネットワークから自動推奨した値ではありません。公開ファイルの内容を確認してから初期化します。

CLIはパスワードをコマンド引数・環境変数で受け取りません。秘密入力には非表示で読んだパスワードのパイプまたは専用FDを使用します。次はBashの例です。`set -x`などのシェルトレースを有効にしないでください。

```sh
read -rs -p '中継保管庫のパスワード: ' RELAY_PASSWORD; printf '\n'
printf '%s' "$RELAY_PASSWORD" | node relay/cli.mjs init \
  --directory "$HOME/.realdex-relay" --password-fd 0 --policy relay-policy.json
unset RELAY_PASSWORD
```

12～1024バイトのパスワードが必要です。生成された公開アドレスに、テスト用の費用だけを入れます。`relay-vault.json`には専用鍵・ポリシー・キュー・署名履歴をまとめて暗号化保存します。利用者の既存保管庫を保存先として指定しないでください。

元チェーンのIBC送信取引ハッシュをキューへ登録します。中継ワーカーの停止中にだけ、同じ保管先を開いて登録できます。

```sh
read -rs -p '中継保管庫のパスワード: ' RELAY_PASSWORD; printf '\n'
printf '%s' "$RELAY_PASSWORD" | node relay/cli.mjs enqueue \
  --directory "$HOME/.realdex-relay" --password-fd 0 \
  --route ibc-local-a-to-b --tx ACTUAL_SOURCE_TRANSACTION_HASH
unset RELAY_PASSWORD
```

初期化時または`status`が表示する`policyHash`を確認してから開始します。

```sh
read -rs -p '中継保管庫のパスワード: ' RELAY_PASSWORD; printf '\n'
printf '%s' "$RELAY_PASSWORD" | node relay/cli.mjs start \
  --directory "$HOME/.realdex-relay" --password-fd 0 --confirm ACTUAL_POLICY_HASH
unset RELAY_PASSWORD
```

`--once`を付けると1回のキュー処理で終了します。ブリッジ完了まで全部処理する指定ではありません。通常の`start`は、明示的に開始したプロセス内で定期処理します。新しいジョブを追加するときは一旦Ctrl+Cで停止してください。最大7日の許可期間が過ぎると停止します。秘密鍵は動作中のメモリに存在します。OS鍵保護・ハードウェア鍵・監査は未実装です。

## 停止、クラッシュ、結果不明

Ctrl+C/SIGTERMは次の署名と送信を止めます。すでに通信を始めた取引は取り消せません。所有者ウォレットのロックは独立した中継プロセスを止めない設計です。中継を止めるにはそのプロセスを停止してください。

署名済み取引とnonce予約を保存した後、送信開始の記録も保存してから送ります。保存失敗ではロックして停止します。署名のみ保存して未送信の場合は、明示的な再起動後に再検査し、**同じ署名済みバイト列**で初回送信できます。

`broadcast-unknown`/`broadcast`は元の取引を読むだけです。自動再送、別sequenceでの再署名、費用の自動増額はしません。結果不明の署名が残るネットワークでは新しい署名を保留します。未解決の予約を安全に解除するコマンドは今回ありません。期限切れ・CheckTx失敗・索引欠落などは運用上の保留になり得ます。

強制終了すると排他ロックが残ります。PIDのプロセスが確実に終了している場合だけ、次を手動実行します。PIDが再利用されていれば拒否します。暗号化データは変更せず、自動再開もしません。

```sh
node relay/recover-lock.mjs --directory "$HOME/.realdex-relay" --dead-pid ACTUAL_OLD_PID
```

その後、再度パスワードとポリシーハッシュを指定して開始します。単なるOS再起動やウォレットの解除で自動起動するサービス登録はしていません。期限/予算更新、鍵の変更、キューのオンライン追加、古いバックアップの復元承認は未実装です。別端末や古い保管庫コピーによる予算巻戻しまで、この仕組みだけで防げません。

## 検証

```sh
node --test --test-concurrency=1 relay/test/*.test.mjs
node --test --test-concurrency=1 integration/ibc/Relay.test.mjs
node app/verify.mjs --ibc --output /path/to/new-acceptance-directory
```

実IBC試験ではネットワークごとに一つのvalidatorを使います。二つの観測URLは同じノードの入口です。ブロックヘッダーの独立検証、公開チェーン、悪意あるvalidator、長期間運用、Windows、鍵保護、独立監査を完了したことにはなりません。
