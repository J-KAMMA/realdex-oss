# v0.13 仕様と試験ツールの出典

参照日: 2026-09-05。下記はプロトコルやツールの仕様の出典であり、RealDEXの安全性を認定するものではありません。RealDEXの実行結果は同梱ソースと別添試験記録を参照してください。

- Solana sendTransaction: https://solana.com/docs/rpc/http/sendtransaction — RPC受付の成功と実行・確定は別。
- Solana getLatestBlockhash: https://solana.com/docs/rpc/http/getlatestblockhash — blockhashと有効ブロック高。
- Solana getFeeForMessage: https://solana.com/docs/rpc/http/getfeeformessage — 署名対象メッセージに対する手数料観測。
- Solana getTransaction: https://solana.com/docs/rpc/http/gettransaction — 取引と実行メタデータ。
- Solana LiteSVM: https://solana.com/docs/tools/litesvm — validatorプロセスではなくin-processのVM。
- ICRC-1: https://github.com/dfinity/ICRC-1/blob/main/standards/ICRC-1/README.md — caller・引数の一致とcreated_at_timeを含む重複検出規則。台帳の実装が従うことまで今回検証したわけではない。
- ICP HTTP Interface: https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/ — ingress、署名、証明書の仕様。本版はICP送信・証明書検証を実装しない。
- Solders: https://github.com/kevinheavey/solders — 0.29.0、commit `87be4e8194a0dbda911057226b7f797a2ed21eec`、Actions run `31723563132`、artifact `9190506809`。

Solders wheelはテスト専用の別配布アーカイブを使用します。プロジェクト本体への新しい実行時依存ではありません。配布元のライセンス・メタデータは元wheelに含まれます。アーカイブ・wheel・読み込むパッケージ42ファイルのSHA-256を `integration/solana/toolchain-pin.json` に固定しています。
