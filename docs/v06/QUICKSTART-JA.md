# RealDEX v0.6 — ICP / Privacy / Private Networks

## 目的と到達範囲

v0.5へICPの台帳読み取り、Monero等の公開ブロック照合、私設ネットワーク設定、プライバシー条件による交換候補の事前選別を追加しました。
**追加層は読み取り専用です。ICP用Pool/Factoryのデプロイ、秘密残高のスキャン、スワップ・ブリッジの送信は実装していません。**
既存のEVM契約・ウォレット実行UI・リリース制限はそのまま保持しています。

## 起動

Node.js 22.16.0を使ってLinuxで確認しました。追加層の通常起動に`npm install`は不要です。
ZIPを展開し、`package.json`のあるリポジトリのルートから実行します。

```sh
node node/cli.mjs init --directory .realdex/my-node --port 8787
node node/cli.mjs start --config .realdex/my-node/config.json
```

設定をすでに作成してある場合、`init`は行わず`start`だけを使います。
画面: `http://127.0.0.1:8787/node/privacy/`

追加ノードはmonerod・Zebra・ICPレプリカ・Rosetta・CometBFTを起動しません。
それぞれのクライアントを利用者が起動・同期し、読み取り先として指定してください。
Windows実機の検証は未実施です。上のNodeコマンドはシェル固有のglob等を使っていません。

## ICPのメタデータを読む

画面の作業を「ICP / ICRCメタデータ照合」に変更し、台帳を選択します。
名前・記号・桁数・転送手数料・対応規格を二度読みます。複数接続先を指定した場合は全接続先で一致する必要があります。
**同じ値を二度取得しても暗号学的な証明にはなりません。**

同梱9候補はICP、ckBTC、ckETH、ckUSDC、ckUSDT、ckDOGE、ckSOL、ckTestBTC、ckTestETHです。
後二つは元資産がテストチェーン上の資産であり、台帳canister自体はICPメインネット上にあります。
候補は公式資料に基づく識別子で、今回実ネットワークで照合したものではありません。[出典1・2]
任意のICRC台帳もcanister IDを指定して読み取れますが、実装の完全なICRC適合性は検査しません。

ローカル開発環境の例:

```sh
node node/privacy.mjs icrc --input node/examples/privacy/icrc-local.json
```

この例の台帳IDは自分の開発環境のIDへ変更してください。
公開入口へ接続する例は`icrc-explicit-remote.json`です。実行すると外部への問い合わせになります。

```sh
node node/privacy.mjs icrc --input node/examples/privacy/icrc-explicit-remote.json
```

取得結果の`certifiedLedgerState`、`responseSignatureVerified`、`rootTrustVerified`はfalseです。
`/status`から取得した鍵を本番の信頼鍵として採用する処理はありません。[出典3]
CLI/画面は口座残高を問い合わせません。ライブラリの`icrc1_balance_of`は別途`allowAccountQuery: true`を指定したときだけ利用できます。
これも未認証のquery読み取りであり、任意口座の残高が秘密になる機能ではありません。

## Monero・Zcash等のネットワークを読む

```sh
node node/privacy.mjs list
node node/privacy.mjs probe --input node/examples/privacy/monero-local.json
```

JSON中の`REPLACE_WITH_...`を、独立に確認した初期ブロックハッシュへ置き換えます。
Moneroの接続先は例として`http://127.0.0.1:18081/json_rpc`です。財布用のwallet-rpcではありません。[出典4]
Zcashでは例として`http://127.0.0.1:8232`を使います。[出典5]
Secret/Namada/Penumbraでは`identityAnchor: {height,hash}`で既知のチェックポイントを指定します。
ICP Rosettaの場合は、指定した台帳の初期ブロックのハッシュです。

読み取り先は1〜4件です。1件の結果を「複数ノード一致」とは表示しません。
既定ではリテラルの`127.0.0.1`または`[::1]`のみ接続します。`localhost`の外部解決を避けるため、その文字列は既定の許可対象にしません。
外部HTTPS接続は、画面のチェックボックス、またはJSONの正確な`allowedOrigins`で許可したものだけです。
DNSや接続失敗時の公開RPCへの自動フォールバックはありません。HTTPの外部アドレスは許可しません。
Tor/I2P/SOCKSの統合、匿名性の検証、LANファイアウォール構成は実装していません。

## 認証付きRPC

CLIのendpointは`{"url":"http://127.0.0.1:8232","authEnv":"REALDEX_ZCASH_AUTHORIZATION"}`の形式です。
ローカル環境変数には、RPCの仕様に応じたAuthorizationヘッダー全体を設定します。
例としてBasic認証のヘッダーは`Basic <base64(user:password)>`です。ここに秘密値の実例は記載しません。
ヘッダーはメモリ上でリクエストにだけ付け、CLI結果へは出しません。
Digestの自動チャレンジ応答、cookie自動読込、APIキー管理UIは未実装です。
他人が使えるネットワークへRPCを無認証で公開しないでください。

## 私設EVM / 私設CometBFTの設定

例のJSONをコピーし、実際のチェーンIDと独立確認したハッシュへ変更してから実行します。

```sh
node node/privacy.mjs private-evm --input node/examples/privacy/private-evm-spec.json --output my-private-evm.json
node node/privacy.mjs private-comet --input node/examples/privacy/private-comet-spec.json --output my-private-comet.json
```

出力済みファイルは上書きしません。POSIX上では0600で新規作成します。WindowsのACL保証ではありません。
作成したファイルは画面の「私設ネットワーク設定を追加」から、この画面のメモリ上にだけ読み込めます。
ファイルをサーバーへアップロードせず、ブラウザストレージへ保存せず、他ノードへ配信しません。再読込で消えます。
CLIでは`probe --registry my-private-evm.json --input 自分の要求.json`と指定します。
`networkId`は生成した`private-evm:my-lab`等です。公開チェーンと同じ数値IDでも別名前空間で扱います。

**許可制は、参加者から取引が見えないことを意味しません。** RealDEXは参加許可の設定、validator作成、暗号化、アクセス制御の監査を代行していません。[出典6]

## 通信しないモデルを試す

```sh
node node/privacy.mjs quote-icrc --input node/examples/privacy/icrc-pool-model.json
node node/privacy.mjs screen-routes --input node/examples/privacy/route-claims-model.json
```

前者は入力・出力双方のICRC転送手数料を考慮したCPMM計算です。準備高・費用は合成値です。
後者は候補の申告データを検査し、公開アドレス/金額への露出や不明な費用を排除します。
結果は常に`executable: false`です。実市場の最良経路や実際のプライバシーを証明しません。

## 試験の再現

```sh
node node/test/run-tests.mjs --with-release
python node/test/v06-independent-vectors.py
```

TypeScriptがある環境の公開API利用例チェック:

```sh
tsc --project node/test/tsconfig.v06.json
```

Python PlaywrightとChromiumがある場合の補助的な画面試験:

```sh
python node/test/v06-browser-offline.py --output browser-v06
```

Node試験は合成応答・ループバックHTTP・オフラインモデルを使います。
画面試験も合成応答です。実チェーン、実資金、ICP証明書、秘密取引の有効性を検証する試験ではありません。

## 出典

1. ICP Ledgers: https://docs.internetcomputer.org/guides/digital-assets/ledgers/
2. Chain-key canister IDs: https://docs.internetcomputer.org/references/chain-key-canister-ids/
3. HTTPS interface / root trust: https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/
4. Monero daemon RPC: https://docs.getmonero.org/rpc-library/monerod-rpc/
5. Zebra/lightwalletd: https://zebra.zfnd.org/user/lightwalletd.html
6. Besu permissioning: https://docs.besu-eth.org/private-networks/concepts/permissioning
7. ICP Rosetta: https://docs.internetcomputer.org/guides/digital-assets/rosetta/
