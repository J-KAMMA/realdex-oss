# RealDEX ローカル継続開発 — INJ-10

INJ-09を親に、送信試行済み取引の期限超過を、未消費sequence・チェーン継続性と
別の所有者承認で終了する経路を追加。旧署名と送信観測は残し、未送信と混同しない。
単一ローカルノードの観測であり、一般的な送信失敗証明や本番承認ではない。

[最新の完成ロードマップ](plans/COMPLETION-INJ10-2026-09-07.md) ／
[仕様・制限・再現手順](docs/adapters/INJECTIVE-SUBMISSION-EXPIRY-2026-09-07.md)

ユーザー指示によりローカル検証完了後にGitHub専用ブランチへ引き渡す。
実際の公開状態と版のハッシュは、配布物のLINEAGEと報告書を参照。

---

## INJ-09 時点の記録

# RealDEX ローカル継続開発 — INJ-09

現在のローカル作業はINJ-08を親にした**チェーン継続性検査**です。GitHubは使用せず、
配布ZIP・完全Git bundle・ソースに束縛した生ログで引き継ぎます。本番承認はありません。

[完成ロードマップ](plans/LOCAL-COMPLETION-2026-09-07.md) ／
[機械可読計画](plans/LOCAL-COMPLETION-2026-09-07.json) ／
[今回の実装・安全境界](docs/adapters/INJECTIVE-CHAIN-CONTINUITY-2026-09-07.md)

同じchain IDでも、確認時と保存済み履歴のブロックが異なる場合は、署名・初回送信・結果照合・
未送信期限切れ終了を拒否します。履歴削除や古いbackupへの差替えで解除する機能ではありません。
単一ノードの観測であり、独立したチェーン状態の証明でもありません。

実行：`node app/cli.mjs start`。回帰：`node app/ci.mjs --suite all --jobs 3 --output /new/path/source-ci`。
以下の旧README、CURRENT/RELEASE、旧app/roadmapのGitHub記述・版名・試験件数は当時の履歴です。
現在のcommit・検証結果・配布物のhashは、ZIPのLINEAGE.jsonと同梱報告書を確認してください。

---

## 過去のリリース概要（当時の記録）

# RealDEX v0.26 — Git collaboration and Injective order preparation

**Development only. Production approval remains false.**

This release uses v0.25 as its immutable source parent and records all work in
Git commits. It adds bounded parallel source CI, isolated worktree lanes, private
GitHub publication tooling, consistent release/runtime diagnostics, and unsigned
Injective limit/cancel message preparation. It does not enable external venue
orders, mainnet transfers or additional signer permissions.

- Start locally: `node app/cli.mjs start`
- Run parallel source tests: `node app/ci.mjs --suite all --jobs 3 --output ci-output`
- Inspect workstreams: `node dev/workspace.mjs validate`
- Create a worktree: `node dev/workspace.mjs create injective`
- Show the offline order example: `node node/spot-order.mjs`
- GitHub publication: see [CONTRIBUTING.md](CONTRIBUTING.md) and [quickstart](docs/v0.26/QUICKSTART-JA.md)

**GitHub repository creation, push and remote CI have not been executed in this
session.** The connected API exposes read operations and no authenticated local
GitHub CLI is available. The Git bundle preserves all commits for a local clone
and private publication using the owner's local `gh` login.

---

# RealDEX v0.25 — 統合ロードマップ・外部現物板の接続

正本の親は **v0.24 Bounded IBC Relayer** です。`RELEASE.json`に親ZIPのハッシュと今回の範囲を固定しています。旧版の機能・コード・検証記録は保持し、同じ版名への上書きや、以前の段階への巻戻しをしません。

**開発版・未監査・本番承認なし。実資産のある鍵を使用しないでください。** 今回の外部接続は市場・板の読み取りと試算です。注文、署名、送信、出金、AIの新権限は追加していません。

## 計画と開発

[統合ロードマップ](plans/DEVELOPMENT-ROADMAP-JA-2026-09-06.md) / [正本JSON](plans/DEVELOPMENT-ROADMAP-2026-09-06.json) / [今回の実装](docs/v0.25/DEVELOPMENT-REPORT-JA.md)

Injective → HyperCore → Chainflip → THORChain → Jupiterを優先し、12候補を既存計画へ統合しました。現物、資産移転、先物は別機能として扱います。上位100位は独自チェーンと発行先トークンを分け、ICP・プライバシー・私設チェーンも継続します。

- **今回:** InjectiveのMarket/OrderbookV2バイナリgRPC-Web、HyperCoreのspotMeta/l2Book HTTP。正確な有理数・整数で手数料、ロット、価格条件、残った入力額、板不足を計算します。
- **次:** Injectiveの注文・subaccount・部分約定・取消し・実出金の実装と検証。正式環境・公開ゲートは並行して仕上げます。
- **保持:** 自前AMM・ウォレット・スマートアカウント・非EVM送金・IBCブリッジ・専用費用鍵の中継。保持と本番完成は別です。

## 起動

```sh
node app/cli.mjs start
```

読み取り画面: `http://127.0.0.1:8787/node/spot/`。通常の追加Nodeサービスにnpm installは不要です。旧プロセスを終了し、既存の暗号化バックアップを保全してから更新してください。所有者専用URLは共有しないでください。

ネットワークを使わないデモ:

```sh
node node/spot.mjs
node node/spot.mjs --provider hypercore --amount 1
```

```sh
node app/roadmap.mjs
node --test node/external/test/*.test.mjs
node app/verify.mjs --output /path/to/new-acceptance
```

[起動・設定・更新手順](docs/v0.25/QUICKSTART-JA.md) / [信頼境界](docs/v0.25/SECURITY-JA.md) / [仕様の出典](node/external/SOURCES.md)

根拠が不明な費用をゼロとして最良経路を選びません。取引残高と外部ウォレットへの着金を区別します。リダイレクト・自動プロバイダ代替・ウォレットからの鍵流用をしません。

旧READMEは[履歴](docs/history/README-v0.24.md)へ保存しています。そこにある旧版の試験件数・未達事項は当時の記録であり、今回の証拠には合算しません。全体Reactビルド・正式コンパイラ・実ブラウザHTTP/CSP・公開ネットワーク・独立監査は別ゲートです。

配布物の現行ハッシュ一覧は `FILES.sha256`、親版の一覧は `evidence/v0.25/parent-FILES.sha256` です。バージョン名付きの古いmanifest・evidenceは履歴として保持しています。
