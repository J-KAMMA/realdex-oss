# 次の開発担当への引継ぎ — v0.16

基準ZIPはv0.15 Bitcoin settlement、SHA256 bdd4111544a968db4acc836f37d5ec93da75e4de363b4cd0f831842e6a7a4578。
今回、Stellar StandaloneとAptos local chain 4のowner-onlyオンライン送金を追加した。新規77wallet tests +3readiness tests。既存Core/Anvil/LiteSVM/補助AMMも再実行する。合成Horizon/Aptos RESTで実署名を検査したが、本物のStellar/Aptos実行ノードは使用していない。
mainnet・AI非EVM署名・bridge権限を追加しない。finalityProvenはfalseを維持。
現行のwallet/non-evm/controller.mjs、account-engine.mjs、account-network.mjs、records.mjs、およびdocs/v016を正本とする。会話の古い同名ZIP/件数は正本ではない。

優先課題は、固定した実Stellar Core/Horizonと実Aptos VMで今回のAPI適合・残高・署名・失敗を検証すること。次に独立state proofと、未解決sequenceの安全な復旧・期限切れ署名の扱い。Cosmosオンライン化、ICP認証付き決済、非EVM DEX/bridgeは別途。
全体依存/正式solc/実ブラウザ/Windows/OS鍵保護/独立監査も未達。合成HTTPの成功をruntime gateに置き換えない。
古いバックアップ、別端末、別財布まで重複署名を一括で防げるとは扱わない。未解決予約の消去や自動再署名を実装する前に脅威モデルと確定条件を決める。
