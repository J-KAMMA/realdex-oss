# RealDEX Agent Wallet v0.8 — 実装・検証報告

日付：2026-09-05  
基準：添付 `RealDEX-Wallet-Preview-2026-09-05.zip`（v0.7、775ファイル）  
版：`0.8.0-dev.20260905`

## 結論と範囲

送金内容をサーバーで確定する人間用送金機能と、限定権限のAIウォレットを追加しました。ネイティブ通貨／設定済みERC20の残高・受取URI・送金確認、AI別の権限作成・自動／毎回承認・予算管理・二重実行防止・結果照合、Node SDK／stdio MCPが動作する実装です。

**動作検証先は合成RPCです。実EVM・実チェーンへ送信しておらず、実資産や本番利用の安全性を保証しません。** UI送金とAI送金は既存の一部EVMテスト／ローカルネットワーク制限を維持しました。全164候補やICP／Solana／privacy系の送信対応を意味しません。

追加の選択Node試験110件と、従来の1224件を合わせ、**1334件成功**を確認しています。内訳は今回のウォレット163件（旧53＋新110）と、既存ノード／選択release試験1171件です。プロジェクト全体の全テストではありません。

## 実装内容

| 部分 | 主なファイル | 内容 |
|---|---|---|
| 送金・受取 | wallet/lib/transfers.mjs | exact decimal→uint256、native/ERC20、資産別残高、厳格なERC-681サブセット |
| 受取証の扱い | wallet/lib/transfer-receipts.mjs | 取引成功とTransferイベントを区別。残高変化・最終性は常に未検証 |
| 権限と整数予算 | wallet/lib/agent-policy.mjs | 固定scope、上限、24h／累計集計、署名済みbytesとの復元照合 |
| AI実行制御 | wallet/lib/agents.mjs | owner確認、限定token、予約、冪等性、手動／自動、再照合、停止 |
| 原子的な履歴 | wallet/lib/vault.mjs | 署名、nonce、AI予算を同じ暗号化ファイルへ保存。旧payload読込を維持 |
| 境界と経路 | wallet/lib/server.mjs | owner、dapp、agent APIの分離。緊急停止とレート制限の分離 |
| 署名前チェック | wallet/lib/evm-engine.mjs | ERC20桁数・残高確認、既存true戻り値検査、署名・送信直前の権限検査 |
| AI接続 | wallet/agent/ | 型付きNode SDK、stdio MCP5ツール、合成デモ |
| 画面 | wallet/public/ | 専用口座、予算フォーム、2段階確認、限定token、全停止、履歴 |

未知の実行コードをAIが指定する経路は作っていません。既存コントラクト、src、root依存指定・lockfile、既存公開ゲートはv0.7から維持しています。Tauri／Windowsインストーラーではなく、Nodeサービスとローカルブラウザ画面です。

## 実行の流れ

所有者がバックアップ済み口座とネットワークを選び、限定権限を2段階で承認します。AIは限定tokenを持つローカルMCP／SDKを通じて、受取先・最小単位数量・固定依頼キーだけを渡します。

署名サービスは、送金額とガス上限の予約を永続化してからRPCで取引を確認します。手動モードは本人の承認を待ち、明示的な自動モードだけ先へ進みます。署名直前に権限・期限・ネットワーク・残高等を再確認し、署名、nonce予約、AIの消費額を一度の原子的保存で確定します。さらに送信直前の取消しを確認してからRPCへ送信します。

同じ依頼キーと内容は同一結果を返し、再署名・再送しません。キーの内容差し替えを拒否します。結果不明でも予算は使ったままです。AIのresult刷新は自分の取引だけを読み、送信しません。

## 検証結果

| 検証 | 結果・意味 |
|---|---|
| ウォレットNode試験 | 163件成功（従来53＋新規110） |
| 既存ノード＋選択release試験 | 1171件成功 |
| 選択Node合計 | 1334件、失敗0、取消0、skip0 |
| 予算モデル | 新規試験内で500固定seedケースを別の単純合計式と照合。別件数には加算しない |
| 既存暗号処理の独立照合 | Python cryptography/OpenSSLと独立wire parserで96ケース成功。独立Keccak照合はこの96ケースの対象外 |
| Node構文 | wallet内35個のmjsをnode --checkで確認 |
| TypeScript | provider／新SDKの利用例をTypeScript5.8.3のstrict条件で確認 |
| CLI | 実プロセス起動、所有者cap認証、二重writer拒否、終了・lock解放を確認 |
| MCP | 別stdio子プロセス→実loopbackHTTP→合成RPC、5ツール・入力制約を検証 |
| 画面 | 既存10＋新13＝23項目のオフラインDOM試験。実HTTP結合ではない |
| 合成デモ | 同じ支払いを2回要求して送信1回、上限超過拒否、使用額50を保持 |

新規110件の内訳：agent-policy44、agent-server42、agent-mcp19、transfer-receipts5。外部商用AIモデルを使った実験ではありません。SDKとMCPの呼び出しをプロトコル単位で試験しています。

Linux / Node22.16.0 / TypeScript5.8.3 / Chromium144.0.7559.96で測定しました。試験のruntime、ログ、独立確認、静的確認は `wallet/evidence/v08/` に保存します。暗号処理の追加独立監査をしたわけではありません。

## 重要な異常系

同一キー8並列要求、別キー同時の残予算超過、受取先・数量・ガス超過、桁数不一致、トークン残高不足、false戻り値、RPC不一致、期限切れ、取消し・全停止・ロックの競合、署名時のディスク障害、送信前の永続化失敗、結果不明、通常再解除での予算保持、復元時の全取消し、AI活動でauto-lockが延びないこと、別grantの履歴非公開、緊急停止の別rate枠を試験しました。

UIでは、所有者の明示文がなければ発行しないこと、manualからautoへの明示確認、token非永続・消去、停止中の遅延応答無効化、文字列のHTML化拒否、390px幅の横溢れなしを確認しました。

## 残る境界

**制限はローカルの署名サービス内のルールです。オンチェーンのsession key／スマートアカウント制限ではありません。** AIに同じOSで任意のshell・ファイル・画面権限を与えた場合や、所有者管理URLが漏れた場合には別の権限で迂回される危険があります。

予算は権限ごとの指定数量で、法定通貨・実際のtoken残高変化・実際の約定や決済日の支払上限ではありません。複数grantや所有者取引との全体予算、古いバックアップ以降の支払推定、token実装の安全性は別の課題です。署名済み取引はローカル権限取消しでは無効になりません。

5分の所有者無操作で止まるため、何日も完全無人で動かすサーバー型AI財布ではありません。再有効化には新しいtokenが必要です。agent権限最大32、依頼512、署名履歴1000という容量も制限しています。

## 実行できなかった検証

今回も `npm run build` を実行しましたが、react／ethers／vitest等の依存がないためTypeScript段階で終了コード1になりました。依存取得先のDNS解決も利用できません。rootの指定Node24系環境での全体ビルド成功を主張しません。生成されたtsbuildinfoは試行前の状態へ戻しています。

通常のブラウザHTTPアクセスは `ERR_BLOCKED_BY_ADMINISTRATOR` で遮断されました。ネットワーク方針を迂回していません。ブラウザ画面は合成APIを注入するオフラインDOM試験であり、実サービスのレスポンスを代理転送した試験でもありません。CSP/CORS/実ブラウザ暗号・HTTP結合は未確認です。

実EVM、実ノードの受入・送信、実資産、実チェーン再編・最終性、Windows実機・複数PC、商用AIアプリ、ハードウェア署名、第三者監査、新ブリッジ／プライバシー送金、x402決済は未検証または未実装です。以前のICP／Solanaのオフライン署名を送信対応へ昇格させていません。

## 再現

```sh
node wallet/test/run.mjs
node node/test/run-tests.mjs --with-release
node wallet/test/cli-smoke.mjs
node wallet/agent/demo.mjs
node wallet/test/independent-vectors.mjs > /tmp/realdex-wallet-vectors.json
python wallet/test/independent-verify.py /tmp/realdex-wallet-vectors.json
```

独立照合のPython環境、画面試験のPlaywright/Chromiumは別途必要です。配布ZIP再展開試験の結果・最終SHA256はZIP外の `RealDEX-Agent-Wallet-Package-Verification-2026-09-05.json` に記録します。ZIP内のログはパッケージ作成前の検証記録です。マニフェストは `FILES.sha256` です。

## 次に満たす条件

正規依存環境でのReact統合ビルドとブラウザHTTP試験、使い捨て鍵での実EVM→公開テストネット試験、RPC改ざん・token実装・nonce復旧の独立レビューを優先します。無制限自動化やメインネット解除を先に行う設計ではありません。
