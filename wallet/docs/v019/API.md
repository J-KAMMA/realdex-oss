# Owner-only Injective local API

全endpointは既存 `/api/` owner capability、same-origin、loopback HTTPの内側だけで利用する。agent/dapp bridgeには公開しない。

| Route | Input | Meaning |
| --- | --- | --- |
| `POST /api/non-evm/injective/prepare` | `{accountId, review}` | 完全preflightを再検査しowner pending requestを作る。署名・送信なし |
| `POST /api/non-evm/approve` | `{id,intentId,confirmation:reviewSha256,broadcast:false}` | 署名済みTxRawを暗号化保存。ネットワーク送信なし |
| `POST /api/non-evm/injective/submit` | `{id,confirmation:txHash}` | `signed` recordだけを一度送る。先に`broadcast-unknown`を保存 |
| `POST /api/non-evm/injective/reconcile` | `{id}` | 保存済みtx hashを読み取り照合。再送なし |
| `POST /api/non-evm/history` | `{}` | Injective recordを他のowner-only非EVM履歴と統合表示 |

`broadcast:true` をapprovalへ付けてもInjectiveでは拒否する。`submit` は `signed` 以外から呼べず、`broadcast-unknown`/`broadcast`/terminal recordの再送は拒否する。
