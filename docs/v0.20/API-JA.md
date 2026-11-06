# v0.20 所有者API — Cosmos native SendAuthorization

全てPOST、ローカル所有者capabilityが必要です。既存AI/DAppトークンでは呼べません。bodyの未知フィールドは拒否します。設定は既存cosmosNetworksを使用します。

## POST /api/non-evm/cosmos-authz/prepare

bodyはaccountId, networkId, payment。payment共通: action, requestKey, feeAtomic, gasLimit, optional memo。全金額は正規化された整数文字列です。

|action|追加フィールド|署名者|
|---|---|---|
|grant|grantee, recipient, limitAtomic, expirationSeconds|資金所有者|
|execute|granter, recipient, amountAtomic|代理人|
|revoke|grantee|資金所有者|

準備だけでは署名しません。expirationSecondsはUTC Unix秒。grant作成は現在時刻より5秒以上先、7日以内を要求します。既存grantの上書きはAUTHZ_REVOKE_BEFORE_REGRANTで拒否します。

返却: id, intentId, summary。summaryにはgranter, grantee, feePayer, confirmationText, grantBefore, 署名されるtransfer、networkFingerprintを含みます。同一requestKeyと同一内容はalreadyRecorded、内容変更はPAYMENT_KEY_CONTENT_CONFLICTです。

## 承認

POST /api/non-evm/approve へid,intentId,confirmation,broadcastを渡します。confirmationはsummary.confirmationText全文です。grantはGRANT ... TO ... UNTIL ...、revokeはREVOKE ...、executeは受取先全文です。broadcast既定OFFはUIの動作で、APIではboolの明示が必要です。

## POST /api/non-evm/cosmos-authz/status

body: networkId, granter, grantee（ネットワークHRPの完全なアドレス）。未存在はgrant:null。生成条件に一致するものはrestricted-send、その他はunsupported。未認証のRPC観測であり、statusだけで署名・予算変更はしません。空のallow_listを任意送金として使用することはありません。

## POST /api/non-evm/cosmos-authz/submit

body: id, confirmation。confirmationは保存済みrequestId全文。state=signedの初回送信だけを許可します。許可・sequence・費用を再照合し、broadcast-unknownを保存してから署名済みの同じバイト列だけを送ります。

## POST /api/non-evm/cosmos-authz/reconcile

body: id。再送しません。原取引、包含、実行code、sequence、grant終端状態、execute時の送金イベントを照合します。grant/revoke成功はcompleted=true,received=falseです。execute成功だけがreceived=trueになります。過去の完了観測が消えればbroadcast-unknownに戻します。

## 状態

signed → broadcast-unknown → broadcast → reported-confirmed / reported-reverted。未解決のものがあれば同じ署名口座の通常/オフラインCosmos経路も保留します。取消し・失敗の完了観測でも独立した最終確定証明はありません。

型定義: wallet/non-evm/cosmos-authz-api.d.ts。
