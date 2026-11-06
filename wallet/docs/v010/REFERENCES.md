# v0.10 の参照元・固定値

取得確認日: 2026-09-05。リンク先の内容が将来変わる場合があります。固定値はコードに保持し、変更には再レビューを必要とします。

## Solidity

公式バイナリ一覧: https://binaries.soliditylang.org/linux-amd64/list.json

- version: 0.8.24+commit.e11b9ed9
- sha256: fb03a29a517452b9f12bcf459ef37d0a543765bb3bbc911e70a87d6a37c30d5f
- Linux x86-64 binary: solc-linux-amd64-v0.8.24+commit.e11b9ed9
- ファイルサイズの追加検査: 15,020,760バイト
- バイナリは本ZIPに同梱していない。今回の実行環境で実コンパイルは未実行。

コンパイラ設定・standard JSON: https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html

## GitHub Actions の固定コミット

- checkout v7: 3d3c42e5aac5ba805825da76410c181273ba90b1
  https://api.github.com/repos/actions/checkout/git/ref/tags/v7
- setup-node v7: 820762786026740c76f36085b0efc47a31fe5020
  https://api.github.com/repos/actions/setup-node/git/ref/tags/v7

公式GitHub APIでrefとコミットを照合。コードへ固定しただけでCI成功を確認したわけではない。

## その他

Node暗号API: https://nodejs.org/api/crypto.html
Playwrightブラウザと企業ポリシー: https://playwright.dev/python/docs/browsers

本版の保管庫・ロック・受信競合・保存障害の主張の根拠は、外部記事ではなく同梱ソースと試験ログ。公式ライブラリを使うだけでウォレット全体の監査済みを意味しない。
