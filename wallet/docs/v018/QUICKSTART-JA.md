# RealDEX v0.18 — 更新・Aptos実行検証

## 用途と制限

未監査のローカル開発版です。実資産、本番口座の鍵、運用中のvalidatorデータを使用しないでください。今回の変更はAptosの実ノード適合と、Stellar/Aptosの外部応答検査です。メインネット、AIの新しい署名権限、スワップ／ブリッジ、Stellar Core実行を有効化していません。

## 起動・更新

旧プロセスを正常終了し、暗号化バックアップと設定を保全してください。新ZIPを別フォルダーへ展開し、app/・wallet/・node/がある場所で実行します。

```sh
node app/cli.mjs start
```

追加Nodeサービスの通常起動にnpm installやAptos CLIは不要です。Node 22.16.0で試験しています。ルートReactプロジェクトの固定ランタイム・依存条件は別です。

所有者ウォレットはターミナルの専用URLから開きます。`#key=`付きURLをAI・共有ノード・他人へ渡さないでください。一括起動の保存先は通常 `~/.realdex-app/`、旧来のウォレット単独起動は `node wallet/cli.mjs start` と `~/.realdex-wallet/` です。保存先の自動移行はしません。

v0.17から保管庫の形式・鍵導出・API権限・送信対象は変えていません。v0.17で生成した無価値の署名済み記録をv0.18へ復元する試験を行っていますが、任意の過去バックアップの安全性を保証しません。新しい署名後に古いバックアップへ戻しても署名は取り消せず、古い予約状態を再利用する危険があります。

## 既存画面からのAptos操作

「Stellar・Aptos」所有者用画面の既存操作を使います。既に存在する通常のEd25519口座間のAPT送金だけで、送信チェックは既定OFFです。自分のローカルchain ID 4と、独立に確認したcheckpoint・2～4件のloopback HTTP URLを登録します。ローカルURLだけでは公開チェーンへの中継がないことを証明できません。

受取先のユーザー入力は引き続き `0x`＋64桁を要求します。RPCが返す同じ32バイトの短縮アドレスは比較前に正規化します。シミュレーションは公開鍵とゼロ署名だけで行い、実署名は所有者承認後に生成・暗号化保存します。結果不明の記録は自動再署名・再送・予約解除をせず、同じ記録を再照合します。

## 実Aptosノード試験の再現

別配布の `RealDEX-Aptos-Test-Toolchain-2026-09-06.zip` を使います。このファイルは試験専用です。

```sh
python3 integration/aptos/provision.py --archive /absolute/path/RealDEX-Aptos-Test-Toolchain-2026-09-06.zip --output /absolute/path/NEW-aptos-tools
export REALDEX_APTOS_BINARY=/absolute/path/NEW-aptos-tools/aptos
node --test --test-concurrency=1 --test-reporter=tap integration/aptos/Payments.test.mjs
node integration/aptos/demo.mjs
```

既存の出力フォルダーは上書きしません。展開時と実行時に固定ハッシュを確認します。Linux x86-64のCLI 9.5.1を固定し、APIのcore Git hashも一致させます。使い捨て口座・ローカルfaucet・一つのvalidatorで試験し、二つのHTTP入口は同じvalidatorへ転送します。正常終了時は一時データを削除します。強制終了時に残った一時データは実運用データと混同しないでください。

## 合否判定

```sh
# 通常の選択試験＋Aptos。必要ツールがなければ成功終了しません。
node app/verify.mjs --aptos --output acceptance-aptos-new

# Stellarは実Quickstart用preflightを実行します。現在はimmutable image digest未登録ならblockedです。
node app/verify.mjs --stellar --output acceptance-stellar-new

# 全体。未実装・依存不足も正直に未達として記録します。
node app/verify.mjs --full --output acceptance-full-new
```

出力フォルダーは新しい場所を指定してください。`--aptos` / `--stellar` の重複は拒否します。`aptos-local-runtime` は実ノード試験です。`stellar-core-runtime` は固定Quickstart image digestがまだ正本へ登録されていないためblockedです。可変tagや合成HTTPから実ノード合格を推定しません。形式試験や合成RPC試験から実ノード合格を推定しません。正式コンパイラ0.8.24がない場合にnightlyへ自動切替えすることもありません。

全体判定のfalseを、プレビューが起動しないという意味と混同しないでください。本番承認・独立した決済証明・全機能完成ではない、という意味です。今回の実測結果は同梱 `wallet/evidence/v018/` を参照してください。
