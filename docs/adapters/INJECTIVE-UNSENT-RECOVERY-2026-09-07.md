# INJ-07 — 未送信・期限高超過取引の所有者確認付き終了

## 基点と目的

INJ-06 commit `16ab780aaa2e4d9b8fd2258321a8c57a3fdee348` /
tree `3983a9bf4ff9cd9f8c43d61226cc0f874eb6b44a` からのローカル開発。
GitHubの読書き・PR・CI待ちは行わない。別配布CI-03は今回統合しない。
注文・取消・自己出金が、署名後の期限切れや対象消滅で進めなくなる場合に、
古い署名を再送せず、新しい所有者確認へ進める限定的な復旧を提供する。

## 終了できるもの、できないもの

終了対象はこのウォレットで一度も送信開始していない `signed` 記録だけ。
`broadcast`、`broadcast-unknown`、収録済み、CheckTx拒否済みの記録はこの経路で終了しない。
保存後に送信していない可能性があるunknownも、未送信だと推測して扱わない。
これらは既存の正確な取引ハッシュによる収録照合を続ける。

reviewの時刻期限切れ、取消対象の消滅、口座sequence変更、404のいずれかだけでは不十分。
SIGNED TxRaw内のTxBodyの非ゼロtimeoutHeightを読み取り、SignDocのbody/auth、chain ID、
account number、AuthInfoのsequenceと表示条件を突き合わせる。
最新のノード観測高が **timeoutHeightを厳密に超えた場合のみ** 次へ進む。
等しい高さでは終了しない。これは取引が今後有効でなくなる条件を確認する処理であり、
過去の約定や資金返還を証明する処理ではない。

## 2段階のowner-only API

1. `POST /api/non-evm/injective/recovery/prepare`、body: `{ "id": "保存済み記録ID" }`
   は読取専用。暗号化ファイル・履歴・署名・送信状態を変更しない。
2. `POST /api/non-evm/injective/recovery/retire` は `id`、返された`review`、
   `confirmation` (= review.reviewSha256の全文)、`transactionHash` (= 旧tx hash全文)を要求する。
   現在の記録と確認書の結び付き、確認期限、同じノードの状態をもう一度検査してから保存する。

既存WalletServerの所有者認証・Origin検査・並行操作排他の下でのみ利用できる。
別のネットワーク接続先、account、再送命令、削除命令、秘密鍵は受け付けない。
公開testnet/mainnetには接続できず、既存の127.0.0.1 / injective-888境界を維持する。

確認書は30秒以内、かつ観測ブロック時刻から30秒以内の期限付き。
確認中にVaultのlock/epoch変更、記録変更、別の送信開始、確認期限切れが起きた場合は保存しない。
保存直前のCAS比較・承認再検査を行い、保存失敗はVaultをロックする。
書込みが成功してからエラーになった場合、ディスクには終了状態がある場合もある。
その場合も失敗を取り消したと決め付けず、再起動後の暗号化ファイルを確認する。

## 同じノードで照合する条件

最新のchain ID・height・block ID hash・timeを取得する。旧署名のhashの照会は2回行い、
明示されたgRPC NotFound(code 5)構造の404だけを認識する。
HTTP 5xx、HTMLの404、壊れたJSON、欠落・衝突するheightメタデータは失敗する。
収録結果が見つかった場合は終了せず、既存reconcileを促す。

同じ高さのEthAccountを照会し、元の所有者・account number・sequence・公開鍵を要求する。
sequenceが進んでいれば「未実行」とは推測しない。同じ高さのブロックを再取得し、
block ID hash・height・timeの一致も要求する。

実RESTの`block`と`sdk_block`ではproposer_addressの表現が異なる場合がある。
この境界で比較するchain ID・height・timeは一致が必須で、外側のblock ID hashも照合する。
使用していない提案者の表現差を同じブロックの不一致として扱わない。
これはblock hashを再計算したり、validator署名を検証したりする処理ではない。

## 保存・再利用・rollbackへの扱い

新状態は `retired-unsent-expired`。元の記録ID・request key・署名・完全TxRaw・summaryと
既存の観測reportを保持し、所有者が確認した復旧書と保存時の再照合証拠を追記する。
削除、件数のリセット、自動再署名、自動再送はしない。元の取引を再送するAPIは拒否する。

別request keyで新しい条件を取得し、別の所有者承認を行った場合のみ、新規署名へ進める。
同じsequenceの先行記録がすべてこの終了状態であり、新reviewのanchorが保存した期限超過の
観測高以降でなければ、そのsequenceを再利用できない。旧request keyや旧tx hashは再利用しない。
同じaccountの未確定取引が1つでも残れば、既存の新規署名禁止が引き続き働く。

さらに新しい署名と初回送信の直前に、最も新しい終了証拠のブロックを同じendpointから再取得する。
高さの後退・保存したblock hash/timeの変化・endpoint差替えは拒否する。
履歴読込時にも終了証拠と同一sequenceの再利用条件を検査するため、再起動で制限を忘れない。

Vault全体の旧バックアップへの巻戻し、悪意ある同じノード、同一chain IDでの外部チェーンリセット、
管理者によるファイル改変に対する独立証明ではない。単一ローカルノードを信頼する従来の診断境界を
超えない。最新のVaultを保護し、この機能使用後のVaultを旧版で開かないこと。
旧版は新しい履歴状態を理解できず拒否する。外側の暗号化schemaやKDFは変更していない。

## ユーザー画面

signed記録だけに「未送信取引の期限・復旧条件を確認」を表示する。
旧timeout、照合した高さ、旧hash、復旧書SHAを確認し、SHAとhashを全文再入力してから終了する。
終了後も履歴・署名の識別子は残り、旧取引の送信・再照合・再終了ボタンは表示しない。
資金返還や注文取消が成立したと誤解させない注意文を表示する。
unknown記録にはこの操作を表示せず、既存の収録再照合を維持する。

## 試験と範囲

```sh
node --test --test-reporter=tap wallet/test/injective-retirement.test.mjs
REALDEX_INJECTIVE_DIRECTORY=/verified/local/runtime \
  node --test --test-reporter=tap integration/injective/OwnerRecovery.test.mjs
python wallet/test/browser-injective-retirement.py --output /new/browser-evidence
node app/ci.mjs --suite all --jobs 3 --output /new/source-evidence
```

実ノード試験は、新規署名したが未送信の注文、相手に全量約定され取消対象を失った取消、
未送信の自己出金を扱う。それぞれtimeoutHeight超過後の復旧を実施する。
診断専用コードが旧TxRawを実ノードへ1回だけ提示してtimeout拒否を確かめるが、
ウォレットの再送機能ではなく公開ネットワークへも接続しない。
新しいowner APIによる注文・出金は別途承認して初回1回のみ送信する。
再起動・子プロセス復元・保存失敗前後・不正確認・記録競合・rollbackも試験する。
ブラウザ試験は合成API応答によるDOM操作であり、実ブラウザから実チェーンまでの一括認定ではない。

## 未実装・未認定

送信結果不明取引の一般的な廃棄、独立した非収録証明、公開testnet/mainnet、外部signer/OS鍵隔離、
Windows、全体受入、独立監査、本番配布署名はこの変更で完了しない。
履歴64件上限は維持する。終了したことによる自動資金解放・返金・決済確認はない。
`productionReady`をtrueにせず、GitHubへも公開しない。

仕様根拠: Cosmos SDK TxTimeoutHeightDecoratorは、非ゼロtimeoutHeightより現在高が大きい時に拒否する。
今回この条件は固定済みInjective実ノードにも旧署名を提示して検査する。
https://pkg.go.dev/github.com/cosmos/cosmos-sdk/x/auth/ante#TxTimeoutHeightDecorator
