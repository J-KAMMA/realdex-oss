# RealDEX v0.12 — 所有者の経路交換と実AMM補助検証
日付: 2026-09-05 / 未監査・開発版・実資産禁止

## 基準と成果
入力はv0.11 ZIP `RealDEX-Native-EVM-Hardening-Preview-2026-09-05.zip`、SHA-256 `b666dd9d1ecafa00f34d1f11707a4da238a78a04794fa6593a1077b8e567384b`。同梱の962ファイル分の元ハッシュを照合しました。本版では、所有者画面から1〜4 hopの登録Pool経路を指定する交換と、実際のAMM契約をローカルEVMで試験する補助経路を追加しました。新しいチェーンやメインネット権限を増やしていません。

## 重要な修正
### 中間トークンの検査漏れ
旧Router呼出しの分類は、経路のプールと入力・最終出力トークンしか必須のコード照合対象にしていませんでした。登録Poolのtokenとして参照される中間トークンがERC20登録から抜けても、分類が成功することを実EVMテスト環境で再現しました。
本版は共通の `resolveLocalRoute` で全トークンを解決し、全中間トークンを署名前のコードハッシュ・桁数確認に含めます。未知Pool、未知token、循環、最大hop超過、不連続経路は拒否します。共有ノードだけでowner設定を書き換えられるという意味ではありません。

### 非ゼロ承認の上書き
旧コードでは現allowanceが非ゼロでも、別の非ゼロ値を承認できました。初回prepareと署名時の再検査にallowance読取りを加え、非ゼロなら `ALLOWANCE_RESET_REQUIRED` で止めます。明示的な取消は別操作です。取消・新規承認は原子的ではなく、過去の支出や全競合を解決する保証ではありません。
変更前の新AMMテスト7件は5件成功・2件失敗で上記を再現、修正後7件成功。その後、新しい経路と失敗系を追加した16件全てが成功しました。

## 経路スワップ
新API `POST /api/dex/quote-route` と既存prepareへの `action: route-swap` を実装しました。価格観測は同じblockHash、全区間のcode/decimals/token0/token1/fee/reserves/balanceOf/整数CPMM式/Router見積りを照合します。30秒の期限、ロック・入力変更時の破棄、署名直前再検査を維持します。
経路は所有者の明示指定です。既存の直接Poolの比較は維持しますが、ガス・承認費用を引いた最適化、分割実行、bridge、自動承認の機能ではありません。AIのMCPツール・予算・許可先・停止規則は変更していません。

## 実AMM検証に使ったコンパイラの限定
正式基準Solidity 0.8.24の取得は今回も未達です。一方、公式argotorg/solc-binのActions artifact 9921800111から固定nightly版を取得し、ZIP SHA-256、ファイルSHA-256、公式Git blob、実行versionを照合できました。
補助version: `0.8.37-nightly.2026.9.3+commit.f67cf4f2.Emscripten.clang`
補助compiler SHA-256: `598ddf764460231e865d096010be277649d979c6d9c4d51a7a4b4036420845df`
optimizer runs=500、EVM対象=shanghai、viaIRなし。入力の6個のSolidityファイルは元のままです。`integration/amm` の明示的なexperimentalプロファイルでのみ実行します。通常の`app/verify.mjs --full`は固定0.8.24のAMMゲートを要求し、nightlyの成功では合格になりません。

## 実EVMで確認した16シナリオ
Factoryの料率別Pool作成、CREATE2アドレス・immutable反映後の全Pool runtime一致、直接交換の残高、2hop交換・Router残高/承認の後片付け、LP追加・引出し、非ゼロ承認の拒否・取消後承認、中間token未登録拒否、新owner APIでの2hop交換、中間コード変更の署名前拒否、承認状態変化の拒否、価格変動後の古い最低受取量拒否、不可能なminOutのrevertと残高保存、重複Pool作成revert、未同期寄付の見積り拒否・明示sync後の照合、AIのERC20重複支払い防止と予算制限、入力税付きtokenの原子的拒否です。
Anvilは一つで、二つのHTTP口はその転送器です。独立ノードの合意・公開ネットワークは検証していません。デプロイ・初期資金・初期流動性にはテスト専用impersonationを使います。所有者・AIのウォレット操作は実署名・実残高で試験しています。テスト鍵・残高は使い捨てで実資産を使いません。

## 凍結ソースの実行結果
|範囲|成功件数|
|---|---:|
|ウォレット|292|
|既存ノード等|1171|
|起動・検証・toolchain|61|
|既存ネイティブ送金の実Anvil|15|
|通常の選択範囲小計|1539|
|nightlyによる実AMM補助試験|16|
|選択範囲と補助試験の合計|1555|
失敗・取消・省略・TODOはいずれも0。ソースdigest `71a4e056051103c4724796e5bfb7fb247d75d75ab3110a73363bb158a6972779` は通常と補助試験で一致し、各試験前後も不変です。96個のPython/OpenSSL等の形式・署名照合と、50項目のオフラインDOM試験は別枠で、1555へ足していません。既存SDK/providerのTypeScript厳格利用例も成功しています。
配布ZIPの再展開後の記録は別添Package-Verificationに出力します。本書に引用した数値の元データと一次ログは `wallet/evidence/v012` にあります。

## 失敗・未達
`npm run build`はReact/ethers等の依存不足で失敗。npmへの取得はEAI_AGAIN。Node22.16.0/Linux x64での検証で、root指定Node24.14.0・pnpm11.25.0の完全依存環境は未実行。実ブラウザはHTTPサーバーの応答までは確認しましたが管理ポリシーでアクセスを遮断され、全体判定はblockedです。オフラインDOMの成功をHTTP/CSP統合の成功として扱いません。
正式0.8.24での実コンパイル・AMM実行・既存デプロイバイトコード同一性、root全テスト、公開テストネット・実資産・Windows・OS鍵保護・独立監査は未達。非EVM送信、実bridge、秘密残高送金、分割経路実行、自動NAT接続も追加していません。
`selectedScopePassed=true`、`fullLocalAcceptancePassed=false`、`baselineCompilerGateSatisfied=false`（補助試験）、`productionReady=false`です。

## 原本保全と配布
contracts/、src/、node/（既存ノードコード）、root依存指定・lockfile・既存CI・正式compiler pin・Pool identity登録器は変更していません。walletの署名/DEX/UI、appの検証ゲート/版表示、実EVM fixture、試験・文書を変更・追加しています。全変更はChange-Manifestとパッチに記録します。
保存先・保管形式は維持。旧プロセスを終了して暗号化バックアップを保全してから更新してください。公式nightlyとAnvilは検証専用の別添ツールで、通常起動や本番コードの自動ダウンロード先ではありません。
