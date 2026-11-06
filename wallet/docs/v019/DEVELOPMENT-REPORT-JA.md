# RealDEX Wallet v0.19 — Injective owner-durable local order path

## 目的

INJ-04で実証した隔離Injectiveノードの注文経路を、試験専用signerではなく既存の所有者ウォレットへ接続する。対象は `injective-888` の127.0.0.1診断ノードだけであり、公開testnet/mainnetや本番資産を許可する変更ではない。

## 実装した権限分離

1. `node/spot-preflight.mjs` が作る完全な `realdex.injective-preflight.v1` を所有者UIへ渡す。
2. ウォレットはEVMローカル鍵の公開鍵・EVMアドレス・Injectiveアドレス、account number/sequence、注文、費用、simulation、期限を再検査する。
3. 所有者が preflight SHA-256 を全文再入力した場合だけ、Keccak(signDoc) を同じsecp256k1鍵で署名する。
4. **承認では送信しない。** 65-byte署名と完全TxRaw、決定的tx hashを暗号化vaultへ保存する。
5. 履歴画面で保存済みtx hashを全文再入力した場合だけ初回送信を開始する。
6. 送信より先に `broadcast-unknown` を暗号化保存する。保存失敗ならネットワークへ1byteも送らない。
7. 応答喪失後は自動再送しない。同じtx hashを読み取り照合するだけとする。
8. 再起動後も暗号化された完全reviewを再構成・検証し、同じtx hashを追跡する。

## ハッシュ順序の永続化

既存preflight/plan SHA-256は生成時JSONの順序にも依存する。vaultは暗号化前にオブジェクトkeyを正規化するため、単純にreviewオブジェクトだけを保存すると再起動後のハッシュ検証が壊れる。今回、署名intentへ生成時の完全 `reviewJson` を追加し、暗号化後の再読込ではその文字列から元のreviewを復元し、正規化したオブジェクトとの意味一致も同時に検査する。ハッシュ検証を無効化する回避は行っていない。

## 実ノード確認

固定済み `v1.20.3-safeharbor.2` のローカルInjectiveノードで、wallet vaultに同一actor鍵を入れた実経路を実行した。preflight後のowner approvalはchain sequenceを変更せず、署名済みTxRawがvaultへ存在することを確認してから初回送信した。tx hashがブロック収録結果と一致し、reconcileで `reported-confirmed` へ遷移した。同じrecordの再送要求は拒否された。

この試験は使い捨てgenesis資産と試験鍵だけを使用する。公開ネットワークのstate proof、validator quorum、独立監査、本番署名を意味しない。

## 追加の境界試験

- owner account/public key不一致
- preflight期限切れ
- approval確認hash不一致
- 署名前後のaccount sequence変更
- vault保存失敗時の送信ゼロとロック
- 送信応答喪失後の再送禁止
- 再起動後の暗号化record復元とtx hash照合
- CheckTx numeric JSON文字列の厳密処理
- local-only endpoint
- UIでの署名と送信の二段階分離、390px幅

## 未完了

この段階で製品ウォレットに接続したのは **spot create orderの初回送信と結果照合**。所有者ウォレットによるcancel、deposit/withdraw、公開testnet lifecycle、OS鍵隔離、復旧、独立監査、signed distributionは別工程である。`broadcast-unknown` は失敗ではなく「送った可能性がある状態」であり、絶対に自動再送しない。
