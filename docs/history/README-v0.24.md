# RealDEX v0.24 — 独立鍵・永続キュー付きの限定IBC中継（2026-09-06）

> Historical note (2026-11-06): the WalletConnect / Reown transport described in this v0.24 record was removed before the AGPL-3.0-only release because the Reown Community License is incompatible with AGPL-3.0.

自設ローカル開発チェーン用の中継ワーカーを追加しました。所有者の資産鍵ではなく、新規生成した専用費用鍵を使い、許可した経路・送信取引・費用枠・期限内でreceive/ACK/timeoutを処理します。**未監査・実資産禁止。本番承認ではありません。**

通常アプリ: `node app/cli.mjs start`。中継は自動起動しません。[中継CLIの全文手順](relay/README.md) / [更新手順](docs/v0.24/QUICKSTART-JA.md) / [安全性](docs/v0.24/SECURITY-JA.md) / [開発報告](docs/v0.24/DEVELOPMENT-REPORT-JA.md)。ロードマップのBR-RELAYは引き続きin_progressです。

試験: `node app/verify.mjs --ibc --output acceptance-new`。診断用IBCバイナリは別途必要です。今回の最終結果は同時配布の`RealDEX-v0.24-Package-Verification-2026-09-06.json`を参照してください。以下とevidence/の旧版説明・件数は履歴であり、今回の実行結果に合算しません。

---

# RealDEX v0.23 — 完成ロードマップとIBC自動追跡（2026-09-06）

完成・本番公開までの23項目の依存関係付きロードマップを作り、最初の項目としてIBCの中継取引の自動発見と停止可能な読取り追跡を追加しました。
**未監査・自設ローカル開発専用・実資産禁止。本番公開の承認ではありません。**

- [完成ロードマップ](plans/DEVELOPMENT-ROADMAP-JA-2026-09-06.md) / [機械可読タスク](plans/DEVELOPMENT-ROADMAP-2026-09-06.json)
- [起動・更新](docs/v0.23/QUICKSTART-JA.md) / [API](docs/v0.23/API-JA.md) / [安全性](docs/v0.23/SECURITY-JA.md) / [報告](docs/v0.23/DEVELOPMENT-REPORT-JA.md)

起動：`node app/cli.mjs start`。計画と依存関係の確認：`node app/roadmap.mjs`。
自動追跡は所有者が選んだ履歴だけ、解除中のみ。送信・署名・返金実行は行いません。ロック/停止で失効し、自動再開しません。

検証：`node app/verify.mjs --ibc --output acceptance-new`（固定IBC診断ツールは別途必要）。
このZIPの最終再展開検証は同時配布の `RealDEX-v0.23-Package-Verification-2026-09-06.json` を参照してください。
下記と `evidence/` の古い版の件数は、現行版で実行した件数に足し直しません。

---

# RealDEX v0.22 — IBCブリッジ開発版（2026-09-06）

所有者用ウォレットに IBC Classic / ICS-20 v1 の1ホップ資産移転を追加しました。
自設ローカル2チェーンのネイティブ→IBC表現、元チェーンへの返送、ACK・タイムアウト返金の追跡に対応します。
**未監査・ローカル開発専用・実資産禁止。** EVM/BTC間、全チェーン、公開チェーン、常駐中継サービスへの対応ではありません。

起動: `node app/cli.mjs start`。通常起動に追加のnpm依存はありません。
[手順](docs/v0.22/QUICKSTART-JA.md) / [API](docs/v0.22/API-JA.md) / [安全性](docs/v0.22/SECURITY-JA.md) / [報告](docs/v0.22/DEVELOPMENT-REPORT-JA.md)。
基準はv0.20です。未検証のBitcoin共同承認v0.21 WIPは保全したまま、混合していません。
過去の試験件数を最新版の成功として合算しません。以下は履歴です。

---

# RealDEX v0.20 — Cosmos native delegation (2026-09-06)

非EVMのチェーン側権限制御として、Cosmosの制限付き許可作成・代理送金・取消しを追加しました。所有者UI、署名前照合、暗号化保存、実SDK試験まで接続しています。別のコントラクト口座を作る方式ではありません。未監査・自設ローカルチェーン専用・実資産禁止。

起動: `node app/cli.mjs start`。 [v0.20手順](docs/v0.20/QUICKSTART-JA.md) / [API](docs/v0.20/API-JA.md) / [安全性](docs/v0.20/SECURITY-JA.md) / [報告](docs/v0.20/DEVELOPMENT-REPORT-JA.md)。以下は旧版の記録です。対応可否は新しい資料と実際のコードを優先し、過去の件数を合算しません。

---

# RealDEX v0.19 — Smart Account Preview (2026-09-06)

所有者固定のコントラクト口座・まとめ払い・承認→交換→取消し・ERC-1271・オンチェーン予算付き補助鍵を追加しました。未監査、固定nightlyのローカル試験版です。実資産を入れないでください。ERC-4337／7702／paymaster／鍵紛失回復は未実装です。

起動: `node app/cli.mjs start`。操作手順: [v0.19 日本語手順](docs/v0.19/QUICKSTART-JA.md)。[安全性と制限](docs/v0.19/SECURITY-JA.md) / [API](docs/v0.19/API-JA.md)。旧版資料は以下に履歴として残しています。このv0.19節は履歴です。現行の仕様・試験結果は冒頭の最新版資料を参照してください。

---

# RealDEX v0.18 — Aptos実ノード統合・受取応答の厳格化

基準は2026-09-06のv0.17 Cosmos Settlementです。分岐していたAptos実ノード試験を現在の所有者APIへ統合し、シミュレーション形式・RPCアドレス・Stellar結果XDR・共通JSONとquery検査を修正しました。

**未監査・ローカル開発専用・実資産禁止。本番承認、独立した決済証明、全チェーン対応ではありません。** AIと共有ノードの署名権限は増やしていません。

起動: `node app/cli.mjs start`。 [v0.18手順](wallet/docs/v018/QUICKSTART-JA.md) / [実装報告](wallet/docs/v018/DEVELOPMENT-REPORT-JA.md) / [API差分](wallet/docs/v018/API.md) / [安全性](wallet/docs/v018/SECURITY-JA.md) / [実行証拠](wallet/evidence/v018/)。

以下は保全した過去版の説明です。現在の可否・試験件数にはv0.18のコードと再展開後の検証記録を優先し、過去の件数や分岐版の機能を合算しないでください。

---

# RealDEX v0.17 — Cosmos SDK local settlement

最新追加: 所有者用Cosmos MsgSendの状態取得・署名・保存・初回送信・再照合。公開チェーンではなくローカル開発用です。本番承認・独立監査は未達です。

手順: [wallet/docs/v017/QUICKSTART-JA.md](wallet/docs/v017/QUICKSTART-JA.md) ／ [安全性](wallet/docs/v017/SECURITY.md) ／ [API](wallet/docs/v017/API.md)。試験結果: wallet/evidence/v017/。以下の旧版説明・evidenceは履歴として保全しています。

---

# RealDEX v0.16 — Stellar / Aptos ローカル送金と再照合

> **未監査・実資産禁止。** 所有者のXLM/APTローカル送金を、状態取得・確認・署名・暗号化保存・初回送信・再照合まで接続しました。
> 新経路の試験は実署名を検証する合成HTTPサーバーです。実Stellar Core/Aptos VMや公開チェーンでの検証ではありません。AI・共有ノードへ署名権限を追加していません。
> 起動: `node app/cli.mjs start`。 [v0.16手順](wallet/docs/v016/QUICKSTART-JA.md) / [報告](wallet/docs/v016/DEVELOPMENT-REPORT-JA.md) / [API](wallet/docs/v016/API.md) / [安全性](wallet/docs/v016/SECURITY-JA.md)。
> 以下は履歴です。現在の版はv0.16ソース・文書・再展開検証を優先し、過去版の件数や対応済み記述を合算しません。

---

# RealDEX v0.15 — Bitcoin Core regtest送金・収録再照合

> **未監査の開発版。実資産・本番秘密鍵は使用禁止。**
> Bitcoinの自己管理署名を、UTXO取得・確認・署名・暗号化保存・初回送信・収録再照合まで接続しました。Bitcoin Core regtest専用で、公開チェーン、再送、RBF、ブリッジは未対応です。AI・共有ノードへ署名権限を追加していません。
> 通常起動: `node app/cli.mjs start`。 [v0.15手順](wallet/docs/v015/QUICKSTART-JA.md) / [報告](wallet/docs/v015/DEVELOPMENT-REPORT-JA.md) / [API](wallet/docs/v015/API.md) / [安全性](wallet/docs/v015/SECURITY-JA.md)。
> 現在の仕様はv0.15文書とソースを優先してください。以下は保全した過去の記録で、試験数・対応範囲を合算しません。

---
# RealDEX v0.14 — 拡張非EVMウォレット

> **未監査の開発版。実資産・本番秘密鍵を使用しないでください。**
> SPL classicの所有者送金を追加。Bitcoin/Cosmos/Stellar/Aptosは用途限定のオフライン署名・保存・出力です。これらのチェーンへのネットワーク送信・本番対応を意味しません。AIと共有ノードへの署名権限は増やしていません。
> 起動: `node app/cli.mjs start`。 [v0.14手順](wallet/docs/v014/QUICKSTART-JA.md) / [報告](wallet/docs/v014/DEVELOPMENT-REPORT-JA.md) / [API](wallet/docs/v014/API.md) / [安全性](wallet/docs/v014/SECURITY-JA.md)。
> 新形式の口座・署名履歴を保存した後の旧バイナリへのロールバックはできません。旧バックアップ復元による二重署名にも注意してください。

---
## 過去の版の記録（現在の完成状態とは別）

# RealDEX（リアルデックス）

> **2026-09-05 / v0.13 — 非EVMウォレット: ローカルSOL送金・ICPオフライン要求の保全。未監査・実資産禁止。**
> 所有者だけがSOLを照合・承認・署名・保存・初回送信・再照合できます。ICPはcanister/principal/subaccount/memo/時刻を束縛した署名済み要求を保全し、送信はしません。AIやdappへの非EVM署名権限は追加していません。
> 試験用LiteSVMで実際にSystem Program送金と署名検証を実行しますが、RPC/slot/finality/genesisのラッパーは合成であり、validatorや公開ネットワークの試験ではありません。正式EVMコンパイラのゲートを置換しません。
> **非EVM記録を追加した保管庫は旧バイナリで開けません。** 更新前の暗号化バックアップを別保存し、新しい署名後の古いバックアップ復元で履歴を巻き戻さないでください。
> 起動: `node app/cli.mjs start`。 [今回の手順](wallet/docs/v013/QUICKSTART-JA.md) / [報告](wallet/docs/v013/DEVELOPMENT-REPORT-JA.md) / [API](wallet/docs/v013/API.md) / [安全性](wallet/docs/v013/SECURITY-JA.md)。以下は過去版の記録です。


> **2026-09-05 / v0.12 — 複数ホップの所有者操作・実AMM補助検証。未監査・実資産禁止。**
> 中間トークンの署名検査漏れを修正し、非ゼロ承認の非ゼロ上書きを拒否します。所有者画面に登録済み1〜4プールの経路見積り・交換依頼を追加しました。AIの権限は送金のままで、swap／approveを追加していません。
> 公式固定nightlyコンパイラによる実AMM検証は **補助試験** です。正式基準0.8.24のコンパイラ・バイトコード同一性・全React・公開チェーン・独立監査の代わりにはなりません。通常の検証ランナーはnightlyへ切り替えません。
> 起動: `node app/cli.mjs start`。 [起動・更新・実AMM再現](wallet/docs/v012/QUICKSTART-JA.md) / [報告](wallet/docs/v012/DEVELOPMENT-REPORT-JA.md) / [安全性](wallet/docs/v012/SECURITY-JA.md) / [API](wallet/docs/v012/API.md) / [新試験記録](wallet/evidence/v012/test-results.json)。
> **以下は履歴です。** v0.11のネイティブ送金試験、v0.12のnightlyによる実AMM補助試験、未達の正式0.8.24試験を区別してください。


> **2026-09-05 / v0.11 — 実EVM送金検証・保管庫の保存障害対策。未監査・実資産禁止。**
> v0.10の保存済みZIPを再検証して継続しました。パスワード変更の保存失敗後も解除状態が残る問題と、不完全なTAPログの合格判定を修正しています。新しい独立Anvil試験で、実際のEVM残高・nonce・AI制限・応答喪失・状態巻き戻しを検査します。
> アプリ起動: `node app/cli.mjs start`。Anvil試験: `node integration/anvil/run.mjs --output NEW_DIR`（固定試験ツールの指定が必要）。コンパイラ・全React・実ブラウザ・公開チェーン・独立監査のゲートは未達で、本番承認ではありません。
> [起動と実EVM試験](wallet/docs/v011/QUICKSTART-JA.md) / [今回の報告と前回案内の訂正](wallet/docs/v011/DEVELOPMENT-REPORT-JA.md) / [安全性](wallet/docs/v011/SECURITY-JA.md) / [検証記録](wallet/evidence/v011/test-results.json)。
> **以下のv0.10以前は履歴です。** 過去の「実EVM未実行」と、v0.11の「ネイティブ送金のみ実EVMで検証」を区別してください。


> **2026-09-05 / v0.10 本番前ハードニング版。未監査・実資産禁止。**
> 待機中の解除がロック後に成功する競合と、保存できても解除時に読めない容量不整合を修正しました。保存障害・writer.lock所有権・子プロセスへの環境変数引継ぎも強化しています。
> `node app/cli.mjs start`。全体検証は `node app/verify.mjs --full --output NEW_DIR`。本版のソース・選択試験の結果と、全体の未達を分けて記録します。全体ビルド・実EVM・実ブラウザ・実チェーン・独立監査は未達で、本番承認をしていません。
> [起動・更新](wallet/docs/v010/QUICKSTART-JA.md) / [開発報告](wallet/docs/v010/DEVELOPMENT-REPORT-JA.md) / [安全性と完成条件](wallet/docs/v010/SECURITY-JA.md) / [検証記録](wallet/evidence/v010/test-results.json)。
> 以下は旧版の履歴です。旧版の達成件数や「変更していない」の範囲を、v0.10の結果と混同しないでください。


> **2026-09-05 / v0.9 統合開発版。全チェーン本番完成版ではありません。実資産禁止。**
> `node app/cli.mjs start` でローカルウォレットと読み取りノードを別プロセスで起動します。ウォレット内DEX操作、確認付き契約設定置換、受取証の再照合・再編対応、AI preview、Pool identity照合器、全体の合否ランナーを追加しました。
> 選択Node試験 **1,413件成功**。96独立照合ケース、41オフラインDOM項目も成功しましたが、実EVM5シナリオは未実行です。正規依存環境の全体ビルド・試験、実チェーン・実資産・独立監査は未完了です。
> [起動・DEX・復旧](wallet/docs/v09/QUICKSTART-JA.md) / [開発報告](wallet/docs/v09/DEVELOPMENT-REPORT-JA.md) / [セキュリティ境界](wallet/docs/v09/SECURITY-JA.md) / [API](wallet/docs/v09/API.md) / [検証記録](wallet/evidence/v09/test-results.json)。
> `node app/verify.mjs --full --output NEW_DIR` は、依存が欠けた試験をblockedとして終了コード2を返します。下記は旧版の保存記録です。過去の件数・対応範囲を最新版の達成内容と混同しないでください。

> **2026-09-05 / v0.8: 送金・AI用の制限付きウォレットを追加。実資産禁止。**
> `node wallet/cli.mjs start`。正確な数量入力、選択資産の残高、受取URI、AI別の予算・受取先・期限、毎回承認／明示的な限定自動モード、MCPとSDKを追加しました。
> AIには秘密鍵・所有者権限を渡しません。制限はローカル署名サービスで検査するもので、オンチェーン権限やOS侵害への保護ではありません。ロック後は所有者による再有効化が必要です。
> [起動とAI接続](wallet/docs/v08/QUICKSTART-JA.md) / [開発報告](wallet/docs/v08/DEVELOPMENT-REPORT-JA.md) / [セキュリティ境界](wallet/docs/v08/SECURITY-JA.md) / [API](wallet/docs/v08/API.md) / [検証記録](wallet/evidence/v08/test-results.json)。
> 選択Node試験は既存1224＋追加110＝1334件。合成RPCとの実HTTP、MCP別プロセス、オフラインDOMを検証しました。実チェーン、実EVM、実資産、React全体build/test、ブラウザHTTP結合、商用AIクライアントは未検証です。
> v0.7から既存コントラクト・src・ルート依存指定を変更していません。以下は過去版の保存記録であり、旧件数や旧変更範囲をv0.8と混同しないでください。

> **2026-09-05 / v0.7: 自己管理ウォレットの開発版を追加。実資産を入れないでください。**
> `node wallet/cli.mjs start` で共有ノードと別プロセスのPC Walletを起動。EVM/ICP/Solanaの鍵生成・取込・暗号化バックアップ・復元・ロックを追加しました。
> UIからの送信は明示設定した一部EVMテスト/ローカルネットワークのみ。ICP/Solanaはオフライン署名コードまでで、画面からの送信はありません。BIP39/HD、全チェーン送信、秘密残高スキャン、Tauri/native installerは未実装です。
> [起動・復元・接続手順](wallet/docs/QUICKSTART-JA.md) / [実装・検証報告](wallet/docs/DEVELOPMENT-REPORT-JA.md) / [セキュリティ境界](wallet/docs/SECURITY-JA.md) / [試験記録](wallet/evidence/test-results.json)。
> **PC Wallet接続ボタンは実験用 `src/App.tsx` / `/experimental.html` に追加。標準v0.1のMetaMask/Base Sepoliaゲートは解除していません。** 内蔵署名サービスはBase Sepolia等の未対応追加費用モデルを拒否します。
> 選択Node試験は追加53＋既存1171＝1224件。実HTTPは合成RPCとの通信であり、実EVM実行・実チェーン送信・資金安全性の証明ではありません。React全体のビルド/ブラウザHTTP結合、Windows実機は未検証です。
> 以下のv0.6以前の記録は保存資料です。旧試験件数・「既存src不変」等の記述をv0.7の変更内容と混同しないでください。

> **2026-09-05 / v0.6: ICP・プライバシー系・私設ネットワークの追加層。**
> 新画面 `/node/privacy/`、CLI `node/privacy.mjs`。ICRC台帳query、台帳別Rosetta、Monero等の読み取り、私設設定のローカル読込、費用・秘匿条件のオフラインモデルを追加。
> 拡張28候補（うち既存2件）で重複除外164ネットワーク候補。ICP台帳9候補はチェーン数に含めません。
> 選択スイートは1,171件成功（既存804＋追加367）。合成RPC・オフラインモデルの試験で、実チェーン・実資産の成功件数ではありません。
> [起動手順](docs/v06/QUICKSTART-JA.md) / [実装・制約](docs/v06/DEVELOPMENT-REPORT-JA.md) / [試験記録](node/evidence/v06/test-results.json)。
> **追加層は読み取り専用。ICP Pool/Factory、shielded wallet、スワップ・ブリッジ送信、実チェーン適合試験は未完成です。匿名性や資金安全性を保証しません。**
> 以下のv0.5以前の記録は保存資料です。旧版の試験件数・実装範囲をv0.6の全実装検証と混同しないでください。

> **2026-09-05 / v0.5: 138候補・15系統のマルチチェーン読み取り層を追加。**
> 新画面 `/node/chains/`、CLI `node/chains.mjs`、任意EVM設定・カタログ取り込み・EVM89候補の契約配置計画を利用できます。
> [起動手順](docs/REALDEX_MULTICHAIN_QUICKSTART_JA_2026-09-05.md) / [実装・試験・制約](docs/REALDEX_MULTICHAIN_REPORT_2026-09-05.md) / [全候補一覧](docs/REALDEX_MULTICHAIN_MATRIX_2026-09-05.md)。
> **候補登録 ≠ 交換・ブリッジ実行対応。実チェーン確認・新規デプロイ・非EVM Pool・新しい取引送信は未完了です。**
> 選択試験 `node node/test/run-tests.mjs --with-release` は804件。15系統の模擬RPCとの実HTTP試験を含みます。実市場・実資産の試験ではありません。
> 既存 `src/` / `contracts/` / `scripts/` / ルート依存指定・lockfile・送信ゲートは変更していません。以下はv0.4以前の原文記録であり、今回その全アプリ実装・全テストを再検証したものではありません。


> **2026-09-05 / v0.4: 署名付き候補→同一ブロック照合→読み取り専用交換ラボを追加しました。**
> 起動後の `/node/exchange/` と `node/verify.mjs` を使えます。[日本語手順](docs/REALDEX_VERIFIED_QUICKSTART_JA_2026-09-05.md) / [実装・検証・未達](docs/REALDEX_VERIFIED_DISCOVERY_2026-09-05.md)。
> `node node/test/run-tests.mjs --with-release` で追加依存なしの353件を再現できます。署名付き発見・同一block RPC照合・費用境界・分割研究案までの追加です。Pool生成由来とruntime全体の同定は未完了で、観測を実行許可へ変えません。
> 既存の送信画面・コントラクト・release gateは変更していません。全チェーン実取引、分割送信、NAT自動接続は未完成です。以下は保持した限定実行版の記録です。

> Development scope (2026-09-02): the user approved a finite v0.1 testnet beta and its development goal: Base Sepolia, desktop MetaMask EOA, AMBR/JADE and one direct pool in both directions. See [v0.1 scope and acceptance criteria](docs/V01_SCOPE.md). Individual wallet, transaction, deployment and publication actions still require separate authorization. Existing universal/non-EVM work is retained, but does not define first-release completion.

The default entry now renders the fixed **v0.1** flow: verify the reviewed deployment → explicitly select/connect a wallet → review approval/swap → manually inspect persisted history. No approved deployment profile is bundled, so connection and execution remain disabled. This is implemented software under local validation, **not an accepted public-testnet release**. See [current evidence and gaps](docs/V01_PROGRESS.md).

The [Japanese participant and recovery guide](docs/V01_PARTICIPANT_GUIDE.md) and [review/acceptance record](docs/V01_ACCEPTANCE_RECORD.md) describe prerequisites, individual authorization, operation states and unresolved recovery limits. They are preparation documents, not permission to connect a wallet or begin a public test.

The broader architecture and experimental features below describe preserved source. The old generic app is available only at `/experimental.html` on a localhost development server; it is not a navigation option or alternate configuration mode in the default production build.

RealDEX is a self-hosted, capability-gated universal DEX project. Its first execution core is an immutable EVM constant-product pool plus a static React client that talks directly to the user's wallet and RPC endpoint.

The product display name is **RealDEX（リアルデックス）**. Versioned v1 contract artifact names (`LocalSwapFactory`, `LocalSwapPool`, `LocalSwapRouter`), existing browser-storage keys, and the v1 signed-manifest domain remain unchanged so a branding change cannot silently alter bytecode identities, invalidate recovery records, or break existing signatures.

The AMM deliberately has no operator backend, account system, custody, relayer, analytics, admin key, upgrade proxy, fee recipient, or protocol fee. The optional bridge has a separate, explicitly disclosed external trust model.

> Experimental and unaudited. Do not use this version with real assets. An MIT license and a decentralized architecture do not determine regulatory status.

## Architecture

```text
User browser
  ├─ injected wallet (signing)
  └─ user-selected JSON-RPC (reads)
        ↓
LocalSwapFactory (permissionless registry, no owner)
  ├─ LocalSwapPool (immutable token pair, 0% protocol fee)
  └─ LocalSwapRouter (stateless atomic path, 2–4 verified pools)
```

- `contracts/LocalSwapFactory.sol` creates one deterministic pool per sorted token pair and immutable fee tier.
- `contracts/LocalSwapPool.sol` swaps exact ERC-20 input, issues LP shares, and supports proportional withdrawal.
- `contracts/LocalSwapRouter.sol` executes a simple 2–4 pool path as one transaction, with no owner, custody, fee, or upgrade control.
- `src/` is a static local client. Configuration is stored only in browser local storage.
- `scripts/seedDemo.ts` deploys two mock tokens, a factory, and a seeded pool on a local Hardhat chain.
- `src/bridge/` contains the fail-closed route, quote, lifecycle, and recovery model plus CCTP V2 and IBC ICS-20 testnet adapters.
- `src/universe/` contains the CAIP-based chain, wallet-capability, asset-provenance, and execution-readiness registry.
- `src/universe/token-source.ts` verifies session-pinned EIP-191 token publishers, canonical signed manifests, expiry/revision heads, CAIP collisions, and current EVM ERC-20 metadata without enabling execution.
- `src/routing/` contains the common direct-route registry, quote binding, execution-target validation, duplicate execution guard, and route-bound bridge finality journal shared by swaps and bridges. Financial identities use domain-separated canonical Keccak-256 fingerprints; legacy 32-bit FNV route values are accepted only to read an exact historical finality record and never to authorize a new quote or execution. A cryptographically random execution-intent ID remains stable across re-quotes for the same human action and changes when its transaction inputs, route, direction, or wallet authority changes. An origin-wide Web Lock serializes account connection, durable guard admission, and adapter execution across tabs. The intent record has no time-based expiry, must survive an exact write/readback, and is removed only by a failed receipt that proves no value-transfer submission, an exact reverted EVM transfer, or a non-zero Cosmos source transaction result. Ambiguous provider errors keep the lock, and browsers without Web Locks stop before wallet connection.
- `src/release/` contains the fail-closed public-testnet deployment evidence schema and two-reader runtime/receipt verifier. It performs no deployment or signing.
- `src/swap/` contains the formal EVM local-AMM adapter. It reads the live quote and allowance, exposes exact authorization and unpriced gas, and executes the same account/session/target-bound quote shown by the UI.
- `src/swap/evm-venue-discovery.ts` discovers up to 32 exact RealDEX v1 factories (`LocalSwapFactory` contracts), pins their compiled runtime hash, verifies each pool origin and token pair, and turns only verified pools into comparable direct routes.
- `src/swap/evm-multihop.ts` verifies the exact bundled router runtime, builds a graph only from those verified pools, rejects cyclic paths, and compares atomic multi-hop quotes with direct quotes.
- `src/swap/solana-swap-boundary.ts` validates an unsigned Solana v0 transaction against one reviewed program identity and venue decoder, then requires two independent RPC simulations to agree. It is verification-only: no public venue or wallet execution transport is installed.
- `src/swap/solana-venue-source.ts` adds native Ed25519 publisher provenance for Solana venues. A strict signed manifest binds the exact source fingerprint, CAIP-2 scope, revision/expiry, program and complete ProgramData identity, token program, pool target, and evidence. Rollback, same-revision equivocation, source/chain substitution, unknown fields, duplicate venues, and signature changes fail closed. A source-bound swap freshly repeats signature verification before entering the existing two-RPC simulation boundary; both results remain design gates and no production publisher or venue is bundled. Sources: Solana [Programs](https://solana.com/docs/core/programs) and [Deploying Programs](https://solana.com/docs/programs/deploying) (reviewed 2026-09-01).
- `src/swap/spl-token-swap-exact-in-decoder.ts` strictly decodes the classic SPL Token Swap exact-input instruction and binds every pool, mint, vault, fee, token-program, user-account, and optional host-fee role. No public pool or deployed program identity is bundled.
- `src/swap/spl-token-swap-quote-boundary.ts` reads the exact signed swap-state and two classic 165-byte token-vault accounts from two distinct public RPC hosts. Both snapshots must agree on reserves, all fee fractions, constant-product curve, pool topology, token-program ownership, PDA authority, and independently calculated output. The signed intent's quoted output and exact slippage-derived minimum must match that calculation. Other curves, Token-2022 extensions, delegated/closing vaults, stale/divergent snapshots, and state substitutions fail closed.
- `src/swap/solana-read-policy.ts` removes arbitrary RPC text fields from the source-bound SPL path. A separately session-pinned Ed25519 reviewer signs the exact Solana chain, two normalized public HTTPS RPC endpoints on different hosts, quote/simulation boundary versions, expiry, monotonic revision, and evidence. The policy is freshly reverified before it alone constructs both reader quorums; changing its source, signature, endpoint pair, chain, boundary version, or stored head fails closed.
- `src/swap/solana-spl-route-source.ts` closes the protocol-route provenance gap by signing the complete SPL Token Swap account topology rather than accepting a decoder route from the caller. The source-bound entrypoint freshly verifies the route signature and monotonic head, derives the venue and decoder only from the selected signed route, revalidates the separately signed read policy, requires its two-reader pool-state quote, and finally requires matching simulations from the same policy-bound hosts. Universe exposes this non-committing path for strict unsigned intents; every RPC call is POST-only and no `sendTransaction`, signing, or submission control exists. No production publisher, route, read policy, or trusted RPC operator pair is bundled.
- `src/swap/solana-swap-recovery.ts` creates a persistent recovery record only from an Ed25519-verified signed transaction whose message exactly matches the previously simulated intent, then refreshes its monotonic status through two independent history-aware RPC readers. It cannot submit or retry a transaction.
- `src/swap/cosmos-swap-boundary.ts` strictly validates a canonical unsigned Cosmos `TxRaw` intent with no unknown JSON fields, pins its DIRECT sign document, account sequence, exact fee and timeout height to one venue-decoded swap, then requires two independent public HTTPS REST simulations to agree. Its bounded reader uses chain/head/account GETs and only `POST /cosmos/tx/v1beta1/simulate`; it has no broadcast method.
- `src/swap/osmosis-exact-in-decoder.ts` strictly decodes Osmosis `MsgSwapExactAmountIn`, binding the sender, one to four exact pool IDs, every hop denom, input coin, and final minimum output to a reviewed route descriptor. No public pool descriptor is bundled.
- `src/swap/cosmos-venue-source.ts` authenticates exact Osmosis route descriptors with a domain-separated, canonical, low-S secp256k1 publisher signature. The strict manifest binds its source fingerprint, Cosmos CAIP-2 scope, revision/expiry, ordered pool IDs, hop denoms, final denom, and evidence; rollback, equivocation, unknown fields, and source/chain substitution fail closed. Its source-bound entrypoint freshly verifies the manifest before the canonical `TxRaw` decoder and two-REST simulation boundary. This custom publisher signature is provenance only—not a Cosmos wallet/transaction signature or broadcast permission. Sources: Cosmos SDK [signature verification](https://github.com/cosmos/cosmos-sdk/blob/main/x/auth/ante/sigverify.go), [`TxRaw` / `SignDoc`](https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/tx/v1beta1/tx.proto), and [transaction service](https://github.com/cosmos/cosmos-sdk/blob/main/proto/cosmos/tx/v1beta1/service.proto), plus [Osmosis PoolManager](https://github.com/osmosis-labs/osmosis/blob/main/x/poolmanager/README.md) (reviewed 2026-09-01).
- `src/swap/cosmos-read-policy.ts` removes arbitrary REST fields and caller-created readers from that source-bound Osmosis path. A separately pinned low-S secp256k1 reviewer signs the exact chain, two normalized public HTTPS REST endpoints on different hosts, simulation-boundary version, expiry, monotonic revision, and evidence. The reviewer key must differ from the route publisher. The policy is freshly reverified before it alone constructs the reader quorum; source, signature, endpoint pair, chain, boundary version, stored head, or accepted-object mutation fails closed. Universe exposes only read-only policy endpoints and invalidates prior evidence when the policy source changes. No production publisher, route, read policy, or reviewed operator pair is bundled.
- `src/swap/cosmos-swap-recovery.ts` accepts only an exact low-S secp256k1-signed `TxRaw` whose body, authorization bytes, bech32 authority, sign document, intent, and prior two-reader simulation evidence all match, then tracks committed or unresolved status through two independent REST readers. It cannot broadcast or rebroadcast.
- `src/swap/external-evm-v2-recovery.ts` persists only a venue- and quote-bound exact approval or swap envelope after a future transport returns its transaction hash, then refreshes receipt and nonce evidence through exactly two independent RPC readers. It stores no signed transaction and can never authorize resending.
- `src/swap/external-evm-v2-source.ts` accepts JSON-safe External V2 identities only from an exact session-pinned source fingerprint and EIP-191 signer, and enforces expiry and monotonic revisions before any live check. `src/swap/external-evm-v2-read-policy.ts` separately pins an independent EIP-191 reviewer and signs the exact EIP-155 chain, normalized public HTTPS RPC pair, venue-identity and quote-boundary versions, expiry, revision, and evidence. The source-bound entrypoints freshly re-verify both artifacts, reject a reviewer address shared with the venue publisher, derive the exact venue from the manifest, and construct the Router/Factory/Pair readers only from the signed policy. A strict maximum-five-minute intent binds the venue, chain, canonical base-unit input, recipient, slippage, and deadline. A policy-bound quote requires both readers to independently validate each reserve against Router `getAmountsOut` and then agree exactly on the full amount path, minimum output, deadline, quote ID, and calldata. Manifest, policy, intent, and final deadline are checked again after the RPC quorum completes, so an in-flight expiry cannot produce a preview. A separate non-executing preflight revalidates the accepted report and repeats that exact two-reader quote; any changed identity, amount path, minimum, deadline, quote ID, or calldata discards the old result and requires renewed review. Universe exposes this read-only revalidation, removes green quote evidence automatically when the quote, manifest, or policy first expires, and invalidates it immediately when any upstream input changes. Verification and quoting remain a design gate; no production venue, read policy, reviewed operator pair, signing, submission, or execution authority is bundled.
- `src/wallet/` contains EIP-6963 multi-provider discovery, the explicit wallet-session reducer, and strict local-provider/CAIP-25 execution grants. Every executable quote binds one transport, CAIP-2 chain, CAIP-10 account, required method and notification set, expiry, and session revision.
- `src/wallet/walletconnect.ts` and `use-walletconnect.ts` add an optional WalletConnect EVM transport. It requests only `eth_sendTransaction`, `accountsChanged`, and `chainChanged`, derives approved chains from CAIP-10 accounts, restores only revalidated SDK sessions, rejects stale async approvals, and invalidates quotes before explicit disconnect, session update, deletion, or expiry.
- `src/wallet/walletconnect-universal.ts` adds a local, inspection-only WalletConnect session report for EVM, Solana, Cosmos, and Bitcoin namespaces. It checks family-specific accounts, minimum signing methods/events, unmodeled authority, and explicit or parameter-capable broadcast exposure; hashes topic/account identifiers and never pairs, connects, persists a session, or enables execution. Bitcoin mainnet/testnet accounts additionally require a matching BIP122 chain, Base58Check version/checksum or SegWit HRP, witness length/version, and the correct Bech32/Bech32m checksum family. Other BIP122 networks stay CAIP-only. Sources: official [App SDK overview](https://docs.walletconnect.network/app-sdk/overview), [Bitcoin methods](https://docs.walletconnect.network/wallet-sdk/chain-support/bitcoin), [BIP-173](https://github.com/bitcoin/bips/blob/master/bip-0173.mediawiki), [BIP-350](https://github.com/bitcoin/bips/blob/master/bip-0350.mediawiki), and Chain Agnostic [BIP122 chain/address profiles](https://namespaces.chainagnostic.org/bip122/caip10) (reviewed 2026-09-01).
- `src/wallet/bitcoin-psbt.ts` adds a bounded, inspection-only PSBT v0 safety boundary. A canonical base64 PSBT must contain one legacy-serialized unsigned transaction, exact native P2WPKH/P2TR witness UTXOs, exact ordered outputs, exact fee, version, sequences, locktime, and a canonical intent lasting no more than 15 minutes. It derives a conservative signed-vsize range from BIP-141 transaction weight using the supported P2WPKH and P2TR key-path witness bounds, then reports a milli-sat/vB fee-rate range without manufacturing a signature. Duplicate/non-minimal keys, PSBT v2, non-witness inputs, partial/final signatures, unsafe sighashes, output metadata, unknown fields, extra outputs, and mismatched UTXOs fail closed. Success is still `verified-design-gate`; no signer, finalizer, broadcaster, UTXO source, or Bitcoin swap venue is installed. Sources: [BIP-174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki), [BIP-370](https://github.com/bitcoin/bips/blob/master/bip-0370.mediawiki), [BIP-141](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki), and [BIP-341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki) (reviewed 2026-09-01).
- `src/wallet/bitcoin-utxo-quorum.ts` adds an optional read-only gate after PSBT inspection. Exactly two independent public HTTPS Esplora hosts are queried with genuinely stream-bounded, timeout-controlled GET requests. Both must prove the BIP122 genesis prefix, exact transaction output value and script, matching confirmation block, an unspent outpoint, sufficient confirmations, and bounded tip divergence. `src/wallet/bitcoin-fee-policy.ts` then requires both readers' 6-block fee estimates to agree within 50%, and requires the conservative actual fee-rate range to remain within both absolute 1–1000 sat/vB limits and 0.5×–5× recommendation limits. These defaults are a fail-closed inspection policy, not a promise of confirmation time. Endpoint or PSBT changes invalidate late results. Reports retain only fingerprints, counts, and fee ranges, always keep execution/signing/broadcast false, and never call Esplora's transaction-broadcast endpoint. Sources: Blockstream's [Esplora HTTP API](https://github.com/Blockstream/esplora/blob/master/API.md) and the Chain Agnostic [BIP122 chain profile](https://namespaces.chainagnostic.org/bip122/caip2) (reviewed 2026-09-01).

- `src/wallet/bitcoin-read-policy.ts` removes arbitrary endpoint and threshold entry from the read gate. A locally pinned source descriptor fixes an EIP-191 publisher and allowed BIP122 chains. Its signed policy binds the exact source fingerprint, chain, two independent public Esplora hosts, UTXO and fee rules, evidence, issue/expiry timestamps, and monotonic revision. Unknown fields, source/signer substitution, an out-of-scope chain, private or duplicate hosts, invalid nested rules, expiry, rollback, and same-revision equivocation fail closed. The UI persists only the revision/payload-hash head per source fingerprint; it does not persist signatures, endpoints, PSBTs, wallet material, or authority. No production source or signed policy is bundled. Source: [ERC-191](https://eips.ethereum.org/EIPS/eip-191) (reviewed 2026-09-01).
- `src/wallet/bitcoin-signed-psbt.ts` verifies a wallet-returned PSBT entirely offline after the exact intent, two-reader UTXO/fee evidence, and signed read policy have all passed. The unsigned transaction and every non-signature PSBT field must remain byte-identical. Native P2WPKH accepts one strict low-S DER ECDSA `SIGHASH_ALL` signature whose compressed public key hashes to the witness program; native P2TR accepts one BIP-340 key-path Schnorr signature with only `SIGHASH_DEFAULT` or `SIGHASH_ALL`. Final scripts, Taproot script paths, extra/unknown metadata, unsafe sighashes, substituted evidence, and stale five-minute envelopes fail closed. The privacy-minimized report contains fingerprints and signature counts only; it cannot request a signature, finalize, extract, or broadcast. Sources: [BIP-174](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki), [BIP-143](https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki), [BIP-340](https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki), and [BIP-341](https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki) (reviewed 2026-09-01).
- `src/wallet/bitcoin-finalized-psbt.ts` verifies—but does not perform—external PSBT finalization. It freshly re-verifies the signed PSBT and every upstream safety report, then accepts only one exact `finalScriptWitness` plus the unchanged witness UTXO per native input. P2WPKH witness items must byte-match the verified signature and compressed public key; P2TR must contain only the verified key-path Schnorr signature. Retained signing metadata, `finalScriptSig`, altered/extra witness items, non-minimal witness lengths, transaction or evidence substitution, and stale envelopes fail closed. The verifier reconstructs the witness serialization only in memory to derive txid, wtxid, exact weight/vsize, and fee rate; it returns no raw transaction and provides no extraction or broadcast method. Sources: [BIP-174 finalizer/extractor roles](https://github.com/bitcoin/bips/blob/master/bip-0174.mediawiki) and [BIP-141 transaction identifiers and weight](https://github.com/bitcoin/bips/blob/master/bip-0141.mediawiki) (reviewed 2026-09-01).

## Universal DEX direction

The **Universe** screen establishes an open-ended registry for chain namespaces, wallet capabilities, and CAIP-19 asset identities. It deliberately separates discovery from execution: adding a chain, wallet, or token record never installs an adapter or grants signing permission. Current capability states are **Executable**, **Partial**, and **Design gate**.

This is the foundation for broad coverage, not a claim that every network or asset is already tradable. See [docs/UNIVERSAL_DEX_ARCHITECTURE.md](./docs/UNIVERSAL_DEX_ARCHITECTURE.md) for adapter boundaries, safety invariants, current coverage, and the expansion sequence.

The **Release** registry view starts the separate “real DEX” lane. It can inspect an exact Base Sepolia deployment-evidence manifest and, after import, query two public HTTPS RPC hosts to compare chain ID, deployment blocks and receipts, and exact Factory/Router runtime code. RPC URLs remain in page memory only; URL credentials, query parameters, localhost, private-network addresses, and same-host pairs are rejected. Verification remains read-only and cannot deploy, sign, publish, add liquidity, or enable mainnet. See [docs/REAL_DEX_RELEASE_GATE.md](./docs/REAL_DEX_RELEASE_GATE.md).

## Cross-chain bridge design gate

Recovery preparation begins only after the active wallet account, duplicate intent, and byte-identical durable execution guard have passed, and immediately before the adapter can request signing or submit value. A rejected connection, wrong network, changed account, duplicate intent, or guard failure therefore creates no ambiguous transfer reservation. If reservation preparation fails, the adapter is not called; the new guard is removed only when exact deletion can be verified and otherwise remains fail-closed.

The UI models EVM→EVM, EVM↔non-EVM, and non-EVM→non-EVM routes. Installed bidirectional testnet routes are Base Sepolia↔Solana Devnet and Base Sepolia↔Arbitrum Sepolia through Circle CCTP V2, plus Noble Testnet↔Osmosis Testnet USDC.n through IBC ICS-20. Unknown, experimental, mismatched, stale, or modified routes cannot submit a transfer. Importing a local route manifest is inspection-only and never installs signing code.

All four Base-dependent CCTP routes are currently paused. On 2026-09-02, both pinned Base Sepolia RPC readers briefly returned empty runtime bytecode for the USDC address still listed in Circle's public address table. A later two-reader recheck found the proxy restored, but restoration alone cannot re-enable value movement. The Bridge UI can now read the current chain ID, heads, proxy and implementation code, Circle proxy implementation slot, and exact ERC-20 name/symbol/decimals from both pinned hosts. The resulting quorum evidence always carries `executionEnabled: false` and `releaseApprovalRequired: true`; the adapter remains blocked before wallet connection, quote retrieval, approval, burn, or mint. Base Sepolia USDC is also marked `design-gate`, not execution-ready, in the universal asset registry. Historical operations remain available for read-only recovery.

A separate signed release-review boundary now binds a separately pinned EIP-191 reviewer source, the fresh two-RPC observation fingerprint, both code identities, Circle source repository commit and build settings, source and verification-artifact hashes, monotonic revision, and expiry. A valid signature is still assessment-only: execution, signing, and submission remain false and explicit user release approval remains required. No production reviewer or manifest is installed. See [docs/CCTP_ASSET_RELEASE_GATE.md](./docs/CCTP_ASSET_RELEASE_GATE.md).

The CCTP adapter disables Bridge Kit error telemetry and charges no RealDEX fee. Circle attestation and forwarding remain external dependencies and route fees are shown from a short-lived signed quote before approval or burn. A Bridge Kit `success` result remains source submitted until independent evidence exists; provider completion alone is not source inclusion or destination confirmation. Before wallet execution, RealDEX writes and exactly reads back a quote-bound recovery reservation. Circle's exact successful `burn` event synchronously upgrades that reservation into a source-submitted finality record while Bridge Kit may still be waiting for attestation or forwarding; approval and mint hashes are never accepted as source-burn cursor candidates. Each new CCTP cursor also binds the exact burn token, base-unit amount, source message sender, and destination mint recipient. Status refresh parses those fields from Circle's raw CCTP V2 message bytes instead of trusting its decoded JSON projection; a different or malformed message cannot enter the operation history. For Base Sepolia and Arbitrum Sepolia sources, two independent public RPC hosts must additionally agree on the exact successful receipt, block identity, and one canonical `MessageSent(bytes)` log whose payload equals Circle's raw message. Two source confirmations are required before the record can advance to source included. Missing, reverted, divergent, malformed, or under-confirmed observations leave it source submitted. Historical CCTP cursors without transfer binding remain readable but cannot be refreshed. Solana-source CCTP remains partial because its program-log proof uses a different transaction format and is not yet independently verified here. The IBC adapter similarly emits its validated packet identity immediately after the source response is parsed. If a reservation survives without a source transaction identity, reload displays a do-not-retry reconciliation warning rather than assuming no submission. The IBC adapter re-checks both reciprocal channels before estimating and signing, estimates source gas through the connected Keplr-compatible wallet, uses a 20-minute packet timeout, and never presents source inclusion as destination acknowledgement. All installed bridge status and channel reads use credential-free HTTPS GET requests with an eight-second timeout, a one-megabyte response cap, and strict JSON parsing. Timeout, oversized, malformed, or unexpected responses preserve the prior finality evidence and cannot authorize success, retry, or a second submission. Submitted operations persist up to 16 separately keyed records or reservations across reloads and expose a manual, read-only status refresh plus an operation selector. A route-scoped origin-wide Web Lock serializes the complete reservation, wallet execution, and evidence-persistence section, and separately serializes each refresh from durable-latest reload through its monotonic save. A competing tab or unavailable lock service stops before wallet connection or leaves the prior evidence unchanged. A later transfer on the same route cannot overwrite an older unresolved transfer. Every write requires byte-identical storage readback and a monotonic revision that preserves prior evidence; identity collisions, stale revisions, evidence deletion, quota, permission, mutation, or readback failure retain the prior recovery state and surface a do-not-retry error. Historical v1 records remain readable for tracking but cannot be extended. Mainnet remains disabled.

For Base Sepolia and Arbitrum Sepolia destinations, Circle's `forwardTxHash` remains submission evidence only. Two independent destination RPC hosts must agree on the successful receipt and two confirmations, one canonical MessageTransmitterV2 `MessageReceived` matching the raw nonce/source/sender/finality/body, and one canonical TokenMessengerV2 `MintAndWithdraw` matching the EVM recipient, chain-specific USDC, net mint amount, and executed fee. Only that complete evidence set can produce destination confirmed; persisted EVM destination claims without it are rejected.

See [docs/BRIDGE_ARCHITECTURE.md](./docs/BRIDGE_ARCHITECTURE.md) for the adapter model, official protocol evidence, security trade-offs, and the chain/asset decisions required before enabling a testnet route.

## Local demo

Validated toolchain: Node.js **24.14.0** (`.node-version`) and pnpm **11.25.0** (`packageManager`). Keep `pnpm-lock.yaml` and `pnpm-workspace.yaml` with the source checkout.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
pnpm run node
```

If pnpm is not installed, bootstrap the pinned version with `npm exec --yes --ignore-scripts --package=pnpm@11.25.0 -- pnpm install --frozen-lockfile --ignore-scripts`. Do not replace this with `npm install` or regenerate the lock to hide a mismatch. Installation lifecycle scripts are deliberately skipped; the contract tests and production build below verify the resulting toolchain. A fresh checkout can reuse pnpm's integrity-checked package store; this is not a cold-cache download or a dependency security audit.

In a second terminal:

```powershell
pnpm run seed:local
pnpm run dev
```

For a local routing fixture, use `pnpm run seed:multi-venue`. It prints two direct venues, a third factory containing a better two-hop path, the intermediary token, and the router. Configure the first factory as primary, the other two under additional factories, plus the printed router and intermediary token; the Swap screen will verify all code identities and expose three executable candidates.

To generate a read-only Base Sepolia release plan for the current exact source bundle, run `npm run release:plan:base-sepolia`. It only prints a design-gated JSON plan; it does not contact a network, request a wallet, deploy, or write a secret.

The root `http://127.0.0.1:5173` opens the fixed v0.1 surface and intentionally cannot accept local demo addresses. For the preserved generic local demo, open `http://127.0.0.1:5173/experimental.html`, then enter the addresses printed by `seed:local` under **Setup**. This alternate entry is restricted to localhost development and is absent from the default production output. Add the Hardhat network (`http://127.0.0.1:8545`, chain ID `31337`) to a development wallet only. Hardhat test private keys are public and must never hold real assets.

WalletConnect is optional and remains disabled when `VITE_WALLETCONNECT_PROJECT_ID` is absent. Copy `.env.example` to a local `.env`, provide a public Reown project ID for the exact development origin, and restart Vite. The Project ID enables session negotiation; it does not authorize a transaction. Never place wallet keys, seed phrases, or private credentials in Vite environment variables.

Selecting WalletConnect initializes its provider and checks the SDK's existing encrypted session store. RealDEX does not duplicate the session topic or wallet keys in its own configuration. A restored session must pass the same topic, expiry, namespace, CAIP-10 account, chain, method, and event validation as a new approval. Selecting another transport immediately drops RealDEX's quote authority but leaves the remote WalletConnect session available for revalidation when selected again. **Disconnect WalletConnect** is different: it calls the provider's disconnect operation, revokes the remote session, and invalidates quote authority before waiting for the remote result. A stored session that fails validation can be explicitly cleared from Setup.

## Verification

The finite v0.1 acceptance criteria are in [V01_SCOPE](docs/V01_SCOPE.md); current evidence and remaining gaps are tracked in [V01_PROGRESS](docs/V01_PROGRESS.md). The generic local demo and preserved experimental adapters are not evidence of v0.1 public-testnet acceptance.

```powershell
pnpm test
pnpm run build
```

`test:release-plan` uses Node's built-in runner; `test:ui` discovers only `src/**/*.test.{ts,tsx}` with Vitest. Both run in `pnpm test`. The release-plan tests cover dependency-lock binding, every listed input changing the release identity, missing inputs, and single-read identity metadata.

Vitest runs with one to two workers (`vitest.config.ts`) so Hardhat, cryptographic fixtures, and jsdom do not launch a worker per available CPU on shared development PCs. This preserves parallel execution and the existing test timeouts/assertions. Record any CLI worker override with its results; a single-worker diagnostic pass is not evidence that a failed higher-concurrency run passed. The planner digest covers its explicit source list, not this test configuration or every test file, so final clean-build evidence must identify these inputs separately.

The tests cover pair uniqueness, liquidity accounting, withdrawal, exact-input swaps, exact approvals, deadlines, stale quotes, EIP-6963 multi-provider selection and collision quarantine, explicit wallet-session transitions, exact-chain CAIP-25 scope parsing, WalletConnect namespace/session lifecycle, persisted-session restoration, explicit remote disconnect, invalid-session clearing, stale approval rejection and least-privilege proposals, universal WalletConnect EVM/Solana/Cosmos/Bitcoin inspection, Bitcoin Base58Check and SegWit network/checksum/witness validation, exact-intent PSBT v0 parsing, UTXO/output/fee/sequence/locktime binding, partial-signature and unsafe-sighash rejection, two-host Esplora chain/outpoint/script/value/spent/confirmation quorum, timeout and malformed-response rejection, identifier privacy, family account validation, missing grants and broadcast exposure, provider/session grant fingerprints, method/notification/account/expiry rejection, all bridge route classes, CCTP and IBC direction manifests, CAIP chain/asset identity, inspection-only and signed token manifests, signer substitution, expiry, rollback, revision equivocation, metadata collisions, EVM bytecode/metadata checks, two-host Solana mint and Cosmos bank-metadata quorum checks, stale reader-result rejection, compiled factory/router runtime identities, multi-factory discovery, spoofed pool rejection, best direct/multi-hop selection, atomic final-slippage rollback, cyclic-path rejection, strict unsigned Solana v0 transaction decoding, exact upgradeable-program data identity, SPL Token Swap pool/account-role and instruction-data binding, Ed25519 signed-message recovery binding, history-aware two-RPC status quorum, blockheight expiry without unsafe retry, account-role and blockhash-lifetime checks, two-host swap simulation agreement, canonical Cosmos `TxRaw` structure, DIRECT sign-mode and sign-document binding, sequence/fee/timeout checks, Osmosis exact-input protobuf and route binding, exact simulated Cosmos debit/credit/gas quorum, low-S secp256k1 signed-Tx recovery binding, bech32 authority derivation, two-REST committed-status quorum, timeout-without-unsafe-rebroadcast handling, External V2 source-fingerprint/signature/expiry/revision binding, JSON-safe venue identity hydration, two-host read-only Router/Factory/Pair quorum, external V2 exact approval/swap envelope binding, two-RPC receipt/nonce quorum, consumed-nonce replacement ambiguity, universal route/quote binding, exact execution targets, account changes, missing-adapter and wallet-capability gates, duplicate execution, ambiguous failed-receipt retention, explicit EVM/Cosmos failure proofs, validated pending progress, exact decimal conversion, destination formats, bridge finality identity, stale status-result rejection, route-bound persistence, raw CCTP V2 message/transfer binding, two-RPC CCTP source receipt and MessageSent-log binding, CCTP message status, IBC packet acknowledgement, and invalid state transitions.

The Bitcoin-specific coverage additionally includes conservative P2WPKH/P2TR signed-vsize and integer fee-rate bounds, two-host Esplora fee-estimate agreement, underpayment/overpayment rejection, unsupported targets, and stream-oversized responses without `Content-Length`.

Signed Bitcoin read-policy coverage includes exact publisher/source fingerprints, EIP-191 recovery, BIP122 scope, normalized independent public endpoints, nested UTXO/fee rules, expiry, rollback, same-revision equivocation, current revalidation, and UI enforcement that no unsigned default policy can start a read.

Signed-PSBT coverage adds mixed P2WPKH/P2TR verification, low-S ECDSA and BIP-340 Schnorr checks, exact original/UTXO/fee/policy rebinding, unsafe-sighash rejection, finalization-field rejection, stale-envelope rejection, and output privacy checks without any wallet or network call.

Finalized-PSBT coverage adds exact witness-stack/signature matching, finalizer metadata-clearing enforcement, non-minimal/trailing witness rejection, txid/wtxid and exact-vsize derivation, stale evidence rejection, and explicit extraction/broadcast disablement.

The automated test suite also covers two-RPC EVM CCTP destination receipt agreement, raw `MessageReceived` binding, net `MintAndWithdraw` binding, missing or divergent receipts, under-confirmation, malformed fees, and persisted destination-proof removal.

## Transaction safety

- Wallet connection is separate from approval and value-moving transactions.
- Token approvals use the exact required amount rather than unlimited allowance.
- Swap confirmation shows the input, estimated output, minimum output, price impact, protocol fee, chain, pool, slippage, and deadline.
- Liquidity addition uses a 0.5% minimum-share bound; withdrawal uses 0.5% minimum-token bounds.
- Account, chain, or wallet disconnect changes invalidate the active quote through a monotonic session revision.
- EIP-6963 providers are selected by their page-session UUID. Multiple announcements require an explicit choice; UUID collisions are quarantined, self-asserted names/RDNS are not treated as identity proof, and the exact selected provider is injected into Swap, Liquidity, and EVM-source CCTP.
- Provider discovery is not treated as negotiated permission. Local provider bindings, accepted CAIP-25 session responses, and validated WalletConnect EVM sessions are normalized into short-lived, exact-chain grants; an ungranted account, method, notification, transport, revision, or expired grant fails before quoting or execution. Non-EVM WalletConnect session JSON can now be inspected locally, but no non-EVM WalletConnect transport, pairing, signing, or broadcasting is installed.
- The EVM swap displays and executes the same route-engine quote; it expires automatically and re-checks pool, pair, account, network, allowance, target, and deadline before submission.
- Multiple verified RealDEX v1 factories are quoted independently. Changed bytecode, pool origin, token pair, or venue configuration invalidates selection; rejected venues remain visible as a count and cannot receive a transaction.
- Multi-hop approval targets only the hash-pinned router. Its ordered pools and tokens are bound to the quote and reverified after approval; a failed final minimum output rolls back every prior hop.
- The Solana safety boundary accepts only an unsigned v0 transaction with no address lookup tables, one signer, and one venue instruction. Exact program-data bytes, account roles, token accounts, mints, input/minimum-output values, quote and blockhash lifetimes, and matching two-host simulation deltas are required; the result remains design-gated and cannot request a signature.
- The SPL Token Swap decoder accepts only tag `1` followed by exactly two little-endian u64 values and the exact 14-account pool layout, with a separately declared fifteenth host-fee account when present. The pool state is a first-class execution target in both venue and intent; changing only the pool invalidates the transaction. When using the source-bound route path, the complete topology is authenticated by the signed route and the decoder cannot be supplied separately. The archived reference implementation is decoded for compatibility, not treated as current deployment authority.
- The SPL Token Swap quote gate supports only the archived reference's classic constant-product curve and classic 165-byte token accounts. Two hostnames are required, but distinct hostnames do not prove distinct operators or upstream infrastructure. Pool state can also change between the read-only quote snapshots and simulation, so both gates must pass and neither is permission to sign or submit.
- A Solana recovery record is created only after the submitted 64-byte signature verifies against the exact unsigned message and authority, and its transaction/intent hashes match the two-RPC simulation evidence. Status refresh uses `getSignatureStatuses` with full-history search on two hosts, preserves the weaker agreed commitment, and rejects chain, slot, failure, height, reader, and monotonic-stage disagreement. A missing signature after `lastValidBlockHeight` becomes `expired-unresolved`, never success, failure, or automatic retry permission.
- The Cosmos safety boundary accepts one canonically ordered unsigned `TxRaw` with one empty signature placeholder, one DIRECT signer, one venue message, one fee coin, no memo or extension options, and no fee payer, granter, or tip. It binds chain/account/sequence/fee/timeout and requires two REST simulations to agree on exact debits, credits, and gas; it remains design-gated and cannot request a signature.
- The Osmosis decoder accepts only the non-split GAMM exact-input message whose sender, ordered pool IDs, hop output denoms, input coin, and minimum output exactly match a separately reviewed descriptor. A signed-source gate can authenticate that descriptor with an exact low-S secp256k1 publisher assertion and monotonic revision head, but it remains provenance-only. Unknown fields, non-canonical protobuf, duplicate pools, cyclic denoms, zero values, and more than four hops fail closed. No production publisher, real pool, or quote source is enabled.
- A Cosmos recovery record requires the signed and simulated `TxRaw` to have byte-identical body/auth data, verifies one canonical 64-byte low-S secp256k1 signature, derives the exact bech32 authority from the public key, and recomputes the transaction, sign-document, and intent hashes. Two REST hosts must agree on chain, head, transaction height, code, codespace, and gas. A missing indexed transaction after timeout is `expired-unresolved`; the journal never stores rebroadcast bytes or grants retry authority.
- After a verified Cosmos signature-only result, the UI offers an explicit read-only status lookup. It displays the full chain, hash, approved REST pair, policy revision and expiry before any request. The signed policy must opt into `cosmos-swap-recovery-v1`, match the original reviewer and chain, and match the current accepted local head. Missing, expired, changed or simulation-only policies block lookup. Cancellation stops observation only; failed refreshes retain the last accepted timestamped result as historical, and no result releases signing history or enables resend. The receipt and genuine evidence are page-local: changing the verification context, leaving, or reloading discards them. Durable authenticated restoration and reservation reconciliation remain unfinished. Two-reader observations are not independent consensus/finality proofs. `scripts/qaCosmosRecovery.mjs` exercises synthetic display/interaction fixtures with external HTTP blocked; it does not test a real wallet or production chain.
- An External EVM V2 recovery record accepts only an exact-size ERC-20 approval to the verified Router or the exact verified swap envelope, including account, chain, target, zero value, calldata, nonce, transaction hash, and pre-submission block. Exactly two public HTTPS RPC hosts must agree on the transaction, receipt, nonce-consumed state, and bounded head divergence. Missing transaction and receipt evidence after the nonce is consumed becomes `replacement-unresolved`; the journal stores no signed raw transaction and never grants retry authority.
- An External V2 venue manifest binds its full source descriptor fingerprint into the signed payload, so substituting signer policy, evidence, or allowed-chain scope invalidates it. The UI stores only a revision/payload-hash head and rejects rollback or same-revision equivocation. On-chain verification uses only `eth_chainId`, `eth_getCode`, and `eth_call` on two different public hosts; success still cannot request an account, approval, signature, swap, or retry.
- EVM approval and swap evidence persists in a route-, quote-, account-, value-, target-, calldata-, nonce-, and chain-bound recovery journal. Manual status refresh is read-only and distinguishes submitted, bounded replacement search, included, two-confirmation confirmed, reverted, and replaced. An exact fee-only repricing may continue as the same intent; a cancellation or changed transaction is never accepted as swap success, and missing evidence remains blocked rather than being guessed safe to resend.
- Submitted and confirmed states are distinct, and approval and swap transaction hashes remain separately visible.
- Bridge status is monotonic and bound to the exact route, quote, operation, protocol cursor, and evidence IDs. Reloaded or late status results cannot overwrite a newer or different operation.
- Fee-on-transfer and other balance-changing ERC-20 behavior is rejected by the pool.

## Known limitations

- The contracts have not received an independent security audit or formal verification.
- The Base Sepolia release gate verifies evidence but has not deployed the contracts. Passing it would not authorize deployment, liquidity, publication, or mainnet use.
- Zero trading fees mean liquidity providers receive no trading-fee income. They still bear price movement, arbitrage, sandwiching, and smart-contract risk.
- The EVM swap screen compares direct and 2–4 hop paths across exact bundled RealDEX v1 factory/pool identities and supports EIP-6963 injected providers plus an optional WalletConnect EVM session. It still supports exact-input swaps, manually configured intermediary tokens, and standard ERC-20 behavior only. WalletConnect requires an origin-bound Reown Project ID and has not been exercised with an actual mobile wallet in this repository. Nonce replacement recovery scans at most 24 blocks per manual refresh and persists its next cursor; provider history limits can therefore leave a result unknown, which remains blocked from replay. External EVM V2, Solana, and Cosmos verifiers now bind their family-specific transaction representations and have non-executing family-specific recovery journals. Bitcoin has exact mainnet/testnet address checks, a strict PSBT v0 native-witness inspector, an optional two-host read-only Esplora UTXO verifier, and a conservative two-reader fee policy, but no bundled trusted endpoint list, user-selected/signed production fee policy, PSBT v2 or legacy-input verifier, ownership proof, Bitcoin swap/atomic-swap venue, signing transport, finalizer, broadcaster, or recovery journal. External V2, Solana, and Cosmos/Osmosis now have signed-source gates, but no reviewed production source descriptor or public venue manifest is bundled. SPL Token Swap and Osmosis have strict exact-input decoders, but neither has a reviewed public pool/quote descriptor. None has an installed external execution transport. Non-EVM WalletConnect namespaces, custom mobile deep links, hardware-wallet transports, and external quote aggregators remain unavailable. Permit flow, native-token wrappers, live token-list execution, oracles, indexers, and fee-on-transfer support remain unavailable.
- Bitcoin read policies now have a signed EIP-191 source/revision format, but no production publisher, source descriptor, signed policy, or operator-independence review is bundled. Bitcoin still has no PSBT v2 or legacy-input verifier, ownership proof, swap/atomic-swap venue, signing transport, finalizer, broadcaster, or recovery journal. The installed signed/finalized PSBT verifiers accept only native P2WPKH and P2TR key-path data, do not themselves finalize or return raw transaction bytes, and never turn verification into execution authority.
- Token metadata is untrusted on-chain input. Verify chain ID, token addresses, pool address, decimals, and bytecode before every real deployment.
- A valid token-list signature proves only that the session-pinned key signed that payload. It does not prove benign token behavior, liquidity, bridge equivalence, or execution readiness. The bundled source files contain placeholders, not a trusted production publisher.
- Immutable contracts cannot be patched or paused. A vulnerability requires migration to a new deployment.
- The installed Base Sepolia/Solana Devnet and Base Sepolia/Arbitrum Sepolia bridges use Circle's issuer attestation and Forwarding Service. They are not operatorless, only transfer USDC, and have not been exercised with a real wallet in this repository.
- The installed Noble Testnet/Osmosis Testnet route is testnet-only. Relayers are required for liveness. The UI queries the exact packet acknowledgement and records whether one configured REST endpoint reported success or an application error, but both outcomes remain non-terminal `destination-observed`. Only independent Merkle-proof verification against an accepted trusted IBC header may advance to destination confirmed or terminal failure. It has not been exercised with a funded wallet in this repository.
- Legal treatment depends on deployment, distribution, governance, promotion, jurisdiction, and actual operation—not the software license alone. Obtain qualified review before public or mainnet use.

See [SECURITY.md](./SECURITY.md) before extending or deploying the protocol.

## License

MIT. See [LICENSE](./LICENSE).
