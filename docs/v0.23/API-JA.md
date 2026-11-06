# v0.23 IBC自動追跡 API

既存の所有者用HTTP認証（同一origin・Bearerの所有者キー・POST・application/json）を必須とする。dappの`/bridge/`、AIの`/agent/v1/`には追加しない。秘密鍵を引数にしない。

| API | 本文 | 結果 |
|---|---|---|
| `POST /api/ibc/track` | `{"id":"保存済みレコードUUID"}` | 自動検出後、既存形式の取引履歴レコードを返す |
| `POST /api/ibc/monitor/start` | `{"ids":["UUID"],"intervalMs":30000}` | 最大16件。intervalMs省略時30000。署名のみの未送信レコードは拒否 |
| `POST /api/ibc/monitor/status` | `{}` | 実行状態、対象履歴、次回時刻、最後の試行、回数、エラー |
| `POST /api/ibc/monitor/stop` | `{}` | メモリ上の追跡許可を失効。所有者HTTP認証は必要。ロック中も利用可能 |

`monitor/start`は対象一覧を置き換える。停止した読取りがまだ終了していない場合、新しい開始は`IBC_MONITOR_DRAINING`。解除前には開始不可。開始操作も自動ロック時間を延長しない。

monitor statusには、`readOnly:true`、`signingAuthority:false`、`relayTransactions:false`、`requiresUnlockedVault:true`、`autoResume:false`を含める。「readOnly」はチェーンに対する意味で、検査した観測結果のローカル暗号化保存は行う。

既存の `POST /api/ibc/reconcile` は手動ハッシュ入力の経路として維持する。`track`にはquery、endpoint、signature、broadcast等を受け付けない。

## 発見から検査まで

経路・署名済み元取引を照合してpacket identityを得る。固定したチェックポイントから観測した高さまでの範囲に限定して、受取側の`recv_packet`、元チェーンの`acknowledge_packet` / `timeout_packet`を`tx_search`する。

検索式はport、source/destination channel、sequence、固定高さから内部生成する。1ページ20件、最大4ページ、種類ごとに最大80件。範囲外・重複・欠落・不正整数・順序不正・途中の総数変化・異なるRPCの結果を拒否。候補が複数なら先着順で選ばない。

検索結果は候補だけ。各候補を既存の取引本体・包含・実行結果・packet・ACK commitment・受取/返金差分の検査へ渡し、通過後に参照ハッシュを保存する。失敗した未検証候補を保存し続けて後続検索を妨げない。

`IBC_INDEX_UNAVAILABLE`は、検索APIの不使用・索引停止などを含む。経路が安全、未受取、返金完了だという意味ではない。手動再照合を使う場合も、既存の検査条件を省略しない。

## 取消し・競合

停止は処理中の読取り結果の保存許可も失効させる。Vaultの直列保存キューに入った後でも、保存直前に許可を再検査する。ロック・設定変更・終了では全対象を消去する。別操作で履歴が更新された場合はcompare-and-swapにより古い観測で上書きしない。

停止前から本文受信中、または履歴読取り待ちだった開始要求も、`IBC_MONITOR_START_INVALIDATED`で拒否する。停止直後に古い開始要求が追跡を再有効化しない。

日付・時刻が逆行すると停止する。失敗時は間隔を広げる。確認済み履歴も継続して再照合し、古い成功状態を永久に固定しない。
