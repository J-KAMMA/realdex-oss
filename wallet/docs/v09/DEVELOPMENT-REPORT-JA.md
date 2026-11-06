# RealDEX v0.9 統合開発版 — 実装・検証報告

**日付:** 2026-09-05  
**基準:** RealDEX-Agent-Wallet-Preview-2026-09-05.zip（v0.8）  
**今回の版:** 0.9.0-dev.20260905

## 結論

選択したNode試験は **1,413件成功、失敗0、取消0、スキップ0**。基準版1,334件を再現したうえで、受取証再照合、AI送金前確認、Pool identity照合器、所有者DEX画面、ネットワーク設定の確認付き置換、一括起動を追加しました。追加のNodeテストケースは79件です。

**全チェーン本番版としての完成ではありません。** React/Hardhat全体の依存が未取得で、実Solidityコンパイル・実EVM実行・公開チェーン送信は未完了です。追加の画面操作はオフライン合成API試験です。本版は未監査であり、実資産を入れないでください。

## 1. 再現した旧版の不具合と修正

旧版では、成功表示になった取引を再照合すると `STATE_TRANSITION_FORBIDDEN` になり、後から受取証が消えても成功状態が残ることを再現しました。証拠は `wallet/evidence/v09/receipt-regression-before.json`。

新しいsettlement処理は、署名済みバイト列とRPCの取引本体・受取証を結び付けます。from/to、nonce、value、input、type、chainId、gas/fee、block hash/height/index、ログの帰属・重複・removed条件を検査します。実際にそのblock内のindexに対象hashがあるかも確認します。

以前の成功・失敗観測も更新可能にしました。受取証の消失、RPC不一致、照合エラーでは最新の成功・受取表示を取り消します。同じ取引が別ブロックに再収録された場合は、その位置と確認数を更新します。保存済み観測の日時を画面に出し、過去の表示を最新の最終性と混同させません。

手動再送では、非同期処理が完了するまで署名・送信の排他状態を保持するよう修正しました。送信前のRPC照合中にロック・再解除した場合は、古いepochの再送を停止します。送信開始後のロックは取り消しではありませんが、結果不明を維持し、遅れて返る成功応答を新しいepochの保管庫へ書き戻しません。

AIの消費予算とnonce予約は戻しません。照合は送信を行わず、結果不明を失敗と決め付けません。旧状態を読み終わる前に保管庫をロック・再解除しても、古いepochの結果を後から書き戻せないことを試験しました。

設定可能な確認条件は minConfirmations（1〜4096）と finalityTag（none/safe/finalized）。既定は12/noneです。これらはRPCが報告する条件を検査するもので、独立した最終性証明ではありません。`finalityVerified` と `actualBalanceChangeVerified` はfalseのままです。

## 2. ウォレット内のDEX操作

所有者のローカル画面に、Factoryからのプール作成、有限額のERC20承認、承認取消、直接Poolスワップ、流動性追加、流動性引出しの6フォームを追加しました。既存の限定的なデコーダーとEvmEngineの再検査を使います。通常のReactアプリをビルドできたことや、公開送信条件を解除したことを意味しません。

人が入力した小数数量は署名サービス内で最小単位へ変換し、最低受取量・LP量・受取先・期限を指定します。未知の任意calldataを通すフォームではありません。各操作は別の確認画面を経由し、既定で自動承認・自動送信しません。トークン承認も別操作です。

直接Pool見積りは最大16候補を、同一ブロックに束縛して比較します。コード、トークン桁数、プールの通貨対応、料率、準備高、整数見積り式を照合します。照合できない候補は除外し、部分的な比較であることを返します。最低受取量の整数丸めは切り上げを使い、設定bpsを1最小単位分だけ超過することを避けます。

**比較は追加費用前の受取額です。** ガス・承認・分割・複数ホップ・ブリッジを含むネット最適交換ではありません。見積りをフォームへ反映するだけでは、承認依頼も作りません。入力変更、ロック、期限切れで古い見積りを使用できないようにしました。

ERC20のdecimalsの照合を、直接送金に加え、承認・DEX等で使う全ERC20のpinにも適用しました。コードが変わらず桁数だけ変わった場合でも、署名直前の再検査で止めます。任意の税引・リベース・プロキシ・悪意あるトークン挙動を証明したものではありません。

作成したPoolは自動許可しません。新しいアドレスとコードを確認した後、所有者がネットワーク設定を置換できます。置換は新旧digest、genesis不変、90秒の確認期限、確認文、保管庫epochを検査します。適用時はウォレットをロックし、接続とAI権限を停止します。進行中の署名／送信がある間は置換しません。

## 3. AIの読み取り専用preflight

`realdex_agent_preview` と `AgentWalletClient.preview()` を追加しました。受取先、送金額、残高、実行ガス上限、残予算、権限の有効性を確認します。予算予約、署名、送信、承認作成、自動ロックの延長は行いません。署名時は改めて同じ検査を行います。

同じidempotencyKeyに既存の依頼がある場合は保存済み結果を返し、新しい支払いを作りません。キーを変えて同じ請求を二度払う事故まで意味的に判別する機能ではありません。

AIツールは6個になりましたが、AIへDEXやトークン承認、任意メッセージ署名、設定変更、保管庫解除の権限は追加していません。所有者の全停止・個別取消・ロック、既存の数量／費用／頻度／期限制限を維持します。

## 4. コンパイラ出力とPool identityの照合器

`wallet/contracts.mjs` と `wallet/lib/contract-identity.mjs` を追加しました。信頼できる環境で得たSolidity 0.8.24 build-infoを、ローカルソース、最適化設定、既存のFactory/Router runtimeハッシュと照合します。FactoryへのPool creation code埋込と、Poolの4個のimmutable参照範囲を検査します。

そのidentityからCREATE2アドレスとimmutableを埋めた期待runtimeを計算し、利用者指定RPCのFactory/getPool/Pool runtime/getterを同一ブロックで照合するコードがあります。

今回の14件は**合成compiler-shaped fixtureでのロジック試験**です。実コンパイルはできていないため、真正な生成済みidentityは同梱していません。`compilerReproducedHere:false`、`historicalCreationProven:false`、`tokenTransferBehaviorVerified:false`、`executable:false`を維持し、候補を自動送信許可へ昇格させません。

## 5. 一括起動と合否判定

`node app/cli.mjs start` で、ウォレットと読み取りノードを別プロセス・別保管先で起動します。既定は `~/.realdex-app/`。旧ウォレットの `~/.realdex-wallet/` から秘密鍵を勝手にコピーしません。

早いCtrl+C、二重起動、ポートの競合、途中失敗、正常終了を試験しました。途中失敗で停止するのは今回起動した子だけです。別サービスのプロセスを止めたり、残ったロックを勝手に削除したりしません。Windows用ラッパーはありますが実機未検証です。

`node app/verify.mjs --full --output NEW_DIR` は、選択試験と正規依存環境の全体試験を分けます。今回選択試験が通っても4つの全体ゲートはblockedであり、終了コード2・fullLocalAcceptancePassed=false・productionReady=falseを返します。制限を外して成功扱いにしていません。

## 6. 試験範囲と件数

| 区分 | 結果 | 実際に検証したもの |
|---|---:|---|
| ウォレットの選択Node試験 | 237成功 | 旧163 + 今回74。純粋関数、ファイル保存、HTTP合成RPC、MCP子プロセス等 |
| 既存ノード等の選択試験 | 1,171成功 | 従来の読み取り・最適化・配布条件等 |
| アプリ起動試験 | 5成功 | ローカルの実子プロセス、実HTTP、起動・停止 |
| **合計** | **1,413成功** | **失敗0・取消0・スキップ0** |
| 独立パーサー／署名照合 | 96ケース成功 | Python/OpenSSL等。Keccak全体の独立照合ではない |
| オフラインDOM | 41項目成功 | 旧ウォレット10＋AI13＋settlement7＋DEX11。合成API使用 |
| 追加・変更JS構文 | 30ファイル成功 | Node構文検査。型検証や実EVM検証とは別 |
| SDK利用例の型 | 成功 | 2利用例、TypeScript5.8.3のstrict |
| 実EVM追加シナリオ | **5件未実行** | 実行環境と依存不足のため合格に数えない |

96ケースや41項目は、1,413件へ足し直しません。全プロジェクトの全テスト合格を意味しません。

実EVM用の5シナリオは、ネイティブAI送金と実state revert、ERC20の実残高差、実コンパイラ出力と配置Poolの照合、所有者HTTP操作からの直接swap、有限router承認とswapです。二つのHTTP入口は一つのHardhat EVMへ転送し、合成の成功結果を返しません。しかし、この作成時には実行できていません。

## 7. 環境障害と未達

`npm view hardhat@2.29.1 version` を再試行し、registry.npmjs.org の名前解決がEAI_AGAINで失敗しました。`npm run build` も実行し、React/ethers/vitest等の依存がないため失敗しています。rootの固定Node24.14.0に対し実行環境は22.16.0です。依存指定やlockfileを勝手に変更していません。

実ローカルHTTPサービスを立ち上げてChromiumから通常接続を試みましたが、ERR_BLOCKED_BY_ADMINISTRATORで遮断されました。ポリシーは回避せず、オフラインDOM試験へ限定しました。通常のHTTP/CSP/CORS・ブラウザ暗号処理の結合に合格したとは扱いません。

未完了なのは、正規環境での全体build/test、実コンパイル、実EVM・公開テストネットでの取引、Windows、OS鍵保護、独立監査、非EVM送信と復旧、実クロスチェーン決済、分割ルーター、privacy wallet、NAT越え、ネイティブ配布等です。全ソフト完成と表現できる状態ではありません。

## 8. 原本保全・再現

基準ZIP、比較したファイル一覧、変更・追加のSHA-256は `wallet/evidence/v09/source-change-manifest.json` に記録します。元の `contracts/`・`src/`・`scripts/`・ルート依存指定とlockfileは今回変更していません。READMEには最新版の説明を追記し、古い報告は過去記録として保持します。

`FILES.sha256` は自己自身を除く配布全ファイルを記載します。完成ZIPは別ディレクトリへ再展開し、全manifestを確認し、選択1,413試験を再実行した後、もう一度manifest一致を確認します。最終結果は配布する `RealDEX-Integrated-Package-Verification-2026-09-05.json` が正本です。

## 一次仕様の参照

以下は設計根拠であり、このコードの正しさの認証ではありません。2026-09-05確認。

1. EIP-1898 — blockHashとrequireCanonicalによる状態の参照: https://eips.ethereum.org/EIPS/eip-1898
2. EIP-1014 — CREATE2と初期化コードのアドレス式: https://eips.ethereum.org/EIPS/eip-1014
3. Solidity 0.8.24 compiler JSON / deployedBytecode.immutableReferences: https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html
