# RealDEX v0.23 起動・更新・自動追跡

## 対象

v0.22のローカルIBCブリッジに、受取・ACK・timeout取引の自動検出と、所有者が停止できる定期的な読み取りを追加した開発版。実資産を使わない。常駐中継サービスでも本番対応でもない。

## 更新と通常起動

旧プロセスを正常終了し、暗号化バックアップと設定を保全する。新しいZIPを別フォルダーへ展開する。保存先を自動移行しない。

```sh
node app/cli.mjs start
```

追加サービスの起動にはNode 22.16以上が必要。今回試験したのはLinux x86-64 / Node 22.16.0。通常起動に新しいnpm依存、IBCノード、コンパイラは不要。実際のIBC追跡には、自設のローカルチェーンと既存の確認済みIBC経路設定が必要。

ターミナルに出るウォレット所有者専用URLは、AI・他人・共有ノードへ渡さない。旧来の単独ウォレット保存先を使う場合は `node wallet/cli.mjs start` を使う。

## 自動追跡の操作

1. ウォレットを解除し、IBC BRIDGEの履歴を表示する。
2. 対象取引の「中継取引を自動検出して再照合」を押すと、ハッシュを入力せずに一度だけ確認する。
3. 定期確認する場合は「この取引の自動追跡を開始」、または「保存済みの送信履歴を自動追跡」を押す。全体ボタンは署名のみの未送信履歴を除き、最大16件まで。16件を超える場合は個別に開始するかAPIで対象を限定する。
4. 追跡欄に、各履歴の最終試行時刻、試行回数、状態、エラーを表示する。保存済み履歴欄は「保存したブリッジ履歴を表示」で読み直せる。
5. 「自動追跡を停止」は、画面が別の読取りで処理中でも押せる。既に開始したHTTP読取りは終了する場合があるが、停止前の結果を保管庫へ書き戻さない。

既定の同一履歴の間隔は30秒。API指定は5秒〜5分。エラーが続くと最大5分まで間隔を広げる。追跡全体で同時実行は1件。所有者の保留中操作がある場合は譲る。

**追跡は解除中のみ。5分の無操作ロックを延長しない。ロック・設定変更・サービス終了で停止し、再解除・再起動後は明示的に開始し直す。** 自動追跡の許可はメモリ内だけで、バックアップに保存されない。照合結果と検査済みの参照ハッシュは既存の暗号化履歴へ保存される。

## 何を自動化しないか

送信・再送・署名・receive/ACK/timeoutの中継・返金の実行・資金解放はしない。タイムアウトしても中継者が証明を提出して返金処理を完了しなければ、返金済みにはしない。

イベント索引が無効、応答が不一致、候補が多すぎる、既存参照と矛盾する場合は未解決・不整合として表示する。公開RPCへ勝手に切り替えない。手動の中継取引ハッシュ入力と再照合は残している。

## ロードマップ

```sh
node app/roadmap.mjs
```

`plans/DEVELOPMENT-ROADMAP-JA-2026-09-06.md`が完成・本番公開の計画。
`plans/DEVELOPMENT-ROADMAP-2026-09-06.json`が依存関係付きの作業表。着手可能とは作業上の順番を示すもので、本番実行許可ではない。

## ローカル試験

```sh
node app/verify.mjs --output acceptance-local-new
```

2チェーンの実行試験は、同梱しない固定診断ツールを、別配布の `RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip` から取り出す。取り出し先は新しい空のフォルダーを指定する。

```sh
python integration/ibc/provision.py --archive /absolute/path/RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip --output /absolute/path/ibc-tools
export REALDEX_IBC_SIMD_BINARY=/absolute/path/ibc-tools/simd
export REALDEX_IBC_MUSL_LOADER=/absolute/path/ibc-tools/lib/ld-musl-x86_64.so.1
node app/verify.mjs --ibc --output acceptance-ibc-new
```

既存のブリッジ試験と、新しい自動追跡試験の両方が実行される。ツールがない場合はblockedで、要求した試験の成功にはならない。Windowsの通常起動と、Linux専用の診断ツールの対応は別。

実HTTP/CSPブラウザの追跡試験：

```sh
python integration/ibc/tracking-browser-check.py --output browser-tracking-new
```

この環境での結果は `blocked / BROWSER_POLICY_BLOCK`。合成APIの画面試験は `python wallet/test/browser-ibc-tracking.py --output ui-tracking-new` で別枠として実施する。

## 維持している制限

mainnetと公開ネットワークの制限は解除していない。AI MCPや共有ノードに新規の署名権限を渡していない。`finalityProven`はfalseのまま。本番承認、完全ビルド、正式コンパイラ、独立監査、OS鍵保護は未達。

今回、新しい保管庫フィールドは追加していない。v0.22の試験用バックアップの読み戻しも確認するが、古いバックアップや別端末をまたぐ二重署名問題を解決したものではない。
