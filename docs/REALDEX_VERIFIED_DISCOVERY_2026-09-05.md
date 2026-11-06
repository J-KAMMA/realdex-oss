# RealDEX 検証付き候補発見・交換ラボ 開発報告

**版：0.4.0-dev.20260905 / 作成日：2026-09-05（日本時間）**

## 目的

前回の個人PCノード版に、署名付きFactory候補を利用者が選んだRPCで照合し、交換候補・読み取りシミュレーション・費用の不足・限定した分割案まで表示する経路を追加した。新しい経路は独立した読み取り専用ラボであり、既存のウォレット送信画面を置換したものではない。

この版も、全チェーン・全トークンの実取引を完成した版ではない。資金の保管、承認、ウォレット接続、署名、デプロイ、公開、ブリッジ送信は今回行っていない。

## 今回実装した範囲

| 層 | 追加・変更 | 意味しないこと |
|---|---|---|
| 署名付き発見 | ブラウザ/Node共用の署名検証。relayと元publisherの鍵を別々に照合。nonce、期限、revision、同一revisionでの内容変更を検査 | 署名者の資産・プール・価格が安全という承認 |
| 読み取り | 利用者が指定した2〜4RPCを比較。同じchainId、ブロック高・hash・timestampを固定し、EIP-1898でcode/callを取得 | コンセンサスの検証、RPC運営者の独立性、L1確定の証明 |
| プール観測 | 固定したFactory runtime hash、mapping、Poolのgetter、料率、準備高、実残高、token code、整数CPMM式とquoteを照合 | Poolの生成由来、runtime全体の同定、任意トークンの転送安全性 |
| 事前確認 | 指定された公開アドレスの残高と既存allowanceを確認し、eth_callとガス見積りを取得 | 承認取引の作成、取引送信、受取残高差の証明 |
| 費用比較 | gas費用と追加費用、出力資産への換算を扱う。追加費用情報を経路・口座・受取先・block・期限へ束縛 | oracle認証、将来の実際の手数料や取引結果の保証 |
| 分割計算 | 観測した独立Poolの準備高を使う有限グリッドの厳密探索 | 実ネットワーク費用を差し引いた最適性、市場全体の最適性、分割取引の送信 |
| UI / CLI | `/node/exchange/`、`node/verify.mjs`、公開API型定義、シェルのglobに依存しない試験runner | 既存本番送信UIとの自動接続、Windows実機検証 |
| 生成アドレス | EIP-1014のCREATE2計算と、LocalSwapのsalt/constructor引数の計算を追加 | 使用するcreation codeの真正性、生成履歴の証明、現行観測器への生成証明の統合 |

### データの流れ

```text
明示的に指定した発信者公開鍵
  ↓
自分のノードからnonce付き署名snapshotを取得
  ↓
relayと元publisherの署名・期限・revisionを確認
  ↓
候補のchain/protocol/Factoryアドレスだけを取り出す
  ↓
自分で指定したRPC群から同じブロックの状態を読む
  ↓
Pool・準備高・quoteを照合
  ↓
期限付き読み取り観測 / 追加費用未確定 / 分割研究案

取引署名・送信・既存release gateへの自動昇格はない
```

ノードの発信内容からRPC URL、Poolアドレス、spender、calldata、価格、コードハッシュを採用しない。候補発見ノードはチェーンのバリデーターでもブリッジのバリデーターでもない。

## 実装ファイル

`node/shared/protocol-core.mjs` に署名対象の正規化とスキーマ検査を共通化した。既存のNode署名方式・wire schemaは変更していない。

`node/verified/catalogue.mjs` はネイティブWebCryptoを使うEd25519検証、stream上限、nonce、明示的な鍵許可、セッション内のrollback/equivocation拒否を実装する。ブラウザを再読込するとこの追加層のrevision headはリセットされる。既存ノードの永続headとは別物である。

`node/verified/rpc.mjs` は読み取りメソッドのallowlist、4並列/RPC・待機128件の上限、リクエスト/レスポンス上限、timeout・abort、同一block hashの照合を実装する。既定は2 confirmations、最大block age 120秒、観測寿命30秒、最大head差12。これらは開発版の読み取り規則であり、任意チェーンでのfinality保証ではない。EIP-1898非対応時はlatestへ落とさず停止する。

`node/verified/evm.mjs` はABIを限定し、全金額をBigIntで計算する。CPMMのuint112上限、token pair、固定料率1〜100bps、実残高が準備高以上であることなどを確認する。観測結果・シミュレーションは不変オブジェクトで、同じ実行環境のWeakMapに登録する。JSONを再読込しただけのオブジェクトは新たな権限として扱わない。

`node/verified/workflow.mjs` と `node/verify.mjs` は厳密なローカルJSON設定から同じ読み取りを再現する。CLIにも任意のruntime hashを受け入れる設定はない。出力ファイルは既存ファイルを上書きしない。CLIの0終了も送信許可ではなく、候補を観測できたという意味に限る。

`node/verified/keccak.mjs` は参照実装型のKeccak-256で、Goの別実装で72入力を照合した。暗号監査の代わりではない。署名処理はこの実装に持たせていない。

`node/verified/create2.mjs` は7件の公式EIP-1014例と一致する計算器である。現行観測器には、独立にコンパイル・検証したPool creation/runtime identityが未統合のため、生成証明済みフラグを立てない。

## 精査で明確にした重要な境界

### 実行コードの一致と、生成由来の証明は別

Solidityではconstructorの実行後にruntime codeが残り、constructor本体はdeployed codeには含まれない。[S2] したがって、**Factoryのruntime hash一致だけから、その初期storageや、mappingにあるPoolが必ず正規のcreation codeで生成されたことまで推論しない。**

今回の観測器はこの未解決点を隠さず、常に次を返す。

```json
{
  "executable": false,
  "poolCreationProvenanceVerified": false,
  "poolRuntimeIdentityVerified": false,
  "tokenTransferBehaviorVerified": false
}
```

同じgetter/quoteを返す異なるPool bytecodeを合成試験で観測させても、この区別が失われないことを試験した。これは既存実行版や実チェーンで攻撃が成功したという実証ではない。**任意Factoryを本番送信へ接続する前の未解決ブロッカー**である。

次の対策は、独立したビルドのcreation code・immutable付きruntime identity・CREATE2アドレスを結び付けること。CREATE2計算の基礎部品は追加したが、現在の入力資料に実際のコンパイル済みPool bytecodeがなく、コンパイラ取得も成功しなかったため、今回この由来検証を完成したとは扱わない。

### ガス見積りを無料や確定費用に変換しない

`eth_estimateGas` はEIP-1898の対象外なので、明示block numberでの見積りをhash再確認で挟み、各RPCの最大gas/最大gasPriceを参考値として使う。[S1] これは将来の料金上限や、L2追加データ費用の全包含を証明しない。

APIの追加費用情報には、`requestId / routeId / blockHash / account / recipient / asOf / expiresAt / source / complete / costs` を要求する。gasとの重複ID、別チェーンの費用、期限切れ、別口座・別受取先、負数や浮動小数点金額を拒否する。ただし、情報源の真正性・完全性は呼出側が別途確保すべきであり、関数内でoracleを検証したことにはならない。

画面/CLIには実費用oracleと換算価格を接続していない。したがって既定では「比較未完了」であり、実質最良の自動選択をしない。承認不足時も、承認費用を0に置くのではなく停止する。

### 読み取りシミュレーションの成功と、受取成功は別

`eth_call` の戻り値だけでは、受取人の残高差や、税・リベース・blacklist・更新権限などのあるトークンの挙動を証明できない。今回の計算は契約getterとモデルの照合であり、すべてのトークンが扱えるという認証ではない。

## 検証結果

最終ソースで以下を確認した。試験件数は包含関係があり、合計を重複加算しない。

| 試験 | 結果 |
|---|---|
| 既存ノード試験104件＋今回追加243件 | **347成功 / 0失敗** |
| 既存release plan試験 | **6成功 / 0失敗** |
| 一括runner（上記合計） | **353成功 / 0失敗 / skip 0** |
| Keccak独立照合 | 上の243件中、72入力がGo referenceと一致 |
| CREATE2公式例 | 上の243件中、EIP-1014例0〜6の7件と一致 |
| 実HTTP結合 | 署名ノード＋2つのloopback RPCサーバーを通した検証・拒否・simulation・分割が成功 |
| 合成Factoryの拒否 | 正しい署名と一致RPCでも、本番の固定hashでは候補0件・コード不一致にする |
| 公開API型利用例 | strict compile成功。全アプリ/全JS実装の型検査ではない |
| 既存contract call arity | 285ファイル、17箇所を検査、指摘0。overloadは既存規則で除外 |
| 既存hook静的検査 | 既存の確認済み例外6件、新しい差異0。self-testも成功 |
| 新UIのオフラインDOM | 1440/390/320px、200% CSS zoom、失効・変更・改ざん・中止・承認不足などが成功 |
| 既存consoleのオフラインDOM | 回帰試験成功 |
| 既存3ノードデモ | 署名中継と計算デモ成功 |

### 合成データによる分割例

実市場データでも利益予測でもない。入力100,000最小単位、Pool 1が料率5bps・準備高1,000,000/1,000,000、Pool 2が30bps・1,000,000/1,100,000の固定モデルを使った。

| 案 | 最低受取（追加ネットワーク費用を引く前） |
|---|---:|
| 5bpsのPoolへ全額 | 90,412 |
| 30bpsのPoolへ全額 | 99,228 |
| 25,000 / 75,000 に分割 | **100,402** |

1,000最小単位刻み・2Poolの範囲では総当たりとも一致した。既存split optimizerには別途80個の小規模総当たり照合がある。分割案を送るRouterは追加しておらず、ガスを入れれば順位が変わる可能性がある。

### ブラウザ試験の限界

実際に起動したHTTPサーバーはNode/urllibから応答を取得できたが、Chromiumの通常navigationは `ERR_BLOCKED_BY_ADMINISTRATOR` で拒否された。管理ポリシーは変更していない。

そのため画面試験はabout:blankへローカルHTML/CSSと試験用bundleを注入した。about:blankにはSubtleCryptoがなく、Ed25519の検証のみPython cryptographyへの試験用bridgeを使用した。コードの読み取りロジックは実モジュールを使い、成功例に限って合成Factoryのローカルpolicyを試験loaderで明示的に渡した。製品のUI/CLIへそのoverrideは入れていない。本番policyによる合成Factoryの拒否も別途試験した。

**これはブラウザHTTP/CSP・ブラウザネイティブWebCrypto・実EVMの結合試験ではない。** NodeのネイティブWebCryptoと実HTTPは別の自動試験で確認した。公開スクリーンショットには合成試験データである旨を表示している。

## 環境と未実施

Linux x86_64、Node 22.16.0、TypeScript 5.8.3、Go 1.23.2、Chromium 144.0.7559.96で実施した。元アプリの指定環境はNode 24.14.0、pnpm 11.25.0、TypeScript 5.9.3であり、その環境を満たして検証したとは扱わない。

npm registryへの取得は `EAI_AGAIN`、コンパイラの別取得も未成功。したがって元のReact/Vite/Hardhat全体のbuild/test、実Solidityコンパイル・実EVM実行、既存CCTP artifact関連self-test、Windows実機、HTTPS公開、実ネットワーク間のNAT越え、物理PC複数台、実チェーン・実資産での取引は未実施。依存パッケージやコンパイラを偽の代用品で置き換えて試験成功とはしていない。

新しいノード・ラボ・CLIの通常実行とNode試験には追加npm依存は不要。Python/Playwright/cryptography/TypeScriptは任意の画面QAにのみ必要。

## 原本保全

元ZIPの402ファイルのうち401ファイルをbyte単位で維持し、READMEのみ追記更新する方針を維持した。`contracts/`、`src/`、既存`scripts/`、rootの依存指定とlockfileを変更していない。前回Node Previewに対する差分は今回のnode層・文書・試験のみ。

正確なファイル比較・入力ZIP hashは `node/evidence/v04/source-preservation.json` を参照。旧 `node/evidence/` 直下の記録はv0.3当時の履歴であり、v0.4の最新記録と混同しない。

## 次の公開前ゲート

最優先は、実コンパイル環境でのPool creation/runtime identity検証と実EVM差分試験。続いて、現行のaccount/session/recipient/intentとrelease gateを維持した送信UI接続、真正性を検証した費用/価格情報、分割Routerの原子性・失敗時巻戻し検証を行う。

チェーン追加とブリッジについては、対象資産の同一性、送信側/受取側の確定、途中状態の復旧を別々に扱う。既存のCCTP/IBC/Bitcoin/Solana設計ゲートを一括で「実行可能」にしない。家庭用PCの自動接続、relay/NAT、Peer鍵更新とSybil/DoS対策も未実装部分として残る。

## 一次資料

S1. EIP-1898 — RPCによるblockHash/requireCanonical指定と対象メソッド。 https://eips.ethereum.org/EIPS/eip-1898

S2. Solidity Contracts — constructorとdeployed runtime codeの区別。 https://docs.soliditylang.org/en/latest/contracts.html

S3. EIP-1014 — CREATE2アドレス式と公式例。 https://eips.ethereum.org/EIPS/eip-1014

S4. EIP-3860 — initcode上限。本計算器は49,152 bytesに制限するが、チェーンの適用forkは別途判断する。 https://eips.ethereum.org/EIPS/eip-3860

上記の仕様記述と、今回のローカル測定・合成試験・設計判断は別の根拠として扱った。
