# RealDEX v0.17 — Cosmos SDK送金・実ノード検証 開発報告

2026-09-06（日本時間） / 0.17.0-dev.20260906

**未監査・ローカル開発版です。本番公開、実資産、AIへのCosmos署名権限を許可した版ではありません。**

## 基準と今回の成果

入力は `RealDEX-Account-Settlement-v0.16-2026-09-05.zip`、SHA-256 `1825e879e49795d5f18c41873e3954906ffe9cdd6885cb0d78215931c9c6b75b`、1,146ファイルです。会話中の旧版の件数を流用せず、このZIPを展開して変更しました。

Cosmos SDK向けに、状態取得・所有者の確認・署名・暗号化保存・初回送信・結果照合を追加しました。既存の限定オフライン署名を再利用し、共有ノードとAIの権限は増やしていません。通常のウォレット・ノード・アプリ試験に70件、実simd試験に13件、計83件を追加しました。

## 実装内容

| ファイル | 主な役割 |
|---|---|
| `wallet/non-evm/cosmos-network.mjs` | ローカル設定、許可RPC、厳密なJSON、応答容量・時間・状態取得高さの制限 |
| `cosmos-online.mjs` | 既知checkpoint、accountNumber・sequence・公開鍵・spendable balance、ゼロ署名のsimulation、初回送信、収録とイベント照合 |
| `cosmos-engine.mjs` | 所有者専用の承認、期限・epoch検査、署名と履歴保存、結果不明・再照合の状態遷移 |
| `cosmos-payment.mjs` / `cosmos-proof.mjs` | 数量・費用・署名内容・設定fingerprintの束縛、CometBFTの取引Merkle包含検査 |
| `cosmos-config.mjs` / `cosmos-api.d.ts` | 読み取り専用の設定収集CLIと公開型 |
| `wallet/lib/vault.mjs` / `non-evm/records.mjs` | 新履歴の保存・検査、未解決取引のオフライン署名迂回を拒否 |
| `wallet/public/` / `non-evm/controller.mjs` | 所有者画面・API・後から届く古い応答の破棄、390px幅での折返し |
| `integration/cosmos/` / `app/verify.mjs` | 固定simdの実行、13シナリオ、合否ゲート、使い捨て送金デモ |

## 対象の限定

標準secp256k1 BaseAccountによる単一 `cosmos.bank.v1beta1.MsgSend` のみです。公開Cosmos HubやOsmosisは対象外です。chainIdは `realdex-local-*`、URLは127.0.0.1の明示ポート、2〜4組のCometBFT RPC/SDK RESTを要求します。初期設定で送信はOFF、上書き編集は未実装です。送信する試験は、checkpointを独立確認し、初回登録前にtrueへ変更して全文確認します。

送金と費用のdenomが同じ場合は両方、異なる場合はそれぞれの残高を検査します。数量・feeは正確な整数で扱います。表示名・桁数は利用者の設定であり、トークンの真正性を自動証明しません。手数料は固定総額、gasLimitは別の使用量上限です。gas価格oracle、自動fee増額、feegrant、IBC、authz、vesting・module口座、複数署名、任意メッセージはありません。

初回照合・署名直前・初回送信直前に状態を読み直します。simulationにはゼロ署名だけを送り、本物の送金署名を事前検査に使いません。RESTの状態取得は指定heightと応答headerの一致が必要で、未対応ならlatestへfallbackせず拒否します。

## 保存・ロック・重複と結果不明

署名とsequence予約を暗号化保存した後、ネットワークへ送る前に `broadcast-unknown` も永続化します。保存失敗では送信しません。ロックは古いepochの要求を失効させ、送信開始済みを取消済みとは表示しません。

同じ支払いキー・同じ内容には保存済みの記録を返します。キーが同じで内容が違えば拒否します。別キーは別支払いであり請求の意味の同一性までは判定しません。未解決取引がある口座とネットワークでは新しい署名を拒否し、既存オフラインAPIからの迂回も止めます。

初回送信だけを実装しており、CheckTx拒否・応答喪失・期限切れを理由に、新しいsequence・fee・timeoutHeightで署名し直すことはありません。自動再送、手動再送、予約解除、置換取引は未実装です。保守的な停止により手動解決が必要な状態が残ります。現在のバックアップの復元で予約を保持する試験はありますが、古いバックアップ・別端末を含むrollback防止は未実装です。

## 受取観測と証明の区別

SYNC送信が返すのはCheckTxの受付であり、決済完了ではありません。保存したTxRawとハッシュ、収録index、block data_hashへのMerkle包含、実行code/gas、sender/recipient/amount+denomが一致する送金イベント、送信元sequenceを照合します。成功が後から取得できなくなった場合は成功観測を撤回します。

**Merkle検査はRPCが報告したdata_hashに対する包含検査です。ブロックヘッダーのhash再計算、validator投票・信頼根・ヘッダーチェーン、アプリ状態証明を検証していません。** ウォレットの報告では `finalityProven`、`headerHashVerified`、`stateProofVerified`、`balanceDeltaVerified` はfalseのままです。`reported-confirmed` はRPC観測の一致であって独立した決済証明ではありません。ブリッジの資金解放には使用しません。

## 実simdで確認した結果

公式Cosmos SDKのCI配布物を、ZIPと実行ファイルのSHA-256・サイズ・実行versionで固定しました。commit `c1126e4e5460571378bf9bd9c49cce476b0791e2`、SDK v0.55.0、実行版 `0.0.0-c1126e4e54` です。これは開発ビルドであり、本番用の安定バイナリ採用ではありません。詳細は `integration/cosmos/pin.json` に記録しています。

単一validatorの使い捨てチェーンにて、RealDEXの実署名をnodeが検査・受理し、bank処理と手数料・sequence変更を実行しました。HTTP入口は二組ですが背後は一つのsimdです。2台の独立検証者・公開ネットワーク・分散合意の障害検証ではありません。genesis初期資金はfixtureで準備し、validatorの鍵は送金用のRealDEXの鍵とは別です。P2P接続先なし、すべてloopback、pprofは無効、一時homeは終了時に削除します。

デモでは無価値の `stake` を用い、1,250,000最小単位を送金、固定総手数料500最小単位、送信元1,000,000,000→998,749,500、受取先1,000,000,000→1,001,250,000、sequence0→1を確認しました。同じ依頼の再要求は保存済み記録を返し、送信は1回でした。実行時gas使用量は80,104です。この残高比較は試験時の実ノードへの別読取りによるもので、ウォレットが独立状態証明を実装したことを意味しません。

13シナリオには、正常送金、署名だけ保存後の初回送信、重複依頼、受付直後の応答喪失、確認後のsequence消費、gas不足、CheckTx手数料不足、別denom手数料、包含経路の改変、取得不能となった結果の撤回、simulation中のロック、保存障害、再起動後の予約保持が含まれます。

## 固定ソースの検証結果

| 区分 | 件数 | 結果 |
|---|---:|---|
| wallet単体・合成HTTP | 618 | 成功 |
| node等の既存単体・合成HTTP | 1,171 | 成功 |
| app/起動/検証ツール | 78 | 成功 |
| 通常試験小計 | 1,867 | 成功 |
| 新Cosmos実simd | 13 | 成功 |
| Bitcoin Core regtest | 21 | 成功 |
| Anvilネイティブ送金 | 15 | 成功 |
| LiteSVM SOL / SPL | 14 / 16 | 成功 |
| acceptance実行対象合計 | 1,946 | 成功 |
| 既存固定nightly AMM補助 | 16 | 成功 |
| 実行対象総計（補助含む） | 1,962 | 失敗・取消・省略・TODO 0 |

正式Solidity 0.8.24のゲートはnightly補助試験では満たしません。別枠で形式・署名の独立照合144ケース、オフライン画面139項目（新Cosmos15項目を含む10スクリプト）、型検査も成功しました。内部Merkle木561入力は一つのNode試験内のケースであり、試験件数へ足していません。

検証対象ソースdigestは `e398e03a4b086908f8b87337f51a355266f1897f7d1301a4fd346cb39c363573` です。コード・テスト・静的asset・指定manifestを対象とし、過去のevidence・Markdownは対象外です。配布内容全体は別の `FILES.sha256` で照合します。配布前結果は `wallet/evidence/v017/`、最終ZIP再展開結果は外部のpackage-verification JSONとログZIPに記録します。再展開の未完了段階を、完了として記述しません。

## 開発中の失敗と修正

最初のHTTPfixtureのlockルート誤り、試験用probeとsimdのpprofポート競合、画面試験の表示小数桁の期待値不一致を修正しました。これは試験ハーネス側の問題で、旧v0.16の送金バグ発見と数えていません。モバイルでは長い承認JSONが横にはみ出したため、承認枠と結果欄の折返しを修正し390px幅で再試験しました。初回失敗ログと最終成功ログを保全しています。

## 未達の本番条件

全体検証のroot build/testは固定Node・ルート依存不足でblocked、正式Solidityコンパイラの検証もblockedです。Stellar Core/Aptos VMの実行試験は未実装としてblockedです。Chromiumでの実HTTP・CSP試験は環境ポリシーの `BROWSER_POLICY_BLOCK` でblockedでした。オフラインDOMの成功で代用していません。

選択範囲の合格はtrueですが、全体ローカル検証と本番準備完了はfalseです。公開テストネット、Windows、OSによる鍵保護、第三者独立監査、古いバックアップと複数端末の署名管理は未達です。ICP証明書/台帳送信、非EVMスワップ・ブリッジ、上位100位の全チェーン対応も今回追加していません。

既存の `contracts/`、`src/`、`node/`、ルートの依存指定・lockfileは変更していません。既存の本番制限やAIの権限も広げていません。具体的な変更は同梱のchange-manifestと外部patchを参照してください。

## 参照

- Cosmos SDK公式: https://docs.cosmos.network/sdk/v0.53/user/run-node/txs （SIGN_MODE_DIRECT、SYNCとCheckTxの説明、2026-09-06確認）
- 取得した公式CI: https://github.com/cosmos/cosmos-sdk/actions/runs/33866406573 （バイナリとハッシュはpin.json）
- 標準トランザクション構造: https://github.com/cosmos/cosmos-sdk/blob/c1126e4e5460571378bf9bd9c49cce476b0791e2/proto/cosmos/tx/v1beta1/tx.proto
