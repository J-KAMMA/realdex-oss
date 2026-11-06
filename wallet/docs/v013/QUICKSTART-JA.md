# RealDEX v0.13 — 非EVMウォレットの起動・検証

## 目的と対応範囲

所有者のローカルウォレットからSolanaのネイティブSOL送金を準備・承認・署名・暗号化保存・初回送信・再照合できます。送信設定は `127.0.0.1` のローカルRPCのみです。ICPはICRC-1支払い要求をオフラインで署名・保存・出力するまでで、ネットワーク送信や決済証明書の検証はしません。

**未監査です。実資産・本番の秘密鍵・主口座を使用しないでください。** ローカルRPCを本番へ中継して安全制限を迂回しないでください。Solanaの署名にEVM形式のchain IDはありません。ICPのローカル識別名も署名のネットワーク識別子ではありません。

## 更新前

旧プロセスを正常終了し、現在の暗号化バックアップを別の場所へ保全してください。入力版はv0.12 `RealDEX-AMM-Route-Preview-2026-09-05.zip` です。

非EVM履歴がない旧保管庫はそのまま読めます。ただし、非EVM署名を追加すると暗号化データに `nonEvmJournal` が保存されます。**旧バイナリはこの拡張を読めません。** データを編集してこのフィールドを削除しないでください。古いバックアップへの巻き戻しは支払いの重複防止記録も巻き戻します。新しい署名後に古いバックアップで続行することは安全なロールバックではありません。

パスワードと暗号化ファイルの両方が必要です。12/24単語の復元フレーズにはまだ対応していません。今回の検証環境はLinux・Node 22.16.0です。Windows実機は未検証です。

## 起動

ZIPを新しいフォルダーへ展開し、`app/` と `wallet/` が見えるルートで:

```sh
node app/cli.mjs start
```

端末に表示される**所有者専用ウォレットURL**を同じPCで開きます。`#key=` を含むリンクやパスワードは、AI・共有ノード・他人に渡さないでください。一括起動の既定保存先は `~/.realdex-app/`、従来のウォレット単独起動 `node wallet/cli.mjs start` は `~/.realdex-wallet/` です。自動移行はしません。

追加ローカルサービスの通常起動に `npm install` やPython/Soldersは不要です。既存のReact全体ビルドと、今回のNodeウォレット静的画面の起動は別です。

## SOL送金

ウォレット一覧の「口座を追加する」でSolana・新規作成を選択します。暗号化バックアップを保存し、読み戻して口座の一致を検証してください。追加した口座はEVM・ICPと別鍵です。

「Solana と ICP」内のネットワーク追加欄に、自分で確認した設定を入れます。以下は**テンプレート**です。genesisHashを実際のローカルチェーンの値へ置き換えない限り有効ではありません。

```json
{
  "id": "solana-local:my-dev",
  "name": "My local Solana",
  "family": "solana",
  "cluster": "localnet",
  "genesisHash": "REPLACE_WITH_YOUR_FULL_BASE58_GENESIS_HASH",
  "rpcUrls": ["http://127.0.0.1:8899/", "http://127.0.0.1:8900/"],
  "broadcastEnabled": true,
  "maxFeeLamports": "10000",
  "maxTransferLamports": "1000000000"
}
```

URLは2～4件で、userinfo・クエリ・フラグメントは禁止です。URL数は独立ノード数の証明ではありません。初期値の検査はRPCへの信頼を必要とします。`ADD <id> <genesisHash>` を全文入力して追加すると、保存前にウォレットをロックします。再解除してください。保存失敗では再起動が必要です。

Solana口座、ネットワーク、受取先、SOL数量、支払い識別キーを指定します。数量は最大9桁の小数を受け付け、最小単位への変換は署名サービス側で行います。送金元はSystem Program所有・データなしの通常口座に限定します。durable nonce、任意命令、SPL、Token-2022、優先手数料命令、複数署名、swapは扱いません。

「SOL送金を照合」は未署名のシミュレーションです。下部の承認待ちで、送金先全体を再入力してください。チェックボックスを有効にした場合だけ、署名を暗号化保存してからローカルRPCへ送信します。

チェックせず署名だけ保存した場合は、非EVM履歴で保存済みの署名IDを全文再入力し、「保存済みSOL署名を初めて送信」を使えます。既に送信した／結果不明の記録を再送する機能ではありません。署名後の費用変更やblockhash期限切れは拒否します。

## 送信後と結果不明

RPCが署名IDを返しても、受取完了ではありません。履歴の「SOLの状態を再照合」で、保存した取引バイト列、署名、RPC報告の状態、実行前後の残高、手数料を照合します。

`reported-finalized` はRPCがfinalizedと報告し、取得した実行内容の整合が確認できた状態です。ライトクライアントや合意の独立証明ではありません。受取証が消える・食い違う場合は、成功表示を取り消します。

同じ口座・ネットワーク・支払いキーは記録済みの結果を返します。内容を変えると拒否します。新しいキーは別の支払いです。**結果不明のまま別キーで支払わないでください。** 未解決の署名がある口座・ネットワークは別の署名を拒否します。期限切れでも自動的に履歴を消し、再署名、予算返却、blockhash更新をしません。解除・置換・アーカイブの安全な運用UIは未実装です。

ロックすると進行中処理は署名・送信境界で再検査されます。ただし通信開始済みの送金や、既に他者が得た署名をロックで取り消すことはできません。

## ICPのオフライン要求

ICP口座を作成し、バックアップを検証します。`icp:local-...` 形式のローカル識別名、Ledger canister ID、受取principal、任意の32バイトsubaccount、数量・手数料の**最小単位整数**を指定します。空のsubaccountはゼロです。台帳の手数料・桁数・残高を自動取得した送金ではありません。

承認時にcreated_at_time、memo、台帳、受取口座、数量、手数料を表示します。受取principalを再入力した場合だけ、署名済みCBOR/Candid要求を暗号化履歴へ保存します。「ICP署名済み要求を保存」は所有者向けのローカルファイル出力です。**出力には送金能力を持つ署名が含まれるので共有しないでください。** 送信ボタン、`read_state`証明書検証、実ICPの完了判定はありません。

同じ依頼キーの再要求は、保存済みのmemo・created_at_time・署名を返します。別の手数料・宛先・明示memoなどへの差替えは拒否します。台帳側の重複排除や台帳コードの真正性まで証明したわけではありません。署名付き要求は短い有効期間を持ち、出力の再署名・期限延長を自動化しません。

## LiteSVMを使う再現試験（Linux x86-64）

別配布の `RealDEX-Solana-Test-Toolchain-2026-09-05.zip` を使います。通常起動には不要です。

```sh
python3 -I integration/solana/pinned_runtime.py \
  --archive /absolute/path/RealDEX-Solana-Test-Toolchain-2026-09-05.zip --check

REALDEX_SOLANA_TEST_ARCHIVE=/absolute/path/RealDEX-Solana-Test-Toolchain-2026-09-05.zip \
  node --test --test-concurrency=1 integration/solana/NativePayments.test.mjs

REALDEX_SOLANA_TEST_ARCHIVE=/absolute/path/RealDEX-Solana-Test-Toolchain-2026-09-05.zip \
  node app/verify.mjs --solana --output acceptance-solana-new
```

アーカイブ、wheel、42個のパッケージファイルのハッシュを照合してから一時フォルダーへ展開・読み込みます。依存の自動ダウンロードやpip実行はしません。未配置・不一致の場合は試験を省略合格にせず失敗／blockedにします。

LiteSVMの署名検証・System Program実行・残高変化は実際に動きます。一方、試験RPCのgenesis、slot、height、finality報告は合成メタデータです。二つのURLの背後も一つのLiteSVMです。**Agave validator、公開クラスタ、分散合意の試験ではありません。** `test_*` メソッドを持つ試験用サーバーを通常ノードとして使わないでください。

全体の未達を含めて調べるには `--full --solana` を指定します。固定EVMコンパイラ・正式依存・実ブラウザ・独立レビューなどの代わりにはならず、本番利用判定はfalseのままです。
