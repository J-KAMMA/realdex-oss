# RealDEX 検証付き交換ラボ — 起動・再現手順

## この版でできること

個人PCで候補発見ノードを起動し、明示した発信者の署名付きFactory候補を、利用者が選んだRPC群で同じブロックに固定して照合する。Poolの準備高と見積り、既存承認と参考ガス、費用不足、ガス等を除外した分割案を表示できる。

**読み取り専用。ウォレット接続・承認・署名・送信・追加のブリッジ実行はできない。** 元の限定取引版は維持しているが、今回それを実チェーンで動作確認したわけではない。

## 必要な環境

追加ノード層はNode 22.16.0以上を想定し、22.16.0/Linuxで試験した。通常起動にnpm installは不要。元のReact/Hardhatアプリをbuildする場合はroot package.jsonの別環境・依存関係が必要。

ZIPを展開して、README.mdとnodeフォルダがあるリポジトリルートをターミナルで開く。

## 1. 自分のノードを作る

```sh
node node/cli.mjs init --directory .realdex/my-node --port 8787
node node/cli.mjs start --config .realdex/my-node/config.json
```

既存ディレクトリは上書きしない。すでに初期化済みならstartだけを使う。終了はCtrl+C。

ノード画面：`http://127.0.0.1:8787/node/`

**追加交換ラボ：`http://127.0.0.1:8787/node/exchange/`**

起動出力に公開鍵とexchangeLab URLが表示される。公開鍵の再確認は次の通り。

```sh
node node/cli.mjs identity --config .realdex/my-node/config.json
```

identity.jsonはノードの情報署名用であり、ウォレットではない。秘密鍵・シード・資金署名権をノード設定やラボに入れない。

## 2. Factory候補を設定する

ノードを停止してconfig.jsonの `catalogue.factories` を編集する。使用するFactoryは、対象チェーンに自分が確認したアドレスを指定する。以下は構造例であり、このまま実行する実在の候補ではない。

```json
{
  "revision": 2,
  "factories": [
    {
      "chainId": "eip155:84532",
      "address": "0x<確認したFactoryアドレス40桁・小文字>",
      "protocol": "realdex-cpmm-v1"
    }
  ]
}
```

実際のaddressは`0x`＋小文字16進数40桁。配列は`chainId/address`順、重複不可、1発信者あたり最大16件。内容を変えたらrevisionを増やす。同じrevisionの別内容は拒否される。再起動後に候補が発信される。

新規ノードの候補は空であり、実在のプールやデプロイを勝手に同梱・作成しない。

## 3. ラボで照合する

このノードの公開鍵をCLI出力と照合して入力する。受け入れる元発信者を空欄にすると、このノード自身の発信だけを許可する。中継された候補も使う場合は、元発信者の公開鍵を別途確認して入力する。

RPCは自分で選ぶ。HTTPS、または同じPCのHTTP loopbackが対象。異なるURLであっても運営者が独立している保証はなく、利用者が判断する。ブラウザからのCORSに対応し、EIP-1898を扱える必要がある。APIキー付きURLを第三者へ送ったり、スクリーンショットへ含めたりしない。

チェーンID、探索料率、token contract、入力額、スリッページを入力する。**入力額は最小単位の整数**であり、シンボル・価格・decimalsを推測しない。例として、小数6桁のトークン1枚は1000000。これはあくまで桁数を知っている場合の例である。

「署名とチェーン上の情報を検証」を押す。別チェーン・古いblock・RPC不一致・非対応RPC・期限切れなどは停止する。入力変更、中止、画面を離れる操作、観測の失効により古い結果を破棄する。

結果に表示されるPoolは、runtime全体や生成由来まで同定した認証済みPoolではない。実行可能フラグは常にfalse。追加費用が揃わないため、既定では実質最良の自動選択をしない。

## 4. ガスと分割を調べる

自分の公開アドレスを入力して再検証した場合に限り、「既存承認とガスを確認」を使える。残高・既存allowanceが足りない場合は停止し、承認取引を作らない。eth_callの戻り値やgas見積りは、実際の受取残高や将来の費用を保証しない。

「この準備高で分割案を計算」は、観測した1〜8Pool、最大128刻み・4分割というライブラリ上限の範囲で計算する。画面では入力額を整数分割できる100以下の刻みを選び、その条件を明示する。ネットワーク費用は除外され、現行Routerへ送れる取引ではない。

## 5. CLIで同じ読み取りを再現する

`node/examples/readonly-request.example.json`を自分の作業場所へコピーし、プレースホルダーを実際に確認した公開鍵・RPC・tokenに置換する。`amountIn`はJSONでも文字列、`account`は不要ならnull。

```sh
node node/verify.mjs --config my-readonly-request.json --output my-new-report.json
```

既存の出力ファイルは上書きしない。RPCの秘密トークンを含む設定ファイルを公開しない。レポートにRPCのpath/queryは保持しないが、Pool/Token/任意指定した公開アドレスは含まれる。

終了コード0＝候補観測完了・送信不可、3＝照合できたPoolなし、1＝設定/読み取り失敗。0でも実行許可ではない。設定で任意のruntime hashを指定して検査を迂回することはできない。

## 6. ネットワークなしで再現する

```sh
node node/test/run-tests.mjs --with-release
node node/test/verified-demo.mjs
node node/demo.mjs
```

最初は353件の試験（ノード347＋既存release計画6）。二番目は合成RPCモデルによるPool/ガス/分割デモであり、実EVMではない。三番目は同じPC内の実HTTPによる3ノード中継と既存の計算デモ。

追加部分だけの試験：

```sh
node node/test/run-tests.mjs --verified-only
```

このrunnerはシェルのワイルドカード展開を使わない。ただしWindows実機試験は未実施。

## PC同士の接続

前回版の `node/README.md` にある明示的なpeer URL/公開鍵設定を使う。今回NAT越え・自動発見・relayは追加していない。別PCへ公開する場合のHTTPS、ファイアウォール、アクセス制御、稼働責任を自動設定しない。loopback以外で待ち受けるには既存の `--allow-network` 明示指定が必要。

## 調査時の注意

`FACTORY_CODE_MISMATCH` はこの版の固定コードidentityと異なることを意味する。通過させるためにhashを適当な値へ変更しない。`APPROVAL_REQUIRED_NO_TRANSACTION_SENT` は既存承認不足を意味し、このラボが承認を作ることはない。費用の「未確定」は0円の意味ではない。

ブラウザQAの画像は合成試験。今回の環境では管理ポリシーによりブラウザHTTPが遮断されたため、オフラインDOM試験であり、実ブラウザHTTP/CSP/native WebCryptoや実チェーンでの成功証拠ではない。

詳細：`docs/REALDEX_VERIFIED_DISCOVERY_2026-09-05.md`
