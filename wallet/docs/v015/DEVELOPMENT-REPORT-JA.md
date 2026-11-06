# RealDEX v0.15 — Bitcoinオンライン処理・検証報告

## 基準と変更範囲

基準は今回実在を確認した `RealDEX-Expanded-Non-EVM-v0.14-2026-09-05.zip`（1,062ファイル、SHA-256 `8a6926a2ff96881928e29a8b61ae6b54ee28162b0a0304ac21574a4a59ad40d8`）です。以前の未完了v0.15作業ソースは残っていなかったため、このZIPから実装しました。過去の説明に同じ版名・異なる試験数があっても、今回の基準ファイルと実ログを優先します。

BitcoinオンラインRPC、損失のない金額解析、資金元取引パーサー、ブロック/Merkle照合、所有者API、ウォレット画面、設定収集CLI、Bitcoin Core統合試験、型宣言、明示的な検証ゲートを追加しました。既存の `contracts/`、`src/`、`node/`、ルート依存指定・lockfileは変更していません。共有ノードとAIの署名権限も増やしていません。

## 実装

### 送金前

手動固定したregtest genesisとcheckpoint、2〜4個の明示ループバック入口、同期とtxindex、同一tipを照合します。自分のアドレスをscantxoutsetで走査し、gettxout(include_mempool=true)、資金元の実raw transactionと所有script、金額を検査します。coinbaseは保守的に101確認以上。過去に署名した入力は別の依頼でも予約済みとします。

RPCのBTC金額はJavaScript Numberへ変換せず、JSONの数値字句を文字列で保持してBigIntでsatoshiへ変換します。指数表記も厳密に処理し、1satoshi未満の小数・負数・総供給量超過等を拒否します。

同じCoreに対する並列scantxoutsetが拒否される挙動を実ノードで検出し、入口ごとの走査を順序化しました。最初の統合試験はこの点で9件失敗し、順序化後に修正を確認しています。続く1件はブロック巻戻し時の試験用txindex待機条件を是正しました。失敗ログを最終成功とは分けて保全しています。

### 署名と保存

所有者の確認は60秒の内容固定要求で、受取先全文の再入力を要求します。署名前に再検査し、独立したBitcoin鍵で限定P2WPKH取引へ署名します。初期状態の送信チェックはOFFです。

署名と入力予約を暗号化保存し、初回送信前にtestmempoolacceptのtxid/wtxid/vsize/手数料を照合してbroadcast-unknownを保存します。その後に一度だけsendrawtransactionを呼びます。保存失敗、ロック、設定指紋変更で停止します。受理後に返事を失っても新しい支払いへ置き換えません。

### 結果照合

保存した署名済み取引とCoreからのraw transactionが完全一致することを確認します。ブロックヘッダーhashとMerkle rootをローカルで再計算し、指定txidの収録を結び付けます。RPCが報告するactive chainと高さ、必要確認数も照合します。欠落・不一致・invalidateblock後は受取観測を撤回します。予約した入力は自動解除しません。

`reported-confirmed` はRPCの観測です。ヘッダーチェーン、PoW、ネットワーク合意の独立証明ではなく、`finalityProven: false` として区別します。ブリッジの資金解放には使用しません。

### UI・API・設定

UTXO走査、BTC小数入力、satoshi総手数料、sat/vB上限、承認、署名のみ、初回送信、結果再照合を所有者画面へつなぎました。遅れて届く走査・確認結果は入力変更やロック後に破棄します。Bitcoin手数料の例は `0.00001 BTC-regtest (1000 satoshi)`、SOLも `0.000005 SOL (5000 lamports)` と表示し、最小単位を通貨量として誤表示しないようにしました。

APIは型宣言と厳格TypeScript利用例を付けました。設定収集CLIは読み取りだけ、出力先の上書き不可、broadcastEnabledの既定falseです。資格情報はファイルパスのみを設定し、Cookie内容を出力しません。

## 開発ソースで完了した試験

| 対象 | 件数 | 結果 |
|---|---:|---|
| ウォレット単体・HTTP | 476 | 全成功 |
| 既存ノード等 | 1,171 | 全成功 |
| アプリ・検証ツール | 70 | 全成功 |
| 実Anvilネイティブ送金 | 15 | 全成功 |
| LiteSVM SOL | 14 | 全成功 |
| LiteSVM SPL | 16 | 全成功 |
| **実Bitcoin Core regtest** | **21** | **全成功** |
| **上記合計** | **1,783** | **失敗・取消・省略・TODOなし** |
| 固定nightly AMM補助試験（別枠） | 16 | 全成功 |

全実行テストは1,799件。基準版の1,732件から67件を追加しています（Bitcoin単体41、実Core21、検証ツール5）。単体試験内部の300金額ケース等を件数へ足し直していません。

別枠でPython/OpenSSL等による既存96＋四系統48の形式・署名照合、旧拡張画面29項目＋新Bitcoin画面18項目のオフラインDOM検査、型検査が成功しました。これらは1,799件へ足し直していません。

配布ZIP再展開後の最終件数・ハッシュ・実行結果は、ZIP本体のSHA-256を含む外側の `RealDEX-v0.15-Package-Verification-2026-09-05.json` を参照してください。開発時の結果だけを再展開試験の代わりにはしません。

## 実Coreの21シナリオ

1. 走査・所有者HTTP確認・署名・mempool受付・正確な受取出力/お釣り/手数料。
2. 同じ支払いキーの再使用は同一記録を返し、送信一回。内容変更を拒否。
3. Coreが実際に受理した後のHTTP応答喪失と、再送なしの照合。
4. 未成熟coinbaseを署名前に拒否。
5. 未署名確認は予約せず、最初の署名で入力を予約。
6. 確認後に使用された入力を署名前に拒否。
7. 署名のみから、txid全文確認による同じバイト列の初回送信。
8. 実ブロックのinvalidate/reconsiderによる確認撤回と予約保持。
9. 署名前のUTXO再照合中のロック。
10. 署名保存失敗による送信防止・ロック。
11. 異なるgenesisと金額を返すRPCの拒否。
12. ブロック証拠の改変による成功観測撤回。
13. 最新バックアップ復元後の署名・入力予約保持。
14. mempool事前検査中のロックで署名を保持し送信しない。
15. 受理済み応答が遅れても、ロック・再解除した新セッションを書き換えない。
16. broadcast-unknownの保存失敗でも送信しない。
17. オフラインBitcoin署名をオンライン送信へ昇格しない。
18. 不正capability/Origin/受取先確認を拒否。
19. 誤ったtxidを返す応答は不明扱い。保存済みの本来の取引で照合。
20. 期限切れ・設定指紋変更を署名前に拒否。
21. 設定収集CLIは読み取りのみ、送信OFF、上書き拒否。

## 試験環境・未達

Linux x86-64、Node 22.16.0、Python 3.13.5、Chromium 144.0.7559.96。固定Bitcoin Core CI開発ビルド `v31.99.0-031175197f1b`、二つのHTTP入口から一つのCoreへ転送し、P2P無効のregtestを使用しました。Coreは独立プロセスで取引署名、コンセンサスルール、UTXO更新、mempool、採掘を処理します。ただし分散ノード・ネットワーク再編を試験したものではありません。

全体の固定Node・ルート依存・正式Solidity 0.8.24は不足し、ルートビルド等はblocked。取得先へのDNSエラーも記録しています。nightlyによるAMM補助成功は正式基準の成功へ昇格しません。実ブラウザHTTPはローカルサービスのHTML/CSP取得後、管理ポリシーで遮断されました。オフラインDOM成功で代用しません。

全体ローカル検証、本番判定、公開テストネット、Windows/OS鍵保護、外部監査は未達です。Bitcoin再送/RBF/HD/PSBT、非EVMスワップ/ブリッジ、ICP証明書、Cosmos/Stellar/Aptosオンライン送信などは今回未実装です。時価総額上位100位の全対応を意味しません。

## 一次資料（照合用）

- Bitcoin Core gettxout: https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/
- Bitcoin Core sendrawtransaction: https://bitcoincore.org/en/doc/30.0.0/rpc/rawtransactions/sendrawtransaction/
- Bitcoin Core scantxoutset: https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/scantxoutset/
- Bitcoin BIP143: https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki
- 試験ツール: bitcoin-core/HWI, run 32899502994, artifact 9584237798。配布ZIPと本体をそれぞれ固定ハッシュで検査。
