# v0.18 API差分

既存の所有者API、要求・署名記録のスキーマ、保管庫の暗号化方式は維持しています。新しいネットワーク送信APIやAIツールは追加していません。

## Aptosの応答互換性

`transactions/simulate` の要素だけは `type` の省略を許容します。提供されていれば `user_transaction` でなければ拒否します。収録取引のGET応答は必ず `user_transaction` を要求し、省略を許可しません。関数、引数、from/to、sequence、期限、ガス上限、署名などの既存検査は維持します。

RPCから返されるアカウントアドレスと認証鍵の短縮表現は、`0x`＋1～64桁のhexとして32バイトへ正規化します。ユーザー入力や保存する送金内容のアドレスの要件は緩和しません。

`success: true` は `vm_status: "Executed successfully"` と一致する必要があります。矛盾した成功・失敗、first_version > last_version、観測済みブロックのversion範囲・時刻の変化を拒否します。

## 共通REST

パス・HTTPメソッド・queryを用途別に限定します。未知query、重複パラメータ、自動ガス変更要求、範囲外snapshot、取引照合以外での404許容を拒否します。GETルートに追加した任意パラメータを署名サービスの便宜的オプションとして扱いません。

JSONは524,288バイト以内、深さ32・ノード数20,000の制限内とし、重複メンバー・不正UTF-8・孤立サロゲート・危険なキー・unsafeな裸の数値・小数・負のゼロを拒否します。対応APIの大きな金額・versionは文字列で扱います。これらの制約により未対応の応答形式が止まることがありますが、黙って精度を落としません。

Aptosの成功HTTP応答は `x-aptos-chain-id: 4` と正規の `x-aptos-ledger-version` が必要です。履歴versionを要求するときは、報告された最新versionより先を読まず、oldest-versionヘッダーがあれば削除済み範囲を読まないことを確認します。このヘッダー検査は状態証明ではありません。

## Stellar結果

一つの通常Paymentの実行結果だけをXDRで解析します。手数料、txSUCCESS/txFAILED、操作数1、PAYMENTの結果コードまたは対応する汎用操作エラー、拡張0、バイト末尾が一致する必要があります。成功フラグとの矛盾、未知コード、余分なバイト、切れた結果は拒否します。現在の送信元sequenceが取引sequence未満の場合も確認済みにしません。

主な検査エラーは `ACCOUNT_RPC_JSON_INVALID`、`ACCOUNT_RPC_QUERY_FORBIDDEN`、`APTOS_RPC_HEADER_CHAIN_MISMATCH`、`APTOS_RPC_HEADER_BEHIND_SNAPSHOT`、`APTOS_RPC_SNAPSHOT_PRUNED`、`APTOS_RESULT_STATUS_MISMATCH`、`STELLAR_RESULT_XDR_INVALID` です。アダプターのエラーは上位の履歴再照合で未解決の観測として扱われます。受取結果は従来通り `finalityProven: false` です。

## 検証用CLI

`REALDEX_APTOS_BINARY` と `node app/verify.mjs --aptos --output NEW_DIRECTORY` を追加しました。正しい固定バイナリがない場合は未実行とし、合成試験から実ノード成功を推定しません。`--full` にも同じAptos実行を含みますが、Stellar Coreなど他の未達条件は維持します。通常起動時にこの環境変数やバイナリは不要です。

## JSON数値の受入条件

Stellar/Aptos共通RESTでは、非引用のJSON数値を原文から検査し、安全な整数表記だけを受け付けます。小数・指数表記は、変換後が整数でも拒否します。これはJSON全般の文法ではなく、このクライアントの受入条件です。引用されたuint64、残高、小数文字列は保存された表記のまま系統別に検査します。`1.0000000000000001`→`1`、`1e-9999`→`0`という丸めを許しません。
