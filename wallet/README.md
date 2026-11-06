# 現行追加: v0.22 IBCブリッジ

手順は [v0.22](../docs/v0.22/QUICKSTART-JA.md)。未監査・自設ローカルチェーン専用。以下は過去版の説明です。

---

# Current v0.16\n\n[手順](docs/v016/QUICKSTART-JA.md) / [報告](docs/v016/DEVELOPMENT-REPORT-JA.md) / [安全性](docs/v016/SECURITY-JA.md)。Stellar/Aptosはローカル送信コードと実署名の合成HTTP試験まで。実ノード適合・本番・独立監査は未達です。以下は履歴。\n\n---\n\n> v0.10: 本番前の不具合修正・合否判定の強化。未監査・実資産禁止。最新情報は [更新手順](docs/v010/QUICKSTART-JA.md) と [開発報告](docs/v010/DEVELOPMENT-REPORT-JA.md) を参照。以下は以前の仕様も含む記録です。

# RealDEX Wallet v0.9 統合開発版

**未監査・実資産禁止。** 所有者DEXフォーム、受取証の再照合、AIの読み取り専用preview、確認付きネットワーク設定置換を追加しました。共有ノードへ鍵や署名承認権を渡しません。非EVM送信・メインネット・実ブリッジを完成させた版ではありません。

```sh
node app/cli.mjs start
# ウォレットだけ／旧既定保存先を使う場合:
node wallet/cli.mjs start
```

[最新版手順](docs/v09/QUICKSTART-JA.md) / [報告](docs/v09/DEVELOPMENT-REPORT-JA.md) / [API](docs/v09/API.md) / [安全性と未達](docs/v09/SECURITY-JA.md)。

以下は過去版の記録です。v0.9の結果は `evidence/v09/test-results.json` を参照してください。

---

# RealDEX Wallet — v0.8.0-dev.20260905

**送金画面と制限付きAIウォレットの開発版。実資産を入れないでください。**

```sh
node wallet/cli.mjs start
```

共有ノードと別プロセスの、loopback専用の自己管理ウォレットです。通常起動とNodeテストにnpm installは不要。対応する一部EVMテスト／ローカルネットワークだけで署名・送信する設計です。実チェーン送信・実EVM・Windows・独立監査は未検証です。

- [v0.8 起動・送金・AI接続](docs/v08/QUICKSTART-JA.md)
- [v0.8 実装・検証報告](docs/v08/DEVELOPMENT-REPORT-JA.md)
- [権限境界・未解決リスク](docs/v08/SECURITY-JA.md)
- [APIとMCP](docs/v08/API.md)
- [検証記録](evidence/v08/test-results.json)

AIは秘密鍵ではなく、口座・チェーン・資産・受取先・予算・期限を固定した限定トークンで接続します。既定は毎回本人承認。明示的に許可した自動モードも、自動ロック・停止・取消しで無効になります。署名サービスが制約を検査しますが、同じOSの侵害を防ぐ仕組みやオンチェーン制限ではありません。

`node wallet/agent/demo.mjs` は一時ディレクトリと合成RPCだけを使うデモです。実チェーンでの送金成功を示しません。`node wallet/agent/mcp.mjs` はローカルstdio MCP入口です。秘密トークンは環境変数から渡し、所有者の起動URLやパスワードをAIへ渡さないでください。

ICP/Solanaは従来の鍵管理・オフライン署名コードまで。privacy wallet送信、AIのswap/bridge、x402、メインネット、BIP39、Tauriインストーラーは未追加です。164件の読み取り候補と送信対応を混同しないでください。

---
## 参考：v0.7の保存記録（以下は旧版）

# RealDEX Wallet — v0.7.0-dev.20260905

**開発・テスト専用の自己管理ウォレットです。実資産を入れないでください。第三者監査、実チェーンでの送信、Windows実機検証は未実施です。**

```sh
node wallet/cli.mjs start
```

ターミナルに表示する専用URLを、このPCのブラウザで開きます。共有ノードとは別プロセスです。通常起動・Nodeテストに追加のnpmパッケージ取得は不要です。同梱ライブラリのライセンスと出典は `vendor/` にあります。

- [日本語手順](docs/QUICKSTART-JA.md)
- [実装・検証報告](docs/DEVELOPMENT-REPORT-JA.md)
- [脅威モデルと未実装](docs/SECURITY-JA.md)
- [機械可読の試験記録](evidence/test-results.json)

EVM・ICP・Solanaの独立鍵を生成・取込・暗号化保存できます。BIP39/HDウォレットではなく、12/24単語での復元はありません。暗号化バックアップとパスワードが必要です。

UIからの署名・送信は、明示設定した一部EVMテスト/ローカルネットワークに限定します。ICP/Solanaは鍵管理とオフライン署名コードまでで、画面からの送信はありません。多チェーン読み取り候補164件と、ウォレット送信対応数を混同しないでください。

標準の `src/v01/V01App.tsx` は従来の公開制限を維持します。PC Wallet接続ボタンを追加したのは **`src/App.tsx` / `/experimental.html`** です。標準Base Sepolia用画面を内蔵署名で解放していません。
