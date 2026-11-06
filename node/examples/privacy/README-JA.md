# v0.6設定例

すべて読み取りまたはオフライン計算用です。秘密鍵、シード、閲覧鍵を入力しないでください。
`REPLACE_WITH_...`は意図的に無効な値です。独立に確認した値へ置き換えるまで接続検査は停止します。
これらのファイルは起動時に自動実行されず、ノード間で共有されません。

- `icrc-local.json`: ローカルICP開発環境。canister IDは例なので、自分で作成した台帳のIDへ変更します。RealDEXはICPレプリカを起動しません。
- `icrc-explicit-remote.json`: ICPの公開HTTPS入口へ明示許可して問い合わせる例。実行すると問い合わせ元IP、対象台帳、時刻等が相手へ伝わり得ます。署名・証明書の検証は未実装です。
- `monero-local.json`: 自分のmonerodの`/json_rpc`へ接続します。wallet-rpcではありません。Digest認証へのチャレンジ応答は未実装です。
- `zcash-local.json`: 自分のZebra/互換RPCへ接続します。`authEnv`はAuthorizationヘッダー全体を格納した環境変数の名前です。値そのものをJSONへ書かないでください。cookieファイルの自動取得は行いません。
- `namada-local.json`: CometBFTの既知のチェックポイントを照合します。チェーン更新等で高さ1が保持されていない場合は、独立確認した利用可能な高さ・ハッシュを組で指定します。
- `icrc-rosetta-local.json`: ICP全体ではなく指定したckBTC台帳の履歴を照合します。Rosettaサーバーの起動・同期は利用者側で必要です。
- `private-evm-spec.json` / `private-comet-spec.json`: CLIから私設ネットワークのローカル設定を作ります。新しいブロックチェーンやvalidatorを作るコマンドではありません。
- `icrc-pool-model.json` / `route-claims-model.json`: 全量が合成データのモデルです。実市場の準備高・手数料・交換見積りではありません。後者の将来期限はオフライン例の便宜であり、取引を許可する有効期限ではありません。

```sh
node node/privacy.mjs quote-icrc --input node/examples/privacy/icrc-pool-model.json
node node/privacy.mjs screen-routes --input node/examples/privacy/route-claims-model.json
```

アクセス許可を変更せず、失敗時にも別の公開RPCへ切り替えません。ローカルTCPへ接続できることは匿名通信の証明ではありません。
