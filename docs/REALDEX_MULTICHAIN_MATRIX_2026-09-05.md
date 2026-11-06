# RealDEX v0.5 チェーン候補一覧

2026-09-05。138候補、15読み取り系統。**候補登録数は、稼働確認済みチェーン数でも、スワップ・ブリッジ対応数でもありません。** 名前・通貨・ネットワークIDは候補メタデータであり、停止・改称・仕様変更を含め、利用前の再確認が必要です。

EVMは89候補分の既存契約配置計画を生成しています。非EVM49候補は14系統の読み取り処理を実装した段階です。全候補で新規の実取引・デプロイ・受取検証は未確認。`source` 列付きCSVとJSONは出典の所在を記録しますが、全ネットワークの実機検証を証明しません。

EVMの `eip155:` 以外のキーは今回のRealDEXローカルキーです。すべてをCAIP-2として登録済みだと解釈しないでください。初期識別値の「任意」はその値が無意味という意味ではなく、実装が別のネットワーク識別値も照合するという意味です。

| ローカルチェーンキー | 名称 | 系統 | 環境候補 | 初期識別値の指定 | 実チェーン照合 | 新規実行 | 契約 |
|---|---|---|---|---|---|---|---|
| eip155:1 | Ethereum | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:10 | Optimism | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:56 | BNB Smart Chain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:137 | Polygon PoS | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:42161 | Arbitrum One | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:43114 | Avalanche C-Chain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:8453 | Base | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:100 | Gnosis | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:42220 | Celo | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:250 | Fantom Opera | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1284 | Moonbeam | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1285 | Moonriver | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:8217 | Kaia | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:25 | Cronos | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1313161554 | Aurora | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:5000 | Mantle | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:59144 | Linea | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:534352 | Scroll | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:324 | ZKsync Era | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1101 | Polygon zkEVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:204 | opBNB | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:167000 | Taiko | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:81457 | Blast | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:34443 | Mode | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:169 | Manta Pacific | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1088 | Metis | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:7777777 | Zora | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:252 | Fraxtal | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:80094 | Berachain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:146 | Sonic | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:480 | World Chain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:57073 | Ink | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:130 | Unichain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:33139 | ApeChain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:2741 | Abstract | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1329 | Sei EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:660279 | Xai | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:88888 | Chiliz | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1116 | Core | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1111 | WEMIX | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:2222 | Kava EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:9001 | Evmos | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:23294 | Oasis Sapphire | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:42262 | Oasis Emerald | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:40 | Telos EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:122 | Fuse | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:288 | Boba | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:592 | Astar EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:336 | Shiden EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:888 | Wanchain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:196 | X Layer | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:314 | Filecoin EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:14 | Flare | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:19 | Songbird | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:8822 | IOTA EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:148 | Shimmer EVM | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:30 | Rootstock | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1666600000 | Harmony Shard 0 | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:4689 | IoTeX | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:106 | Velas | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:50 | XDC Network | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:61 | Ethereum Classic | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:57 | Syscoin | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:2000 | Dogechain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:7000 | ZetaChain | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:4337 | Beam | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:21000000 | Corn | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:60808 | BOB | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:200901 | Bitlayer | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:4200 | Merlin | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:223 | B2 Network | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:16718 | AirDAO | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1625 | Gravity Alpha | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:109 | Shibarium | evm | mainnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:11155111 | Ethereum Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:84532 | Base Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:421614 | Arbitrum Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:11155420 | Optimism Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:97 | BSC Testnet | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:80002 | Polygon Amoy | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:43113 | Avalanche Fuji | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1001 | Kaia Kairos | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:1287 | Moonbase Alpha | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:5003 | Mantle Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:59141 | Linea Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:534351 | Scroll Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:300 | ZKsync Sepolia | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:10143 | Monad Testnet | evm | testnet | 任意 | 未確認 | 不可 | 配置計画あり |
| eip155:31337 | Local EVM | evm | local | 任意 | 未確認 | 不可 | 配置計画あり |
| solana:mainnet-beta | Solana | solana | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| solana:devnet | Solana Devnet | solana | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| solana:testnet | Solana Testnet | solana | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:cosmoshub-4 | Cosmos Hub | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:osmosis-1 | Osmosis | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:noble-1 | Noble | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:neutron-1 | Neutron | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:stride-1 | Stride | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:juno-1 | Juno | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:stargaze-1 | Stargaze | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:injective-1 | Injective | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:axelar-dojo-1 | Axelar | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:phoenix-1 | Terra | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:pacific-1 | Sei Cosmos | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:celestia | Celestia | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:akashnet-2 | Akash | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:secret-4 | Secret Network | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| cosmos:dydx-mainnet-1 | dYdX | cosmos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| aptos:1 | Aptos Mainnet | aptos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| aptos:2 | Aptos Testnet | aptos | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| sui:35834a8a | Sui Mainnet | sui | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| sui:4c78adac | Sui Testnet | sui | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| near:mainnet | NEAR mainnet | near | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| near:testnet | NEAR testnet | near | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| bitcoin:main | Bitcoin | bitcoin | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| bitcoin:test | Bitcoin Testnet3 | bitcoin | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| bitcoin:testnet4 | Bitcoin Testnet4 | bitcoin | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| bitcoin:signet | Bitcoin Signet | bitcoin | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| bitcoin:regtest | Bitcoin Regtest | bitcoin | local | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| stellar:public | Stellar public | stellar | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| stellar:testnet | Stellar testnet | stellar | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| xrpl:mainnet | XRP Ledger mainnet | xrpl | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| xrpl:testnet | XRP Ledger testnet | xrpl | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| xrpl:devnet | XRP Ledger devnet | xrpl | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| substrate:polkadot | Polkadot | substrate | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| substrate:kusama | Kusama | substrate | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| substrate:westend | Westend | substrate | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| substrate:polkadot-asset-hub | Polkadot Asset Hub | substrate | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| algorand:mainnet-v1.0 | Algorand mainnet-v1.0 | algorand | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| algorand:testnet-v1.0 | Algorand testnet-v1.0 | algorand | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| algorand:betanet-v1.0 | Algorand betanet-v1.0 | algorand | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| starknet:mainnet | Starknet mainnet | starknet | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| starknet:sepolia | Starknet sepolia | starknet | testnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| tezos:mainnet | Tezos | tezos | mainnet | 任意 | 未確認 | 不可 | 専用Pool未実装 |
| tron:mainnet | TRON mainnet | tron | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| tron:nile | TRON nile | tron | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| tron:shasta | TRON shasta | tron | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| ton:mainnet | TON mainnet | ton | mainnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
| ton:testnet | TON testnet | ton | testnet | 必須 | 未確認 | 不可 | 専用Pool未実装 |
