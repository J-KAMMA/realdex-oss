# 一次資料とローカル証拠

Aptos試験ツール: aptos-labs/aptos-cli-releases、workflow run 32913942461、artifact 9588053995。archive・binary・core commitはintegration/aptos/pin.jsonで固定。実ノード応答例はevidence/v018のactual-simulation.json。公開テストアカウントとゼロ署名だけであり、利用者の鍵ではありません。

Aptos RPCとシミュレーションの実装: `https://raw.githubusercontent.com/aptos-labs/aptos-core/main/api/src/transactions.rs`

Stellar Payment/TransactionResult XDR: `https://raw.githubusercontent.com/stellar/stellar-xdr/master/Stellar-transaction.x`

JSONの相互運用性（重複メンバー・Unicode・数値範囲）: RFC 8259、`https://www.rfc-editor.org/info/rfc8259/`

Webの仕様資料は実チェーンでの適合・安全性を保証するものではありません。今回の実行結果は同梱ログと、再展開した配布物に対する外部検証JSONに分けています。
