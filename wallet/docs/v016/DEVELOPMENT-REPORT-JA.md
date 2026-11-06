# RealDEX v0.16 — Stellar / Aptosオンライン送金・実装検証報告

## 基準
入力は `RealDEX-Bitcoin-Settlement-v0.15-2026-09-05.zip`（1120項目）。
SHA-256: `bdd4111544a968db4acc836f37d5ec93da75e4de363b4cd0f831842e6a7a4578`。
過去の同名ZIPや会話中の異なる件数ではなく、この実ファイルを基準に改修しています。

## 実装範囲
Stellar StandaloneのXLM、Aptos local chain ID 4のAPTについて、既存オフライン署名を、所有者専用HTTP API・状態取得・承認・署名・暗号化保存・初回送信・再照合へ接続しました。二つの新しい送金経路であり、鍵方式や新しい2本のチェーンを追加したという件数の数え方はしていません。

| 対象 | 今回 |
|---|---|
| Stellar | Horizonからpassphrase/checkpoint/head/accountsを取得。最低残高・liabilities・マスター署名・memo要否・sequence・費用を検査 |
| Aptos | chain ID/checkpoint/versionを照合。歴史的account/view、認証鍵、sequence、残高、ガス上限、ゼロ署名simulationを検査 |
| 署名 | 既存のXDR/BCS署名実装を再利用し、所有者確認と保管庫の永続化・予約へ接続 |
| 初回送信 | 保存した署名と一致するデータだけをendpoint 0へ送信。送信開始状態も事前保存 |
| 再照合 | 保存した取引・RPC上の処理結果・収録位置・費用を照合。Aptosでは直前/直後versionの残高差分も確認 |
| 共通UI | ネットワーク/口座選択、正確な小数入力、残高、承認、初回送信、履歴再照合、明示設定取込 |
| CLI | 読取り専用のcheckpoint collectorと、外部チェーンに接続しない合成HTTPデモ |

共有ノード・AI・dappへの署名権限は増やしていません。既存のEVM制限・Bitcoin regtest・SOL/SPLローカル経路は維持しています。CosmosとICPは、この基準ソースでは引き続き限定したオフライン署名です。

## 重要な実装判断
新規レビュー時点でsequenceと180秒の取引有効期限を決め、署名直前と初回送信直前に再検査します。同じ依頼キーは、sequenceが進んでも同じ記録を返せるように、利用者指定の受取先・数量・費用条件・設定fingerprintから作る安定したハッシュに結び付けました。既存署名との一致には別途、署名されたsequence・期限・全payloadを検査します。

署名/予約と送信開始状態を順番に永続化します。通信断・ディスク障害・ロック後の遅い応答で、新しい支払いを作りません。未解決の同じ口座・ネットワークは新規署名を保留し、既存オフライン経路による保留の迂回も署名段階で拒否します。

設定を登録する際は所有者の全文確認、ロック、古い要求の取消しを行います。保存失敗では再起動して設定を再読込みするまで解除を許可しません。稼働中の設定置換・既存設定の削除は今回未実装です。

画面上の入力変更・ロック後に届いた古い残高やレビューは破棄します。遅れて生成されたレビューはサーバーでも拒否し、承認待ちとして残しません。

## 信頼境界と制限
**新規2系統は、実署名を検査する合成HTTP試験です。Stellar Core、Aptos VM、独立したノード間合意、公開チェーンの実行試験ではありません。**

Stellarは保存したenvelopeとTransactionResult XDR・単一Payment操作・費用・ledgerを照合しますが、歴史的な口座残高差分やSCP合意の証明はありません。Aptosは保存したsignature/payload/versionと、version前後の残高・sequenceをRESTから比較しますが、LedgerInfoやaccumulator/state proofを検証しません。追加のstorage refund等で期待差分と違えば、推測で受取済みにせず未知状態へ戻します。

どちらも `finalityProven:false` です。確認数を満たした`reported-confirmed`もRPC観測に留まります。ブリッジの解放証拠には使いません。再送・fee bump・置換・取消し・予約解除・複数端末の重複署名防止は未実装です。

Stellarは通常Gアドレス・既存口座・マスター単独署名・ネイティブXLMのみ。Aptosは既存口座・初期Ed25519認証鍵・chain 4・固定APT transfer関数のみ。任意資産・任意関数・新規口座作成・Soroban/鍵ローテーション/複数署名は追加していません。

## 試験
新規80件（owner/API/state 66、transport/config 11、real-runtime readiness 3）を追加しました。実装初期に見つかったAptos公開鍵引渡し不足は修正し、最終試験では回帰を確認しています。初期失敗は新機能の開発過程の問題であり、旧版の既存オンラインAptos機能の不具合とはしていません（旧版に当該オンライン経路はありません）。

| 範囲 | 成功したNode試験数 |
|---|---:|
| wallet単体/所有者API/合成HTTP | 553 |
| 既存node | 1171 |
| app/起動/検証判定 | 73 |
| 既存Anvilネイティブ送金 | 15 |
| 既存LiteSVM SOL / SPL | 14 / 16 |
| 既存Bitcoin Core regtest | 21 |
| 上記実行対象 | 1863 |
| 固定nightlyによるAMM補助試験 | 16 |
| 合計 | **1879** |

失敗・取消し・省略・TODOは0です。範囲は明示的に実行した試験集合であり、未実行のルート全テストを含む「プロジェクト全体合格」ではありません。AMM補助試験は正式0.8.24の合格に数えません。

別枠で、既存の独立パーサー/OpenSSLによる形式・署名照合144ケースと、合成APIのオフラインDOM画面74項目（新画面15、既存Bitcoin18、拡張非EVM29、旧SOL/ICP12）を通しました。これらを1879件へ足し直していません。Keccak等、すべての暗号処理に別実装があるという意味でもありません。

新規APIの型利用例をTypeScript strict/NodeNext/ES2022で検査しています。通常起動の依存パッケージは追加していません。

## 環境と未達のゲート
実行環境はLinux x64 / Node 22.16.0 / Python 3.13.5。基準ソースのルート要求Nodeは24.14.0です。正式コンパイラ0.8.24とルート依存がそろわないため、`--full`のルートビルド・元の全テストはblockedです。npm registryの接続再確認でも名前解決に失敗しました。

既存ブラウザ受入試験は必要な実行ファイル設定がないとblocked、新規画面の実Chromiumループバック接続試行は `ERR_BLOCKED_BY_ADMINISTRATOR` でした。合成APIのDOM成功でHTTP/CSP統合を代用していません。新規2系統の実Core/VMも独立した必須ゲートとしてblockedにしました。

全体ローカル合格・本番判定はfalse、公開ネットワークへの配備は行っていません。Windows実機、OS鍵保護、独立監査、ICP証明書、Cosmosオンライン送信、実ブリッジ、top100全面対応は未達です。

## 原本保全と再現
`contracts/`、`src/`、`node/`、ルートの依存指定・pnpm lockfileはバイト単位で維持しています。ウォレット・appの起動バナー、doctor/verifyの版情報・実行ゲートは更新しています。変更一覧とパッチは配布物を基準に生成します。

最終実行対象ソースのダイジェストは `c3d516353a11950628d473f4963ac710f8e767d2b9f739725da7059d6dce0131` です。これは実行対象ファイル集合の識別子であり、ZIP全体のSHAとは別です。最終ZIPは別ディレクトリへ再展開して試験します。再展開後の結果・ファイル整合性は同時配布の `RealDEX-v0.16-Package-Verification-2026-09-05.json` を参照してください。

## 主な追加ファイル
`wallet/non-evm/account-network.mjs`、`account-payment.mjs`、`stellar-online.mjs`、`aptos-online.mjs`、`account-engine.mjs`、`account-config.mjs`、`account-demo.mjs`、`account-api.d.ts`。
既存 `controller.mjs`、`records.mjs`、`vault.mjs`、`network.mjs`、owner server・画面へ統合しています。

## 参照した一次資料（2026-09-05確認）
- Stellar accounts: https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts
- Horizon account object: https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/accounts/object
- Horizon transaction object: https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/transactions/object
- Horizon ledger object: https://developers.stellar.org/docs/data/apis/horizon/api-reference/resources/ledgers/object
- Aptos Python SDK simulation/submission: https://github.com/aptos-labs/aptos-python-sdk/blob/main/aptos_sdk/async_client.py
- Aptos coin balance view: https://github.com/aptos-labs/aptos-core/blob/main/aptos-move/framework/aptos-framework/sources/coin.move

資料との照合はプロトコル実装の根拠であり、今回の実ノード適合試験を代替しません。mutableなmainの資料から新しい依存コードを自動実行・導入する仕組みは追加していません。
