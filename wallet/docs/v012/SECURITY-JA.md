# RealDEX v0.12 — 検証範囲とセキュリティ境界
2026-09-05。開発版。独立監査前であり実資産を入れないでください。

## 修正
1. 複数hopのRouter署名検査が入力・最終出力のトークンだけを必須・コード照合対象にし、中間トークンを漏らしていた問題を修正しました。全経路のtokenを所有者設定から解決し、全てコードハッシュ・桁数を照合します。旧コードで2hop＋未登録の中間tokenが拒否されないことを再現しています。
2. 非ゼロallowanceを別の非ゼロ値で上書きできていた点を改善しました。初回検査と署名直前の検査で現在値が0であることを要求します。ERC-20のクライアント向けzero-first推奨に沿う処理で、一般的な支出権限の安全性や全競合を解決するものではありません。取消以前に発生した支出、許可済みspenderの挙動、再編、複数端末の競合は別問題です。

## 信頼しないもの
複数RPCの一致を独立したチェーン証明として扱いません。今回のAnvil試験は一つのEVMに対する二つの転送口です。合成RPCの単体試験、実EVMでのHTTP/API試験、オフラインDOM試験も別々の証拠です。実ブラウザから実EVMまでの一体試験に合格したとはしていません。

登録コードハッシュは所有者の信頼設定であり、任意のERC20の安全証明ではありません。proxy/storage/外部依存/非標準transferの挙動まで同定しません。今回の手数料付きトークン試験は入力税の一例で、全ての秘密資産・rebase・送信側追加税・悪意あるbalanceOfなどの対応保証ではありません。

## コンパイラの分離
正式基準は従来のSolidity0.8.24の固定バイナリです。補助検証は公式Solidity0.8.37-nightly.2026.9.3+commit.f67cf4f2（Emscripten）を別の固定ハッシュで検査して実行します。本番のcompiler pin、既存契約、既存デプロイの信頼情報、Pool identity登録器は変更していません。nightlyの結果を既存バイトコードの再現性検証として流用しません。

実AMMテストは新しく配置したtest契約についてCREATE2アドレス・immutable反映後コードを照合します。任意の既存Poolを本番で自動承認する実装を完成させたものではありません。補助ツールは通常起動ではロードせず、コマンドの明示指定時だけ起動します。コード同一性検査はOS侵害に対する強い隔離ではありません。

## 新しい経路の制限
所有者専用、登録済み1〜4 Pool、全ERC20登録必須、循環不可。見積りは同一block hashと短い期限で束縛します。準備高・観測残高不一致は拒否しますが、観測後に状態が変わらない保証ではありません。最終minOut、deadline、署名時の再検査を維持します。経路探索・費用控除後最適化・分割実行・bridgeには拡張していません。

保管形式・主鍵・backup確認・lock・AIの予算/接続/緊急停止条件は維持しています。AIに追加の承認・交換権限を渡していません。本番メインネット制限は解除していません。

## 残る条件
固定コンパイラでの全契約試験、全React/ルート試験、実ブラウザHTTP/CSP、独立RPC/公開テストネット、鍵保護/配布署名/更新経路/独立監査が必要です。全チェーン送金、ICP Pool、実bridge、shielded wallet、NAT自動接続は未完成です。

## 一次資料
- ERC-20 allowanceとzero-first推奨: https://eips.ethereum.org/EIPS/eip-20
- コンパイラの標準JSONと明示EVM対象: https://docs.soliditylang.org/en/latest/using-the-compiler.html
- 補助コンパイラ公開元: https://github.com/argotorg/solc-bin
- 固定配布元commit: dd4f9bd179a15910a8c02ebeccc3d016614d97b0
- compiler source version: f67cf4f2 / https://github.com/argotorg/solidity
- Anvil: https://github.com/foundry-rs/foundry
