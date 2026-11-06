# RealDEX v0.22 — IBCブリッジ開発版

## 目的・範囲

所有者用PCウォレットから、自設のIBC Classic / ICS-20 v1対応チェーン間で1ホップの資産移転を行います。ネイティブ資産のロック→受取側のIBC表現、およびその表現のバーン→元資産の解放を扱います。EVM↔Bitcoin等の万能ブリッジではありません。

**未監査・使い捨てローカル試験専用。実資産の鍵を取り込まないでください。** ローカルURLだけでは公開チェーンへの中継を排除できません。既知の試験鍵を本番へ使わないでください。

基準は検証済み配布v0.20。Bitcoin共同承認v0.21 WIPは別に保全し、この版へ混合していません。旧資料の件数を今回の結果へ足し直していません。

## 通常起動・更新

旧プロセスを正常終了し、暗号化バックアップと設定を保全してから別ディレクトリへ展開します。

```sh
node app/cli.mjs start
# 従来のウォレット単独保管先を使う場合:
node wallet/cli.mjs start
```

Node 22.16.0で追加ローカル層を検証しています。追加層の起動にnpm installは不要です。元Reactアプリの正式依存環境が整ったことを意味しません。ウォレットの専用URLは所有者の操作権限です。AI、共有ノード、他人へ渡さないでください。

元のファイルや保存先を自動移行しません。IBC署名履歴を書いた保管庫を旧版で開いて上書きしないでください。古いバックアップへの復元は、送信や既存署名の取消しではありません。

## 使い捨ての実2チェーンデモ

Linux x86-64用の別配布 `RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip` を用意します。これはcosmos/ibc-goのPR CIから得た診断用イメージで、安定版・本番承認済みバイナリではありません。再ビルドによるソース同一性確認は行っていません。

```sh
python3 integration/ibc/provision.py \
  --archive /absolute/path/RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip \
  --output /absolute/path/new-ibc-tools

export REALDEX_IBC_SIMD_BINARY=/absolute/path/new-ibc-tools/simd
export REALDEX_IBC_MUSL_LOADER=/absolute/path/new-ibc-tools/lib/ld-musl-x86_64.so.1

node integration/ibc/demo.mjs
```

プロビジョナはZIP・本体・ローダーを固定SHA-256で照合し、必要な2ファイルだけを抽出します。インターネット接続やroot権限は不要です。既存の出力フォルダーは上書きしません。

デモは2つの独立した単一validatorチェーン、相互のTendermintクライアント、connection、channelを作り、往路・復路・未受取のタイムアウト返金を実行します。署名はRealDEX、IBCの検証・資産処理は各ノードです。試験用中継キーは別口座で手数料を払います。終了時に一時チェーン・保管庫を削除します。

画面で操作する使い捨て環境:

```sh
node integration/ibc/interactive.mjs
```

表示された所有者URLを同じPCで開き、「IBC BRIDGE」で最初の口座・A→B経路・表示された受取口座を使います。送信取引の総手数料50000、ガス上限2000000はこのデモ用の値です。数量1、パケット期限300秒を目安に入力し、確認文を全文再入力します。送信チェックは既定OFFです。初回送信後、起動端末で `relay <支払い識別キー>` を実行すると、試験中継者が受取とACKを処理します。未受取で期限が過ぎた場合は `timeout <支払い識別キー>` で試験中継者が未受取証明を送り、ノードが検証します。未経過や受取済みなら拒否されます。

これは人手で操作する試験用中継器です。常駐の本番中継サービスではなく、既存データを復元して使い続ける運用にも対応しません。

## 自分のローカル経路を登録する

既に正しく接続した2つのIBCチェーンが必要です。通常起動ではチェーンも中継者も自動生成しません。

所有者画面で経路JSONを貼り付け、「設定と指紋を表示」を押します。表示された `ADD IBC <fingerprint>` を全文入力し登録します。この操作は設定を保存してウォレットをロックします。表示時点は構造検査であり、チェーン状態の認証・送信許可ではありません。解除後の残高・準備処理で実際のchannel、connection、client、checkpointを照合します。

経路の型は `wallet/bridge/api.d.ts`、各フィールドはAPI文書を参照してください。公開チェーンIDやリモートURLは受け付けません。逆方向はsource/destinationを入れ替え、異なるroute idで追加します。originChainIdとbaseDenomは元チェーンのままです。記録に束縛された既存経路の端点・指紋を変更して、過去の署名を別経路へ流用してはいけません。

## 受取・返金の追跡

送信受付だけでは受取完了にしません。「保存したブリッジ履歴」で元取引を再照合します。中継者から得た **宛先のMsgRecvPacket取引ハッシュ** と **元チェーンのMsgAcknowledgementまたはMsgTimeout取引ハッシュ** を明示入力できます。

受取側に資産が現れてもACKの元チェーン処理が未確認なら、画面の完了フラグは未完です。再送しないでください。返金も、時間経過だけでは成立しません。未受取証明によるMsgTimeout処理、またはエラーACKの元チェーン処理と実返金差分を確認します。元の送信手数料・中継手数料は返金されません。

現在の読取器は**1取引に1つの中継メッセージ**だけを扱います。クライアント更新とのまとめ送信や、複数パケットを束ねる中継取引は未対応として保留します。中継成功を偽って表示する代わりに、未確認とします。

## 再試験

```sh
node app/verify.mjs --ibc --output /absolute/path/new-acceptance
node integration/ibc/run.mjs --output /absolute/path/new-ibc-only
python3 wallet/test/browser-ibc.py --output /absolute/path/new-offline-ui
```

`--ibc`で指定した実行試験の欠落・失敗は合格になりません。`--full`は正式依存・コンパイラ等を含み、未達があれば成功終了しません。オフラインUI試験は実HTTP・CSPの代替ではありません。
