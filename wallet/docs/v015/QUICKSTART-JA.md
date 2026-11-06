# RealDEX v0.15 — 起動・Bitcoin regtest・再検証

## 目的と対象

Bitcoin P2WPKHの所有者署名を、UTXO確認、初回送信、収録再照合まで接続した開発版です。**未監査。実資産・本番秘密鍵を使用しないでください。** 対応先はBitcoin Coreのローカルregtestのみです。Bitcoin Mainnet、signet、testnet、Taproot、PSBT、RBF、再送、スワップ、ブリッジは含みません。

## 更新と起動

旧プロセスを正常終了して、暗号化バックアップと設定を別に保全します。新ZIPを別フォルダーへ展開し、`app/`、`wallet/`、`node/`のある場所で実行します。

```sh
node app/cli.mjs start
```

追加ローカルサービスの通常起動にnpm install、Bitcoin Core、Anvil、Soldersは不要です。ウォレットはターミナルに表示される所有者専用URLを同じPCで開きます。`#key=`を含むURL・保管庫パスワードはAI、共有ノード、他人に渡さないでください。

一括起動の既定保存先は `~/.realdex-app/`、従来の `node wallet/cli.mjs start` は `~/.realdex-wallet/` です。保存先の自動移行はありません。

## 最短のBitcoin実行確認

固定したBitcoin Core試験用バイナリを使用する使い捨てデモです。既存ユーザー保管庫を開きません。新しいregtest、無価値な採掘残高、試験口座を作り、終了時に削除します。P2Pと公開ネットワーク接続は無効にしています。

別配布の `RealDEX-Bitcoin-Core-Test-Toolchain-2026-09-05.zip` のSHA-256:

```text
7120a949b516e692d0dd197a3820308b704c89d97163f0f2b99e133aadef61cc
```

LinuxでZIPを展開し、中の `bitcoind.tar.gz` を展開します。対象バイナリは `test/work/bitcoin/build/bin/bitcoind` です。パスに応じて次を設定します。スクリプトは実行前にバイナリのSHA-256・サイズ・モードを照合します。

```sh
chmod 755 /absolute/path/test/work/bitcoin/build/bin/bitcoind
export REALDEX_BITCOIND_BINARY=/absolute/path/test/work/bitcoin/build/bin/bitcoind
node integration/bitcoin/demo.mjs
```

期待する主な結果は `amountSats: "100000"`, `feeSats: "1000"`, `actualSubmissions: 1`, `sameRequestReused: true`, `inclusion: true`, `finalityProven: false` です。txidは実行ごとに変わります。

このバイナリは bitcoin-core/HWI の固定CI成果物、Bitcoin Core開発ビルド `v31.99.0-031175197f1b` です。安定版の本番配布物ではありません。Windowsでの実行確認はしていません。

## 自分のregtestへ画面を接続する

### 1. 無価値の試験口座とCoreを用意

ウォレットで独立したBitcoin口座を新規作成し、暗号化バックアップを保存して読み戻し確認します。Coreには秘密鍵を渡しません。Core側はunpruned / `-txindex=1`、同期完了が必要です。

本版の設定は2〜4個のローカルHTTP入口を要求します。一つのCoreを二つのポートで待ち受けさせる例は以下です。**二つの入口でも同じノードであり、独立ノードの合意ではありません。** 自分が作った空の開発用ディレクトリに限定してください。

```sh
bitcoind -regtest -server=1 -txindex=1 -disablewallet=1 \
  -networkactive=0 -listen=0 -dnsseed=0 -discover=0 \
  -rpcallowip=127.0.0.1 \
  -rpcbind=127.0.0.1:18443 -rpcbind=127.0.0.1:18444 \
  -datadir=/absolute/path/to/empty-regtest-directory
```

自分のregtest操作ツールでブロックを生成し、ウォレットの新規bcrt1アドレスへ試験用出力を作ります。coinbase出力は本版では101確認以上を要求します。実行デモと統合試験はこの準備も自動化します。

### 2. 読み取り専用の設定収集

Coreの `.cookie` は一般にそのデータディレクトリ内の `regtest/.cookie` にあります。POSIXでは所有者限定の通常ファイル（グループ・他者権限なし）を要求します。Cookie内容をフォームへ貼り付けないでください。

```sh
node wallet/non-evm/bitcoin-config.mjs \
  --rpc-url http://127.0.0.1:18443/ \
  --rpc-url http://127.0.0.1:18444/ \
  --cookie-file /absolute/path/to/empty-regtest-directory/regtest/.cookie \
  --checkpoint-height 1 \
  --output bitcoin-regtest.json
```

既存出力ファイルは上書きしません。生成結果は `broadcastEnabled: false` です。genesisに加え、ブロック1等のcheckpoint hashを、独立に確認した自分のCoreの情報と照合します。同じRPCから値を取るだけで真正性を証明できるわけではありません。

一つの設定は一つのcookieFileを全入口に使います。異なる認証情報を持つ複数Coreの設定は未対応です。Cookieを受け取る入口・中継の運営者は信頼境界です。

### 3. 明示的に登録

送信する場合だけ、JSONの `broadcastEnabled` を `true` に変更します。最大送金額・最大総手数料・最大手数料率・必要確認数を確認します。

画面「Bitcoin Core・regtest送金」→「自分のBitcoin Core接続設定を登録」にJSONを貼り付け、以下を入力します。

```text
ADD bitcoin:regtest <checkpointの64桁ハッシュ>
```

登録時はロックされます。再解除してください。既存Bitcoin設定のUI更新・複数regtest登録は未実装です。設定全体の指紋は保存済み取引に結び付くため、cookieのパス・URL・上限・送信可否を勝手に書き換えると旧取引の送信・照合を拒否します。手作業で移行する前にバックアップと仕様を確認してください。

### 4. 走査・確認・署名

「自分のUTXOを走査」で、所有アドレスの確定UTXOを表示します。この問い合わせはアドレスを接続先へ開示します。自動走査や公開RPCへの切替はありません。最大512候補、署名入力は最大16件です。

最初の利用可能なUTXO一件を仮入力します。必要に応じて入力を手動選択します。最適な手数料・最小の情報開示を実現するcoin selectionではありません。

数量はBTCの小数文字列、総手数料はsatoshi、率上限はsat/vBです。未使用確認・所有script・資金元の実取引・成熟・手数料等を検査します。確認画面で受取先を全文再入力し、署名します。送信チェックは既定でOFFです。

署名のみの場合、履歴からtxid全文を再入力して初回送信できます。旧版のオフライン署名を後付けでオンライン送信する機能はありません。

### 5. 送信後

受付は受取完了ではありません。「Bitcoinの収録状態を再照合」で保存済み取引の一致、ブロックヘッダーhashとMerkle root、RPCが報告するactive chain、確認数を検査します。必要確認数未達・欠落・不一致では受取観測を取り消します。

**送信後の再送・RBF・自動置換はありません。** 結果不明でも予約した入力を自動解放しません。誤って別キーで同じ請求を作ることを意味的に判別する機能もありません。

## 復元と互換性

現在の暗号化バックアップを復元すると、署名データと入力予約は保存されます。通常のバックアップ読み戻し確認後の利用という既存動作を維持し、新たな「復元保留の解除機能」を実装したわけではありません。古いバックアップ・別端末・別ウォレットでの二重署名を全世界的に防ぐことはできません。

新しいオンラインBitcoin記録を保存した保管庫は旧版では読めません。旧版で開く・上書きすることや、新規署名後に古いバックアップへ戻ることは避けてください。保管庫上限（非EVM履歴128件等）と安全な履歴アーカイブ未実装という制約は維持しています。

## 再試験

```sh
node app/verify.mjs --bitcoin --output acceptance-bitcoin-new
```

REALDEX_BITCOIND_BINARYが未指定・不一致ならBitcoin試験はblockedで、要求範囲の合格になりません。全体判定は以下です。

```sh
node app/verify.mjs --full --bitcoin --solana --output acceptance-full-new
```

Anvil、Soldersアーカイブ、固定正式Solidityコンパイラ、ルート依存、実ブラウザ環境が別途必要です。補助nightlyで正式コンパイラの検証を置換しません。本番承認は常に別の未達条件として残します。
