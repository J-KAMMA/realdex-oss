# RealDEX v0.19 — 所有者専用スマートアカウントAPI

通常の所有者認証・Origin確認・ロック世代検査を使うPOST JSONです。接頭辞は`/api/`です。所有者URLやBearerをAI/dappへ渡してはいけません。既存の`/bridge/`やagent MCPからは呼べません。型宣言は`wallet/smart-account/api.d.mts`を参照してください。

| suffix | 用途 |
|---|---|
| `smart/catalog` | 所有者の口座、登録済みスマート口座、試験ネットワーク、機能フラグ |
| `smart/register/prepare` | ownerAccountId・chainId・factory・salt・labelから生成先と実コードを確認 |
| `smart/register/commit` | draftId・digest・`REGISTER <address>`を確認し、保管庫へ登録 |
| `smart/inspect` | id、任意のsessionAccountIdでcode・残高・nonce・補助鍵方針を観測 |
| `smart/prepare` | idとoperationから所有者の承認待ちを作成。まだ署名しない |
| `smart/message/prepare` | id・message・validUntilから期限付きメッセージの承認待ちを作成 |
| `smart/messages` | 保存済み署名の所有者向け読取り |
| `smart/message/verify` | messageIdを指定して実契約のERC-1271を再評価 |

承認は既存の`approve`へ`id`, `intentId`, `confirm`, `broadcast`を渡します。`confirm`は応答のsummary.recipientと完全一致を要求します。メッセージ署名にはbroadcastを許可しません。通常の送信も既定でOFFです。

## operation

すべての数量は表示単位の小数文字列、chain IDや秒数は整数文字列です。

```json
{"type":"payments","transfers":[
  {"asset":"native","recipient":"0x1111111111111111111111111111111111111111","amount":"0.001"},
  {"asset":"native","recipient":"0x2222222222222222222222222222222222222222","amount":"0.002"}
]}
```

上は構文例で、実送金先ではありません。`deploy`, `fund`, `payments`, `swap`, `grant-session`, `session-transfer`, `revoke-session`, `revoke-all`, `invalidate-signatures`だけを受け付けます。任意のcalldata/delegatecall/UserOperationへ切り替える入力はありません。

`grant-session`はsessionAccountId、asset、recipient、perCall、daily、total、validUntilを必須とします。`session-transfer`はsessionAccountIdとamountだけです。受取先・資産・上限はチェーン上の方針から読むため、送金要求で差し替えられません。

既存の`reconcile`を使ってEVM履歴を再照合します。スマート取引は`rebroadcast`の既存名称を使いますが、許されるのはstate=`signed`の**初回送信だけ**です。送信済み/結果不明を再送する機能ではありません。

## オンチェーンABI

- Factory: `getAddress(address,bytes32)`, `createAccount(address,bytes32)`
- Account: `executeBatch((address,uint256,bytes)[],uint256,uint48)`
- `grantSession(address,address,address,uint128,uint128,uint128,uint48)`
- `sessionTransfer(uint256 generation,uint256 expectedNonce,uint256 amount)`
- `revokeSession(address)`, `revokeAllSessions()`
- `messageDigest(bytes32,uint48)`, `isValidSignature(bytes32,bytes)`, `invalidateSignatures()`

`executeBatch`は最大8件、期限は最大10分。所有者EOAだけが呼べます。補助鍵の直接支払いは最大7日の許可範囲で動きます。ガス代は呼び出したEOAが支払います。

ERC-1271 envelopeは103バイトです。deadline(uint48/6B) || signatureEpoch(uint256/32B) || r(32B) || s(32B) || v(1B)。署名対象はEIP-712の`SmartAccountMessage(bytes32 hash,uint48 validUntil,uint256 epoch)`、domainはname=`RealDEX Smart Account`, version=`1`, chainId, verifyingContractです。期限・世代の合致時だけmagic value `0x1626ba7e`を返します。通常のpersonal_signの出力をそのまま入れる方式ではありません。

## 資料

ERC-1271: https://eips.ethereum.org/EIPS/eip-1271
ERC-4337（本版は未実装）: https://eips.ethereum.org/EIPS/eip-4337
EIP-7702（本版は未実装）: https://eips.ethereum.org/EIPS/eip-7702
