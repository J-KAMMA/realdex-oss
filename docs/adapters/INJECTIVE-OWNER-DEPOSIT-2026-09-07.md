# INJ-08: 所有者承認付きの自己交換口座への入金

## 基準と変更範囲

ローカルINJ-07、commit `efd2d080f72783d97acc51c1a762d6312527e505` /
tree `4a1dc605ce6e7110c9599167c0521b079aed68a7`からの派生版。
GitHubの確認・取得・push・PR・CIを使用しない。古いBase Sepoliaへ戻さない。

変更は wallet/injective のaction codec/照合/表示用summary/履歴validator、
wallet/non-evm/controller の所有者API、wallet/public のフォームと表示、
wallet/test の入金試験とPython参照、integration/injective の実ノード試験、
本資料に限定する。共有暗号KDF、署名アルゴリズム、Vault保存primitive、
retirement本体、既存CI・full verifier・runtime pin・依存は変更しない。
この範囲は旧GitHub workstream一覧を自動的に拡張するものではなく、統合レビュー対象。

## 製品経路

`POST /api/non-evm/injective/deposit/prepare`

```json
{
  "accountId": "LOCAL_EVM_ACCOUNT_ID",
  "payment": {
    "requestKey": "unique-deposit-1",
    "endpoint": "http://127.0.0.1:REST_PORT",
    "subaccountId": "SELF_0x_64_HEX_NONDEFAULT_SUBACCOUNT",
    "denom": "ubase",
    "amountAtomic": "1000000000000000000",
    "policy": {
      "gasLimit": "1000000",
      "gasPriceAtomic": "500000000",
      "maxGasFeeAtomic": "500000000000000",
      "gasMarginBps": 12500,
      "timeoutBlocks": 40,
      "maxAgeMs": 30000
    }
  }
}
```

値はローカル架空資金の例であり、公開ネットワークの推奨手数料ではない。
既存WalletServerの所有者認証、Origin検査、排他、バックアップ確認を継承する。
秘密鍵・署名済みTxRaw・送金先の任意追加はこのAPIで受け取らない。

承認は既存`non-evm/approve`で review SHA全文を入力し、`broadcast:false`を要求。
署名済みTxRawとhashを暗号化Vaultへ保存するだけで送信しない。
別操作`non-evm/injective/submit`でtx hash全文を確認し、送信開始状態を
先に永続化した後に一度だけ送る。応答不明なら再送禁止、保存hashのみで照合する。
履歴のoperationは`injective-deposit-local`、actionは`deposit`。
入金宛先は署名所有者の非default subaccount IDに固定する。

## 資金と権限の境界

チェーンのMsgDepositが許容する範囲より製品側を狭め、自己所有の20-byte prefix、
明示的な32-byte ID、非zero末尾nonceを必須とする。他人への入金・外部送金・
default口座への実質無移動・bridge・任意messageを追加しない。

銀行側の **spendable** 残高が入金原資。交換口座のtotal/availableを銀行原資に
加算しない。INJ以外は入金額と銀行側INJ feeを別々に検査する。
INJ入金では `amountAtomic + ceil(gasLimit * gasPriceAtomic) <= bankSpendableINJ`。
同じ高さの銀行INJ照会結果を一回だけ使い、gasと入金に二重計上しない。
レビューvalidatorでも同じ不変条件を再計算する。署名前・初回送信前に再照合し、
残高低下・口座番号/sequence変更・期限超過・高さ不一致では止まる。

MsgDeposit、TxBody、AuthInfo、SignDoc、fee、宛先はvalidatorが独立再構築する。
自己hashだけを再計算して操作をwithdrawへ変えたり、額/宛先をすり替えることはできない。
保存reportのactionEffectもdeposit型と元reviewのkindが一致しなければ拒否する。

## 履歴、復旧、互換性

未送信depositは既存INJ-07と同じ条件でのみ`retired-unsent-expired`にできる。
取引自身のtimeoutHeight超過、同じ口座sequence、旧hash不在等を照合し、別の
所有者確認で履歴を残して終了する。送信結果不明はこの終了経路では処理しない。
新承認によりsequenceを再利用する場合も、既存の終了anchor照合を維持する。

入金記録を保存したVaultはINJ-07以前へ戻さない。旧版はdepositを知らず拒否する。
INJ-08は既存注文/取消/出金/終了履歴を読み込める。履歴64件上限は維持する。
同じrequestKeyで内容を変更しない。期限切れ等で再承認する場合は新しいキーを使う。

## 再現

```sh
node --test --test-reporter=tap wallet/test/injective-deposit.test.mjs
node app/ci.mjs --suite all --jobs 3 --output /new/source-ci
REALDEX_INJECTIVE_DIRECTORY=/verified/local/runtime \
  node --test --test-concurrency=1 --test-reporter=tap integration/injective/*.test.mjs
python3 wallet/test/browser-injective-deposit.py --output /new/browser-deposit
```

Python Decimal/protobuf比較は元の入力から期待値を作り、RealDEX出力を正解にしない。
実ノード試験は自己入金、INJ入金のgas合算、自己出金、応答喪失・新プロセス復元、
未送信期限超過と新承認の代替入金を行う。固定済み公式バイナリ、loopbackの一時
チェーン、生成・公開fixture鍵と架空資金のみを使用。公開peer/RPCは不要。

## ブラウザ試験の区別

本環境はChromiumの実HTTPナビゲーションを`ERR_BLOCKED_BY_ADMINISTRATOR`で遮断する。
ポリシーを解除せず、実API/実ノード試験と、合成API応答のDOM操作試験を分ける。
実ブラウザ→WalletServer→実ノードを一体で検証したとは認定しない。
任意の追加試験`REALDEX_INJ08_BROWSER=1`と`browser-owner-deposit.py`を同梱するが、
この環境では未通過。ブロックされた初回試験は失敗として保持し、成功に変更しない。
この追加試験が動く環境でもfixture以外の鍵・資産を渡さない。

## 未達と一次資料

照合/効果は同じローカルノードの観測であり、独立したstate proof・finalityではない。
採用成功とpost-state取得成功は別で、後者が失敗しても取得不能を明示する。
公開testnet/mainnet、外部signer、OS/Windows隔離、未知送信取引の一般復旧、
独立監査、署名付き本番配布は未認定。CI-03 IBC差分は今回も未統合。
root build・他チェーン全受入は今回のソース試験に含まれない。

仕様確認（2026-09-07）：
- https://docs.injective.network/developers-native/injective/exchange/05_messages
  MsgDeposit: bank -> subaccount、MsgWithdraw: subaccount -> sender bank。
- https://docs.injective.network/developers-native/injective/exchange/04_state_transitions
  原資移動とdeposit残高更新。ただし本版のbyte encoding/実行は固定済み実ノードで別途検証。
