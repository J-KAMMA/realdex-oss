# RealDEX v0.5 — マルチチェーン実装・検証報告

日付：2026-09-05  
追加Node層：`0.5.0-dev.20260905`  
入力：`RealDEX-Verified-Discovery-Preview-2026-09-05.zip`  
入力SHA-256：`85e203c6aa519a412ae093cc0b4a2b53dd78a529633df5fa1f78e7c488f6fbe6`

## 1. 結論

「作れるチェーンは全部」を、RealDEXが既存チェーンへ接続する範囲を広げる依頼として実装しました。新しいコンセンサスネットワークを立ち上げたわけではありません。

**今回の到達点は、138候補・15系統の独立した読み取り実装、任意EVM設定とカタログ取り込み、EVM89候補の契約配置計画です。全候補で実際にスワップ・ブリッジできる状態ではありません。**

新しいNode試験451件を含む選択試験804件が成功しました。15系統それぞれで実HTTP通信も試験しましたが、相手はプロトコル形式を模したローカルサーバーです。実チェーンの正しい実行・プール・価格を証明する試験ではありません。

今回も元の送信画面、コントラクト、承認フロー、リリースゲートは変更していません。未知のチェーンや設定を足しただけで資産移転が許可されることはありません。

## 2. 機能と対応段階

| 機能 | 今回の状態 |
|---|---|
| ネットワーク候補 | 138件。同梱JSON・CSV・Markdownに列挙。稼働確認済みではない |
| EVM系読み取り | 共通実装＋89候補。正のuint256 chainIdを文字列で追加可能 |
| 非EVM系読み取り | 14系統・49候補。EVM RPCへ誤変換せず専用APIで処理 |
| 公開EVM一覧の取り込み | ローカルJSON入力、最大20,000件。10,000合成件で試験 |
| 同一状態照合 | 利用者指定2〜4RPC、同じ高さ・hash・識別値を比較し、再読みによる変化を検査 |
| 複数チェーン処理 | 明示ジョブ最大256、既定2並列、上限4並列 |
| 資産識別 | チェーンを含む構文上のキーを生成。銘柄名だけで同一資産とみなさない |
| EVM契約の準備 | 89候補の配置計画と1個の標準コンパイラ入力を生成 |
| コンパイラ出力の確認 | ローカルJSONの構造・設定・ソースhash等の検査。実コンパイル未確認 |
| 新画面 | 日本語の候補検索・照合・中止・結果失効。秘密鍵／ウォレットAPIなし |
| 新規の実取引／ブリッジ | **なし** |

全候補で `liveNetworkTested`、`poolDeploymentVerified`、`swapsExecutable`、`bridgesExecutable`、`walletSigning` はfalseです。登録済みという情報を実行権限に転用しません。

候補数にはmainnet・testnet・localが混在します。古い・停止・改称されたネットワークが含まれる可能性があります。`source` はメタデータの確認先であって、そのネットワークへ接続して検証した証拠ではありません。任意のEVM IDを扱えることは、すべてのEVM互換VMでコンパイル・デプロイ・取引が成功するという意味ではありません。

## 3. 15系統の実装内容

| 系統 | 候補数 | 実装した読み取り | 個別の注意 |
|---|---:|---|---|
| EVM | 89 | chainId、genesis、指定ブロック | 最新ブロックからの深さはコンセンサス証明ではない |
| Solana | 3 | genesis、finalized slot、指定slotのblock | genesis固定必須。欠落・剪定slotを別slotへ置換しない |
| Cosmos / CometBFT | 15 | status、network、指定heightのblock | SDK RESTではない。validator署名の検証は未実装 |
| Aptos | 2 | chainId、block height、block hash | APIルート `/v1`。時刻のµsをmsへ正規化 |
| Sui | 2 | GraphQL chainIdentifier、checkpoint | short hex／full Base58識別子を処理。gRPC自体は未実装 |
| NEAR | 2 | network、final block、指定height | finalというRPCの申告であり、独立証明ではない |
| Bitcoin | 5 | Core chain、genesis、block hash/header | 承認数は確認するがPoW・difficulty検証なし |
| Stellar | 2 | Horizon passphrase、closed ledger | Stellar RPCとは別API。issuer・SCPの検証なし |
| XRP Ledger | 3 | network_id、validated ledger | network_idが取れない旧形式等は停止 |
| Substrate | 4 | genesis、finalized head、header | genesis固定必須。今回の時刻・鮮度確認は未実装 |
| Algorand | 3 | genesis、round、block、block hash | base32 paddingを検査。証明書の独立検証なし |
| Starknet | 2 | chainId、accepted block | pendingを拒否。L1受理とL2受理の表示を区別 |
| Tezos | 1 | chain_id、level、hash、header | ブロック深さの照合まで。署名／Base58 checksum検証なし |
| TRON | 3 | Solidity Nodeのsolidified block | genesis固定必須。blockID内のheightも照合 |
| TON | 2 | masterchain、lookupBlock、header | genesis固定必須。root/file hashとmasterchain tupleを照合 |

SuiのGraphQLが返すfull Base58形式と旧short hex形式は公式SDK文書に従い区別しています［2］。チェックポイントの指定APIは公式GraphQL文書を参照しました［3］。これらの形式への対応は、実サービスの現在の全バージョンと互換であることを保証しません。

自分のPCでRealDEXノードを動かすことと、各チェーンのフルノードを同時に同期することは別です。今回の実装は、利用者が確認したRPCへ読み取りを行うアダプターです。フルノードを自動導入・同期しません。

## 4. 不確かな情報を実行権限へ変えない

ローカル利用者が指定したHTTPSまたはloopback HTTPだけを参照します。候補メタデータのRPC URLを勝手に巡回しません。外部HTTP、URLのuserinfo・fragment、redirectを拒否します。読み取りメソッド・RESTパス・GraphQLクエリを許可リスト化し、mutation・wallet・sign・submitを追加していません。

要求単位8秒、全体既定60秒、応答既定2MiB、JSON深さ64、並列数の上限を設けます。大きな整数をJavaScript Numberで受けて桁落ちさせません。APIエラー本文の任意文字列は表示せず、定型コードに変換します。結果はURL全体ではなくオリジンだけを記録します。ただし秘密値を入れた要求ファイルや画面は利用者自身が保護する必要があります。

複数RPCの多数決は行いません。指定された全RPCが同じ識別値・同じアンカーを返す必要があります。途中のネットワーク変更、同じ高さのhash変更、大きなhead差、古い／未来の時刻は拒否します。前提が変わった画面の古い結果は破棄します。

**これはライトクライアントではありません。** 同じ運営者の別URL、同じ上流を使うRPC、共謀するRPCを見抜けません。ブロックhashを受け取ってもブロック内容のhash計算・コンセンサス署名・PoW・PoS・validator集合を独立検証したことにはなりません。初期識別値だけでは同じgenesisから分岐したforkの正当性も決まりません。

`rpcAgreement:true` と同時に `independentOperatorsVerified:false`、`blockExecutionVerified:false`、`consensusProofVerified:false`、`executable:false` を返します。時刻を取得しないSubstrateでは `freshnessEstablished:false` も明示します。

## 5. EVM契約の配置計画

元の三つのSolidityソースを保持しています。

```text
contracts/LocalSwapFactory.sol
contracts/LocalSwapPool.sol
contracts/LocalSwapRouter.sol
```

89候補の計画は `node/examples/evm-network-plans/` にあります。FactoryとRouterにはconstructor引数がなく、PoolはFactoryの `createPool(address,address,uint256)` を経て作成する計画です。実在しないデプロイアドレスを埋めず、factory/router/runtime hashは未設定のままにしています。

共通標準入力はSolidity 0.8.24、optimizer500、EVM target Parisです。EVM targetの取り違えが動作不良を起こし得ることはSolidity文書にも明記されています［4］。**この共通入力は全ネットワークへの配置承認ではありません。** 特殊VM、独自コンパイラ、ガスモデル、opcode、サイズ制限等を個別に検証する必要があります。

旧ビルドのハッシュを新しいParis出力へ転用してはいけません。`inspect-build` はローカルコンパイラ出力の構造確認であり、コンパイラ真正性やソースの意味保存証明ではありません。試験で使ったバイトコードは合成の短い入力です。実コンパイルや実EVMのデプロイ試験に数えていません。

前回から残るFactory初期storage、Pool生成由来、immutableを含むruntime同定、任意トークン挙動の検証は未完成です。これらを飛ばして既存送信画面へつなげていません。

## 6. 候補を増やす仕組み

`custom-evm` と `import-evm` は、同梱89EVM候補の外へ拡張する入口です。公開ethereum-listsリポジトリはchainId、通貨情報、状態、RPC等のメタデータと集約JSONを公開しています［1］。今回の取り込みは、利用者がローカルへ保存したその形式のJSONを対象にします。

元カタログにあるRPC、契約、送金先を信頼済みとして取り込むことはありません。廃止指定を保持し、不正ID・重複ID・不正メタデータを記録します。10,000件の合成データで試験していますが、実在10,000チェーンの対応を主張するものではありません。

**今回、公開EVM一覧の現行全件スナップショットをZIPへ収録したわけではありません。** GitHubの公開メタデータと集約形式は確認しましたが、実行環境への全件ファイル取得・同梱は完了していません。したがって件数は同梱138候補として報告します。

EVM以外のキーはRealDEX内のローカルキーです。全チェーンのCAIP登録済み識別子として公開しません。Move generic型、NFT、転送制限、凍結権、受取税、rebasing、ラップの裏付けなどの資産意味を今回の構文正規化だけで検証しません。同じsymbolやaddressでも別チェーンなら別のキーです。

## 7. 試験と証拠

| 検査 | 結果・範囲 |
|---|---|
| 新規Node試験 | 451件成功。候補138件・EVM計画89件の個別schema検査も含む |
| 既存Node試験 | 347件成功（以前の104＋243） |
| 既存release計画 | 6件成功 |
| 選択試験の合計 | **804件成功、失敗0、skip0** |
| 模擬RPCとのHTTP | 15系統ごとに2台のloopbackサーバーとの通信を実行 |
| 旧v0.4検証層のみ | 243件を独立再実行して成功 |
| TypeScript | 5.8.3のstrictチェック成功 |
| 画面 | Chromium144、オフラインDOM6項目成功、pageerror0 |
| レイアウト | desktop1440px / mobile390pxで確認、390px横はみ出しなし |
| 元402ファイル | 401ファイルをバイト一致で保持。READMEのみ更新 |
| 直前516ファイル | 509ファイル保持、7ファイル更新、削除0。新規ファイルは別に追加 |

新規451件は451種類のチェーンを試したという意味ではありません。候補ごとの型・権限検査やプラン生成を含む単体試験です。金融システム全体の安全性や外部監査の完了も意味しません。

主な証拠は `node/evidence/multichain/` に保存しています。完全なHTTP・CSP・CORSのブラウザ結合試験は実施できていません。実ブラウザのloopback HTTP遷移は `ERR_BLOCKED_BY_ADMINISTRATOR` で遮断されました。画面は製品JSをメモリ内モジュールで読み込み、同梱レジストリだけを供給し、RPC通信を禁止するDOM試験です。スクリーンショットにもその制約を表示しています。

Nodeの実HTTP試験とオフラインDOM試験は別です。これらを合計して実ブラウザ＋実RPCの結合に成功したとは判断しません。

配布時にはroot `FILES.sha256` を更新します。旧manifestは `baseline-v04-FILES.sha256` として証拠フォルダーへ保存し、現在のファイルを証明するものと混同しません。ZIPのSHA-256、再展開後の再試験、試験前後のmanifest照合は別添Package-Verification JSONで記録します。

## 8. 確認できなかったこと

実行環境はLinux x86-64、Node22.16.0、TypeScript5.8.3です。ルート依存は未導入で、Solidityパッケージの取得先照会はDNSエラー `EAI_AGAIN` でした。根拠は `environment.json` に保存しています。

そのため、元React/Vite/Hardhatアプリ全体のビルド・全テスト、新たなSolidityコンパイル、EVM実行、実チェーンRPCへの成功確認は未完了です。Windows、HTTPS公開、複数物理PC、家庭用NAT越え、実資産も試験していません。全チェーンの稼働状況やRPCバージョンの照合済みカタログではありません。

非EVMの新たなPool/Factory契約、非EVM交換の見積り・simulationの既存最適化器への統合、非EVM送信、ブリッジ実行・受取復旧、今回の観測から既存送信UIへ昇格する処理は追加していません。ブリッジ資産の裏付け、ルート流動性、転送可能性、費用の換算価格も未検証です。

## 9. 変更ファイルと次の実装境界

実装の中心は `node/chains/`、CLIは `node/chains.mjs`、画面は `node/public/chains.*`、試験は `node/test/multichain-*` です。元の `contracts/`、`src/`、`scripts/`、root package/lockfileは変更していません。

直近の実行系の課題は、実コンパイル済みFactory/Pool/Routerを明示したチェーンで照合し、前回のPool由来検証を完了したうえで実EVM試験へ進むことです。それが済むまで候補数を交換対応数へ置き換えません。非EVMでは各系統の資産・プールモデルに沿った決済実装が別途必要です。

## 10. 参照した一次資料

確認日：2026-09-05。本文の引用は要約であり、全APIの永久的互換を保証しません。

1. ethereum-lists/chains — メタデータ形式・集約JSON・状態管理: https://github.com/ethereum-lists/chains
2. Sui SDK digests — chain identifierのshort/full表現: https://mystenlabs.github.io/sui/sui_sdk/digests/index.html
3. Sui GraphQL checkpoint: https://docs.sui.io/references/sui-api/sui-graphql/beta/reference/operations/queries/checkpoint
4. Solidity 0.8.24 Using the Compiler — EVM target・標準JSON: https://docs.soliditylang.org/en/v0.8.24/using-the-compiler.html
5. Solana getGenesisHash / getBlock: https://solana.com/docs/rpc/http/getgenesishash / https://solana.com/docs/rpc/http/getblock
6. CometBFT RPC documentation: https://docs.cometbft.com/v0.38/rpc/
7. Aptos REST API: https://aptos.dev/rest-api/
8. NEAR RPC network / block: https://docs.near.org/api/rpc/network / https://docs.near.org/api/rpc/block-chunk
9. Bitcoin Core30 getblockchaininfo / getblockheader: https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblockchaininfo/ / https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/getblockheader/
10. Stellar Horizon API: https://developers.stellar.org/docs/data/apis/horizon/
11. XRP Ledger server_info / ledger: https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/server-info-methods/server_info / https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/ledger-methods/ledger
12. Polkadot documentation: https://docs.polkadot.com/
13. Algorand algod REST: https://dev.algorand.co/reference/rest-api/algod/
14. Starknet OpenRPC specifications: https://github.com/starkware-libs/starknet-specs
15. Octez RPC: https://octez.tezos.com/docs/api/rpc.html
16. TRON Solidity Node APIs: https://developers.tron.network/reference/getnowblock-1 / https://developers.tron.network/reference/getblockbynum-1
17. TON Center v2 API: https://docs.ton.org/ecosystem/api/toncenter/v2

原本の公開APIやネットワークの状況は変わり得ます。候補から本番取引へ進む際は、最新の公式仕様・実チェーン・コンパイル結果を改めて照合してください。
