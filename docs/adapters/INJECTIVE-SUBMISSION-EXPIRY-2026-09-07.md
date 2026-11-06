# INJ-10 — 送信試行済み取引の、所有者承認付き期限超過終了

## 基準・変更範囲

親はINJ-09 `c03b78e73437100162b04ec85b0d0295cdbd5405`、tree
`4963ca38758cbaaca27a6f7c8dd1583149de50ef`。親ZIP SHA-256は
`80f45670a132ba0d29e1cc965b0f89f3ecc2eda37ea2a130a5e16bdc7c9d31c8`。
二つのINJ-07派生を混ぜず、INJ-08→INJ-09の実Git履歴を継承する。
今回のユーザー指示は「ローカル開発を続け、終わったらGitHub」。GitHubの実状態は
ローカル検証後に読み直す。mainの変更・マージ・本番昇格の依頼ではない。

明示的な変更範囲は `wallet/injective/{retirement,records}.mjs`、暗号化Vaultの
retire遷移、所有者controller/UI、関連wallet試験、新規実ノード試験、README/計画。
既存laneの限定パスを黙って拡大せず、この共有Vault/API/UI変更は統合レビュー対象とする。
取引署名方式、初回送信経路、RPC許可先、依存、固定runtime、他チェーンは変更しない。

## 実ノードで再現した問題

固定済み公式Injectiveノードで、低い手数料の取引が事前simulateには通る一方、
初回送信ではHTTP500と `code=13 / insufficient fee` のメッセージで拒否された。
ウォレットはHTTPエラーを解析して成功/失敗を推測せず、書込み先行の
`broadcast-unknown` を保持した。口座sequenceと残高は消費されなかったが、旧版では
その未確定記録を削除せずに後続操作へ進む期限超過経路がなかった。

今回もHTTP500を確定拒否へ読み替えない。期限前にnot-foundが出ても終了させない。
失敗メッセージの文字列解析や、同じ署名の自動再送は導入しない。

## 終了できる条件

対象はローカル `injective-888` に対する、既存の順序付き・期限高付きの署名済み取引。
元状態は `broadcast-unknown`、`broadcast`、または高さなし・received:false・非零codeの
明示的 `CHECKTX_REJECTED` を持つ `reported-reverted` に限定する。収録済み成功/失敗や、
理由不明のreported-revertedは対象外。

所有者の確認前と実際の保存直前に、署名済みTxRaw/SignDocから期限・口座・sequenceを
再抽出し、(1) 期限高を厳密に超えた新鮮なブロック、(2) 保存履歴のチェーン継続性、
(3) 二回の厳密なnot-found応答、(4) 同じ口座identity/公開鍵/未消費sequence、
(5) 照合中のブロック不変を要求する。片方でも受信記録が出たら終了しない。
sequenceが進んだ場合は、検索APIが404でも拒否する。

確認は別の所有者操作で、復旧review SHAと旧tx hashの全文一致を必要とする。
状態・epoch・並行操作・有効期間を再検査し、Vault内でcompare-and-swapし暗号化保存する。
保存失敗ならロックして停止し、復旧時は実ディスクの記録だけを採用する。

## 未送信と送信試行済みを区別する

| 項目 | 既存INJ-07の未送信終了 | INJ-10の送信試行後終了 |
| --- | --- | --- |
| 終了状態 | `retired-unsent-expired` | `retired-submission-expired` |
| review schema | `realdex.injective-unsent-retirement-review.v1` | `realdex.injective-submission-expiry-review.v1` |
| 永続receipt schema | `realdex.injective-unsent-retirement.v1` | `realdex.injective-submission-expiry.v1` |
| neverSubmittedByWallet | true | **false** |
| submissionMayHaveOccurred | なし | **true** |
| originalState | signedとして束縛 | 元の送信試行状態を明示して束縛 |

旧署名・完全TxRaw・tx hash・所有者の元承認・直前の送信観測は変更しない。
古い署名はウォレットから送れず、新要求は別のIDと通常の所有者承認を必要とする。
新要求に同じsequenceを使う場合も、保存済み期限超過checkpointとチェーン継続性を
検証してから許可する。新しい取引を自動作成・署名・送信する機能ではない。

APIの既存 `non-evm/injective/recovery/prepare` と `/retire` を利用する。
UIは提出されたreceiptが元記録・tx hash・復旧種別・送信可能性フラグと一致するか確認する。
旧未送信ボタンは保持し、送信試行済みには異なる警告・ボタンを出す。
新状態を保存したVaultは旧版で拒否される。旧backup差替えによる解除は安全な移行ではない。

## 検証の範囲

単体試験は合成RPCと実暗号化Vaultを使う。実ノード試験は公式固定バイナリ、
使い捨て鍵と架空資金だけを使用する。実ノードでHTTP500の低手数料拒否、
正常費用の取引の送信境界切断、期限超過拒否、新しい承認での入金/出金、
収録済み取引の応答喪失とsequenceによる終了拒否を検査する。
送信境界を意図的に切る故障注入と、本当に送信したHTTP回数を別々に記録する。

```sh
node --test --test-reporter=tap wallet/test/injective-submission-expiry.test.mjs
REALDEX_INJECTIVE_DIRECTORY=/verified/runtime \
  node --test --test-reporter=tap integration/injective/OwnerSubmissionExpiry.test.mjs
python3 wallet/test/browser-injective-submission-expiry.py --output /new/dom-evidence
node app/ci.mjs --suite all --jobs 3 --output /new/source-evidence
```

初期の実ブラウザ→WalletServer接続は、管理ポリシーでERR_BLOCKED_BY_ADMINISTRATORとなった。
ポリシーは変更・迂回していない。DOM試験は実Chromium上の合成APIであり、実API/実ノード
試験との合算でブラウザE2E完了とは言わない。

## 限界

全条件は同じローカルノードの整合した観測に基づく。light client、独立quorum、
consensus finalityの証明ではない。悪意あるノード、全Vaultの巻戻し、深い再編、prune済み
履歴の移行はこの機能では解決しない。過去の実行不存在・資金返還・残高拘束の解除を
独立に証明したという意味ではなく、観測した期限と未消費sequenceを境に後続を
別承認するためのローカル運用機能である。`settlementVerified`、
`chainStateAuthenticated`、`automaticRetryAllowed` はすべてfalseのまま。
公開ネットワーク、本番資産、独立監査、OS鍵保護、製品完成を承認しない。

一次仕様との照合（実際の結果は同梱生ログを優先）:
- https://docs.cosmos.network/sdk/v0.50/learn/beginner/tx-lifecycle
- https://docs.cosmos.network/sdk/v0.53/learn/advanced/transactions
- https://docs.injective.network/defi/transactions
