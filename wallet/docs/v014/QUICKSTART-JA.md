# RealDEX v0.14 — 非EVM拡張 開始・更新手順

2026-09-05。開発版・未監査。実資産と実資産のある秘密鍵を使用しないでください。

## 更新と起動

旧プロセスを正常終了し、暗号化バックアップを保全します。新しいZIPは別フォルダーへ展開し、リポジトリのルートから実行します。

```sh
node app/cli.mjs start
```

ウォレットと読み取り専用ノードを別プロセスで起動します。ウォレットはターミナルに表示される所有者専用URLで開きます。`#key=`を含むURLをAIや他人へ渡さないでください。通常の追加ローカルサービスの起動にnpm installは不要です。Node 22.16.0で試験しました。これはルートReactビルドの依存が不要という意味ではありません。

一括起動の既定保存先は `~/.realdex-app/`。以前の単独保存先を使う場合は `node wallet/cli.mjs start` を使います。保存先の自動移行はしません。

新しい系統の口座や署名履歴を保存した保管庫は、旧バイナリで開けない場合があります。旧版で上書きしないでください。旧バックアップへの巻戻しは、使用済みUTXO・sequenceやAI予算の記録も巻き戻すため、取消しではありません。

## 共通の準備

所有者画面で保管庫を作成・解除し、対象系統の**使い捨て試験口座**を新規作成します。全系統で鍵は独立し、12/24単語のHDウォレットではありません。暗号化バックアップを保存し、同じファイルを読み戻して検証しないと署名できません。

今回追加した選択肢はBitcoin regtest、Cosmos SDK local、Stellar standalone、Aptos local 4です。これらはオフライン署名用で、ネットワーク送信や残高取得は実装していません。

## SPL Tokenを送る

「非EVMウォレット」内の専用フォームを使います。従来のToken Programのみです。自分と相手の**既存トークン口座**が必要です。ATAの導出・作成、wrapped SOL、Token-2022、委任、close authority、凍結口座には対応しません。

新規のローカルSolana設定を登録する際に、`splTokens`を含めます。genesis、ミント、桁数、RPCは自分の試験環境で確認した値に置き換えます。次は構造例で、そのまま使える接続設定ではありません。

```json
{
  "id": "solana-local:my-test", "family": "solana", "cluster": "localnet",
  "name": "My local validator", "genesisHash": "実際に確認した初期ハッシュ",
  "rpcUrls": ["http://127.0.0.1:8899/", "http://127.0.0.1:8900/"],
  "broadcastEnabled": false, "maxFeeLamports": "10000", "maxTransferLamports": "1000000000",
  "splTokens": [{"mint": "実際のミント", "symbol": "TEST", "decimals": 6, "maxTransferAtomic": "1000000000"}]
}
```

既存設定の安全なインプレース更新UIはありません。履歴があるネットワークの識別名や設定を変えて未解決取引の制限を迂回しないでください。今回のSPL評価には新しい使い捨て保管庫・試験環境を推奨します。通常署名に既存EVM設定の変更は必要ありません。

送金フォームで、署名口座、ネットワーク、ミント、送信元トークン口座、受取トークン口座、その受取口座の所有者、表示数量、支払いキーを指定します。自分の既存トークン口座を調べるボタンは読み取り専用です。

照合後、別の承認欄に全受取先を再入力します。送信チェックは既定OFF。署名・保存だけを選ぶこともできます。送信するにはネットワークの `broadcastEnabled` と所有者チェックの両方が必要です。支払いキーを変えて同じ請求を繰り返さないでください。

手数料はSOL残高から、送金額は指定SPL口座から引かれます。ミント・桁数・口座所有者・残高・有効期限を再検査します。受取証では保存した取引バイト、SPL残高差分、SOLの手数料差分を照合しますが、RPC照合はコンセンサス証明ではありません。

## 4系統のオフライン署名

系統と口座を選び、「入力例に置き換える」でスキーマを表示します。例のアドレス・UTXO・sequence等は実際に確認した試験値へ置き換えます。整数は文字列です。取引状態が未認証である旨のチェックが必要です。

- Bitcoin: `bitcoin:regtest`、bcrtのv0 P2WPKHのみ。1〜16個の自分のUTXO、相手への出力と自分へのお釣りのみ。version 2、SIGHASH_ALL、非RBF。330 satはこの版の保守的な出力下限で、全ノード共通のdust規則ではありません。入力額は外部で確認し、過大な手数料を指定しないでください。
- Cosmos SDK: `realdex-local-*`。標準secp256k1、SIGN_MODE_DIRECT、単一MsgSend。accountNumber、sequence、gas、timeoutHeight、denomと手数料denomを固定します。任意Msg・IBC・authz・Ethermint固有鍵方式は未対応です。
- Stellar: `Standalone Network ; February 2017`。通常Gアドレス、単一XLM Payment。sequence、時間上限、手数料、28バイト以内のmemoを固定します。既存口座への支払いだけで、CreateAccount、muxed account、multisig、Sorobanは未対応です。
- Aptos: chain ID 4、鍵ローテーションのないEd25519初期認証口座。`0x1::aptos_account::transfer`だけをBCSに変換します。sequence、最大ガス量、ガス単価、期限を固定します。手数料欄は最大値であり実消費額ではありません。

署名確認では全条件が表示されます。受取先を再入力して承認すると、署名と使用済みUTXO/sequenceを暗号化保管庫へ一緒に保存します。**送信しません**。履歴から署名済みファイルを明示的に保存できます。署名済みファイルは送金能力を持つため、AIや共有ノードへ渡さないでください。

ローカル履歴にある同じUTXO/sequenceの再署名を拒否しますが、他アプリ・別端末・古いバックアップに対するオンチェーン制限ではありません。画面の承認期限60秒が過ぎても、作成済み署名まで無効化されるとは限りません。特にBitcoinの署名には、この60秒の期限は入りません。

## 出力した署名ファイルを読み取り検査

```sh
node wallet/non-evm/verify-export.mjs --input /path/to/signed-record.json
```

秘密鍵、RPC、ネットワーク接続は不要です。署名と取引内容の一致を検査しますが、ファイルが特定の所有者から来たこと、実残高、未使用UTXO、実行・確定は証明しません。

## 再試験

```sh
node wallet/test/run.mjs
node node/test/run-tests.mjs --with-release
node --test app/test/*.test.mjs
python wallet/test/expanded-independent.py --output independent-new.json
```

Python試験だけはcryptographyを必要とします。LiteSVMは別の固定ツールアーカイブを指定します。通常起動には不要です。

```sh
REALDEX_SOLANA_TEST_ARCHIVE=/absolute/path/RealDEX-Solana-Test-Toolchain-2026-09-05.zip \
  node app/verify.mjs --solana --output acceptance-new
```

Windows PowerShellは環境変数を `$env:REALDEX_SOLANA_TEST_ARCHIVE = '...'` で設定します。今回Windows実機は未検証です。

`--solana`と`--full`はSOL試験とSPL試験の両方を要求します。`--full`でも正式コンパイラや依存がなければblockedです。実ブラウザのHTTP/CSP試験をオフラインDOM試験で置き換えません。
