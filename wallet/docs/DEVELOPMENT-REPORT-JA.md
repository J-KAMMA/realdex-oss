# RealDEX Wallet v0.7 実装・検証報告

作成日: 2026-09-05  
基準: `RealDEX-ICP-Privacy-Preview-2026-09-05.zip`  
追加モジュール: `wallet/package.json` / `0.7.0-dev.20260905`

## 結論

自己管理の暗号化保管庫・鍵生成/取込/復元・ロック・承認画面・EVM署名/試験送信・永続履歴・EIP-1193接続を実装した。以前の読み取り層とは異なり、この追加サービスには実際の取引署名と送信コードがある。ただしUI/APIの署名対象は明示設定した一部EVMテスト/ローカルネットワークに限定する。**未監査の開発版であり、実資産を使用しないこと。**

Tauri・ネイティブexe・OSセキュア保管は実装していない。Nodeサービスとブラウザのローカル画面で動かす。ICP/Solanaは鍵管理とオフライン署名コーデックまで。全164候補で使える内蔵送金ウォレットや、新しい全チェーンPool/Factory/ブリッジが完成したわけではない。

## 1. 成果物と構成

```
wallet/
  cli.mjs                    ローカル起動。共有ノードとは別プロセス
  lib/storage.mjs            private files / atomic writes / one writer
  lib/vault.mjs              scrypt + AES-GCM / backup / lock / journal
  lib/keys.mjs               EVM / ICP / Solana key and address functions
  lib/transactions.mjs       EVM signed wire / ABI checks / Solana・ICP offline codecs
  lib/network.mjs            explicit test network + RPC + contract policy
  lib/evm-engine.mjs         fresh recheck / sign / submit / reconcile
  lib/server.mjs             UI authorityとdApp接続権限を分離
  public/                    ローカル画面とEIP-1193 provider
  vendor/                    固定したnoble-secp256k1とMIT/出典
  test/                      Node・Python独立照合・CLI・offline DOM
  docs/                      日本語手順・本報告・脅威モデル
  evidence/                  実行ログ・試験JSON・原本保全
```

共有ノードのHTTPサーバーは変更していない。鍵保管庫は既定でホームディレクトリの `.realdex-wallet` に保存する。共有P2P候補とウォレット鍵を同じデータ構造にしない。

## 2. 追加したウォレット機能

| 項目 | 実装した範囲 | 境界 |
|---|---|---|
| ローカル口座 | EVM / ICP / Solanaの生成、32バイト鍵/seed取込、閲覧専用 | 口座ごとの独立鍵。BIP39/HDではない |
| 暗号化保存 | AES-256-GCM、scrypt N131072/r8/p1、salt/IVの乱数、認証付き形式 | パスワード・OSの侵害を完全には防がない |
| 復元 | 暗号化JSON＋パスワード、空の保管先への復元、口座一致検査 | 既存保管庫は上書きしない。古い履歴の巻戻し耐性はない |
| 署名許可 | 現在の口座集合と保存バックアップの一致が必要 | 新規口座追加後は再照合 |
| ロック | 明示ロック、5分自動ロック、非同期解除中の取消し | 通信開始済み取引は取り消せない |
| dApp接続 | EIP-1193 provider、origin/口座/chain/期限に束縛 | 接続権限は署名承認権ではない |
| EVM署名 | 保護されたlegacy EIP-155とtype2 EIP-1559 | 任意署名、access list、contract creation、smart account等は対象外 |
| 履歴 | 署名とnonce予約を先に暗号化保存、結果不明保持、同一バイト列の手動再送 | 手数料引上げ・nonce置換・履歴アーカイブ未実装 |
| ICP | self-authenticating principal、ICRC1の署名付きCBOR envelope | UI/APIからの送信、証明書・委任・復旧の結合なし |
| Solana | Ed25519口座、単一ネイティブ送金のlegacy署名wire | UI/API送信、SPL/Token2022、実blockhash管理の結合なし |

EVMの署名形式と検証ベクトルはEIP-155/EIP-1559 [1][2] に基づく。Nodeのscrypt/AES-GCM機能を使用する [4]。規格に形式が一致することと、このアプリ全体の安全性は別である。

## 3. DEXの取引確認

ERC20は転送・有限上限つき承認・承認取消を区別する。LocalSwapFactoryのプール作成、Pool/Routerのスワップ、Pool/Routerの流動性追加、Poolの引出しを個別にデコードする。数量、最低受取量/シェア、宛先、期限、登録コードハッシュを検査する。実ソースの関数シグネチャを参照したが、新たなSolidityコンパイルや実EVM実行はしていない。

署名直前にRPCを再照合する。確認後に金額・nonce・チェーン・手数料などが変われば拒否する。画面は原子単位だけでなく登録decimalsで換算した数量とトークンアドレスも示す。メタデータは利用者が登録したものであり、偽装のない公式情報と認証してはいない。

genesis hashもnonce予約に含める。復元した同じchain IDの署名を、別genesisのネットワークで送信・履歴照合することを拒否する。署名後であっても、まだRPCへ送っていない段階でdApp接続が取り消された場合は送信しない。署名は履歴に残る。

複数RPC、runtime hash、成功simulationだけでは、チェーン最終性、Pool生成由来、Proxyのstorage、将来のトークン挙動を証明できない。今回の手動allowlistは以前の未検証候補を自動で実行可能へ昇格させるものではない。

## 4. 実験画面と標準画面の区別

`src/App.tsx`にPC Wallet選択・接続取消を追加し、`src/wallet/use-eip6963.ts`からopt-inのローカルproviderを登録する。接続UIのコード変更と、provider/APIのHTTP結合試験は実施したが、React全体のブラウザ結合試験は未達である。

**これは `/experimental.html` の実験画面への追加である。** 標準エントリー `src/main.tsx` / `src/v01/V01App.tsx` と公開前の制限は維持した。標準v0.1のMetaMask/Base Sepolia対象を勝手に拡張しない。

内蔵サービスで許すIDは1337、31337、11155111、17000、97、80002、43113、1001。これは実装上の許可表で、全候補の稼働実証ではない。本番と、Base Sepolia/Arbitrum Sepolia等の追加費用未対応ロールアップを拒否する。既存外部ウォレット経路は残したが、新版の全外部ウォレット結合を検証したわけではない。

## 5. 試験結果

| 試験 | 結果と意味 |
|---|---|
| 追加Node試験 | **53成功、失敗0、スキップ0** |
| 既存の選択スイート | **1171成功、失敗0、スキップ0** |
| 合計 | **1224成功**。元リポジトリ全体の全テストではない |
| 独立Python/OpenSSL照合 | ECDSA24、EVM wire/signature24、Solana24、ICP24 = **96ケース** |
| 実HTTP | ローカル署名サービス、EIP-1193 provider、2台の**合成RPC**。実EVMではない |
| CLI起動 | 実プロセス起動、専用画面API認可、重複writer拒否、SIGTERM後のlock解放 |
| Browser DOM | Chromiumで**10操作**。1440pxと390px、横はみ出しなし、ロック中入力保持・遅い応答による復活拒否 |
| API宣言 | provider `.d.mts` 利用例をTypeScript strictで検査 |
| 構文 | walletのJSモジュール、編集React2ファイルの構文transpileを検査。Reactの意味的型検査ではない |

96独立ケース・10 DOM操作を1224件へ足し直していない。EVM独立照合はJavaScriptが出したKeccak digestを使うため、Keccakを別実装で再計算した検証ではない。公式EIP-155の署名データ・hash・署名済みwireの一致も別途Node試験に含む。ECDSAライブラリのGit blob / SHA256 / MIT表示を試験している。

検証環境: Linux、Node22.16.0、TypeScript5.8.3、Chromium144.0.7559.96、Python cryptography/OpenSSL。通常起動とNode試験に追加npm依存の取得は不要。Python/browser/type検査はそれぞれの開発用ツールが必要。

## 6. 試験中に見つけ、修正した点

ICP CBORの自己記述tag二重付与を修正した。署名済みEVMの厳密再デコード・復元時の署名者照合を追加した。非同期の署名再検査中と送信直前に接続取消しを再検査するようにした。保管庫ロック中の画面pollが入力中パスワードを消す問題と、遅い応答がロック画面を戻す問題を修正した。

既存回帰試験では、同じ模擬block hashに対して実時計由来のtimestampが途中で変わり、正しく不一致と判定される不安定なfixtureを発見した。`node/test/verified-integration.test.mjs`の模擬timestampをblock作成時に固定した。実コードの不一致判定やrelease gateは緩めていない。

## 7. 未完了・失敗した検証

`npm run build`は試行したが、React/ethers/vitest等の依存がない状態でTypeScript段階が失敗し、Viteへ進めなかった。依存導入後に成功することまで保証できない。元React/Hardhat全体のbuild/test、新しいSolidityコンパイル、実EVM、実chain RPC適合性は未検証。

通常のChromium HTTPアクセスは `ERR_BLOCKED_BY_ADMINISTRATOR` で遮断された。制限は迂回せず、画面の別試験は純粋な合成APIを使うオフラインDOMとした。CSP/CORS/ネイティブブラウザとローカルサービスを一体で検証したものではない。プレビュー画像にも合成/オフラインと表示した。

Windows/macOS実機、ネイティブアプリ署名・installer、OSキーチェーン、複数物理PC、HTTPS公開、NAT越え、実資産、ハードウェアウォレット、独立セキュリティ監査は未実施。ICP/プライバシー系の実入出金・新Pool/Factory/bridge完了も含まれない。

## 8. 原本保全と配布再現

基準ZIPは729ファイル。この版では**723ファイルをバイト単位で維持し、削除0**。変更は `.gitignore`、`FILES.sha256`、`README.md`、前述の模擬fixture、`src/App.tsx`、`src/wallet/use-eip6963.ts` の6件。

既存contracts、shared node server、標準v0.1エントリー、root依存指定・lockfileは維持した。追加source・文書・ログは `wallet/` 等にまとめた。ルートのpackage version/依存は旧経路のものを維持し、追加版のversionは `wallet/package.json` と画面に表示する。

配布物はルート `FILES.sha256` で内容を照合できる。ZIP再展開後の試験とmanifest再照合は、別添 `RealDEX-Wallet-Package-Verification-2026-09-05.json` に実行結果を記録する。ハッシュ一致は配布内容の整合性であり、第三者の安全性証明ではない。

## 9. 次の実装・昇格条件

最優先は正規依存環境でのReact統合ビルドと実ブラウザ/EVM試験、独立したウォレット/鍵管理レビュー。その後、OS鍵保管/ネイティブ配布、HD/標準復元、実チェーンの費用・finalityモデル、ICP証明書/台帳送信回復、Solana・privacy-walletの実行系を接続する。今あるchain候補の数を、そのまま署名/資産安全性の達成指標にしない。

## 一次資料

2026-09-05確認。資料の仕様と、今回の実装が独立監査済みであることは別。

1. EIP-155（署名形式・公式ベクトル）: https://eips.ethereum.org/EIPS/eip-155
2. EIP-1559（type2 wire・署名対象）: https://eips.ethereum.org/EIPS/eip-1559
3. EIP-1193 / EIP-6963（provider・発見）: https://eips.ethereum.org/EIPS/eip-1193 / https://eips.ethereum.org/EIPS/eip-6963
4. Node.js Crypto（scrypt・AES-GCM・Ed25519等）: https://nodejs.org/api/crypto.html
5. noble-secp256k1固定ソース: https://github.com/paulmillr/noble-secp256k1/tree/2.2.3
6. nobleのsecurity considerations: https://github.com/paulmillr/noble-secp256k1#security
7. Solana Transactions: https://solana.com/docs/core/transactions
8. ICP HTTPS interface: https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/

固定ソースはupstream index.js、Git blob `e1156d42830a9cf4fd54a8f8e3b26f7c984e1dae`、SHA256 `45f34003f752401c860347182c0bce4e7d0306cbf6aac70b17593ee70deaeaec`。内容不変で拡張子をmjsにした。MIT表示を同梱する。旧版に対する監査を今回のウォレット全体の監査と称さない。
