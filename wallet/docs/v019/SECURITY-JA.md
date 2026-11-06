# Injective owner path security notes

- 公開鍵は既存EVM secp256k1ローカル鍵から導出し、EVM addressとInjective bech32 addressの両方を照合する。
- 秘密鍵はAPI/UIへ返さず、vault内部の同期signer callbackだけで使用し、Bufferをzero fillする。
- reviewのself-hash、単一ローカルREST応答、simulationはいずれもstate proofではない。
- owner approvalは署名保存だけ。初回送信には保存済みtx hashの別確認が必要。
- `broadcast-unknown` 保存が成功するまでsendを開始しない。保存失敗時はvaultをロックする。
- transport error、timeout、connection dropを「未送信」と推定しない。再送を禁止しtx hash照合だけ許可する。
- transaction/account sequenceの変化を署名前・送信前に拒否する。
- vaultを再起動しても生成時review JSONを復元して完全なpreflight hashを再検査する。
- 現在は127.0.0.1 Injective diagnostic node専用。公開testnet/mainnetは許可しない。
