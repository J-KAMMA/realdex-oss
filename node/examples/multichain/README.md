# 読み取り要求の例

`.invalid` は動作しない置換用です。利用者が確認したRPCのURLへ変更し、必要な系統では初期ブロック識別値も別経路で確認して固定してください。RPCから受け取った値をそのまま信頼済みに昇格させないでください。

AptosはAPIルート `/v1`、SuiはGraphQLエンドポイント、TONはv2 RESTルートが対象です。CosmosはCometBFTのJSON-RPCであり、Cosmos SDKのRESTルートではありません。StellarはHorizonです。BitcoinはCore RPCです。TRONはSolidity Node用HTTP APIを要求します。

必要な認証ヘッダーはURL文字列の代わりに `{ "url":"https://…", "headers":{"Authorization":"…"} }` として指定できます。`Authorization`、`x-api-key`、`x-algo-api-token`、`tron-pro-api-key` のみ許可します。URLのuserinfo形式は拒否します。秘密値を含む設定・画面を共有しないでください。

これらは接続先を自動設定するファイルでも、デプロイ先・送金先の承認でもありません。取引機能はありません。
