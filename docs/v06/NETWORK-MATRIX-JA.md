# RealDEX v0.6 ネットワーク候補一覧

**164件は接続候補の重複除外件数です。実スワップ・ブリッジ対応件数ではありません。**
旧138＋追加28−重複2。ICP台帳9個は別集計。私設ネットワークは任意設定で追加し、この件数に含めていません。

## v0.6拡張の28候補

| 名前 | ID | 接続系統 | 環境 | 申告上のプライバシー方式 |
|---|---|---|---|---|
| Internet Computer | `icp:mainnet` | icp | mainnet | public |
| ICP local development instance | `icp:local-development` | icp | local | public |
| Monero mainnet | `monero:mainnet` | monero | mainnet | shielded |
| Monero testnet | `monero:testnet` | monero | testnet | shielded |
| Monero stagenet | `monero:stagenet` | monero | testnet | shielded |
| Zcash mainnet | `zcash:mainnet` | utxo-core | mainnet | optional-shielded |
| Zcash testnet | `zcash:testnet` | utxo-core | testnet | optional-shielded |
| Zcash regtest | `zcash:regtest` | utxo-core | local | optional-shielded |
| Dash Core mainnet | `dash:mainnet` | utxo-core | mainnet | public |
| Dash Core testnet | `dash:testnet` | utxo-core | testnet | public |
| Dash Core regtest | `dash:regtest` | utxo-core | local | public |
| Litecoin mainnet | `litecoin:mainnet` | utxo-core | mainnet | optional-shielded |
| Litecoin testnet | `litecoin:testnet` | utxo-core | testnet | optional-shielded |
| Litecoin regtest | `litecoin:regtest` | utxo-core | local | optional-shielded |
| Dogecoin mainnet | `dogecoin:mainnet` | utxo-core | mainnet | public |
| Dogecoin testnet | `dogecoin:testnet` | utxo-core | testnet | public |
| Dogecoin regtest | `dogecoin:regtest` | utxo-core | local | public |
| Bitcoin Cash Node mainnet | `bitcoin-cash:mainnet` | utxo-core | mainnet | public |
| Bitcoin Cash Node testnet | `bitcoin-cash:testnet` | utxo-core | testnet | public |
| Bitcoin Cash Node regtest | `bitcoin-cash:regtest` | utxo-core | local | public |
| Secret Network | `cosmos:secret-4` | cometbft | mainnet | confidential-contracts |
| Secret Network Pulsar-3 | `cosmos:pulsar-3` | cometbft | testnet | confidential-contracts |
| Namada | `namada:mainnet` | cometbft | mainnet | optional-shielded |
| Namada Housefire | `namada:housefire` | cometbft | testnet | optional-shielded |
| Penumbra | `penumbra:mainnet` | cometbft | mainnet | shielded |
| Penumbra Phobos-3 | `penumbra:phobos-3` | cometbft | testnet | shielded |
| Oasis Sapphire | `eip155:23294` | evm | mainnet | confidential-contracts |
| Oasis Sapphire Testnet | `eip155:23295` | evm | testnet | confidential-contracts |

## 重複除外の全候補

| 名前 | ID | 系統 | 環境 | 今回の追加層あり |
|---|---|---|---|---|
| Algorand betanet-v1.0 | `algorand:betanet-v1.0` | algorand | testnet | 旧版維持 |
| Algorand mainnet-v1.0 | `algorand:mainnet-v1.0` | algorand | mainnet | 旧版維持 |
| Algorand testnet-v1.0 | `algorand:testnet-v1.0` | algorand | testnet | 旧版維持 |
| Aptos Mainnet | `aptos:1` | aptos | mainnet | 旧版維持 |
| Aptos Testnet | `aptos:2` | aptos | testnet | 旧版維持 |
| Bitcoin Cash Node mainnet | `bitcoin-cash:mainnet` | utxo-core | mainnet | あり |
| Bitcoin Cash Node regtest | `bitcoin-cash:regtest` | utxo-core | local | あり |
| Bitcoin Cash Node testnet | `bitcoin-cash:testnet` | utxo-core | testnet | あり |
| Bitcoin | `bitcoin:main` | bitcoin | mainnet | 旧版維持 |
| Bitcoin Regtest | `bitcoin:regtest` | bitcoin | local | 旧版維持 |
| Bitcoin Signet | `bitcoin:signet` | bitcoin | testnet | 旧版維持 |
| Bitcoin Testnet3 | `bitcoin:test` | bitcoin | testnet | 旧版維持 |
| Bitcoin Testnet4 | `bitcoin:testnet4` | bitcoin | testnet | 旧版維持 |
| Akash | `cosmos:akashnet-2` | cosmos | mainnet | 旧版維持 |
| Axelar | `cosmos:axelar-dojo-1` | cosmos | mainnet | 旧版維持 |
| Celestia | `cosmos:celestia` | cosmos | mainnet | 旧版維持 |
| Cosmos Hub | `cosmos:cosmoshub-4` | cosmos | mainnet | 旧版維持 |
| dYdX | `cosmos:dydx-mainnet-1` | cosmos | mainnet | 旧版維持 |
| Injective | `cosmos:injective-1` | cosmos | mainnet | 旧版維持 |
| Juno | `cosmos:juno-1` | cosmos | mainnet | 旧版維持 |
| Neutron | `cosmos:neutron-1` | cosmos | mainnet | 旧版維持 |
| Noble | `cosmos:noble-1` | cosmos | mainnet | 旧版維持 |
| Osmosis | `cosmos:osmosis-1` | cosmos | mainnet | 旧版維持 |
| Sei Cosmos | `cosmos:pacific-1` | cosmos | mainnet | 旧版維持 |
| Terra | `cosmos:phoenix-1` | cosmos | mainnet | 旧版維持 |
| Secret Network Pulsar-3 | `cosmos:pulsar-3` | cometbft | testnet | あり |
| Secret Network | `cosmos:secret-4` | cometbft | mainnet | あり |
| Stargaze | `cosmos:stargaze-1` | cosmos | mainnet | 旧版維持 |
| Stride | `cosmos:stride-1` | cosmos | mainnet | 旧版維持 |
| Dash Core mainnet | `dash:mainnet` | utxo-core | mainnet | あり |
| Dash Core regtest | `dash:regtest` | utxo-core | local | あり |
| Dash Core testnet | `dash:testnet` | utxo-core | testnet | あり |
| Dogecoin mainnet | `dogecoin:mainnet` | utxo-core | mainnet | あり |
| Dogecoin regtest | `dogecoin:regtest` | utxo-core | local | あり |
| Dogecoin testnet | `dogecoin:testnet` | utxo-core | testnet | あり |
| Ethereum | `eip155:1` | evm | mainnet | 旧版維持 |
| Optimism | `eip155:10` | evm | mainnet | 旧版維持 |
| Gnosis | `eip155:100` | evm | mainnet | 旧版維持 |
| Kaia Kairos | `eip155:1001` | evm | testnet | 旧版維持 |
| Monad Testnet | `eip155:10143` | evm | testnet | 旧版維持 |
| Velas | `eip155:106` | evm | mainnet | 旧版維持 |
| Metis | `eip155:1088` | evm | mainnet | 旧版維持 |
| Shibarium | `eip155:109` | evm | mainnet | 旧版維持 |
| Polygon zkEVM | `eip155:1101` | evm | mainnet | 旧版維持 |
| WEMIX | `eip155:1111` | evm | mainnet | 旧版維持 |
| Ethereum Sepolia | `eip155:11155111` | evm | testnet | 旧版維持 |
| Optimism Sepolia | `eip155:11155420` | evm | testnet | 旧版維持 |
| Core | `eip155:1116` | evm | mainnet | 旧版維持 |
| Fuse | `eip155:122` | evm | mainnet | 旧版維持 |
| Moonbeam | `eip155:1284` | evm | mainnet | 旧版維持 |
| Moonriver | `eip155:1285` | evm | mainnet | 旧版維持 |
| Moonbase Alpha | `eip155:1287` | evm | testnet | 旧版維持 |
| Unichain | `eip155:130` | evm | mainnet | 旧版維持 |
| Aurora | `eip155:1313161554` | evm | mainnet | 旧版維持 |
| Sei EVM | `eip155:1329` | evm | mainnet | 旧版維持 |
| Polygon PoS | `eip155:137` | evm | mainnet | 旧版維持 |
| Flare | `eip155:14` | evm | mainnet | 旧版維持 |
| Sonic | `eip155:146` | evm | mainnet | 旧版維持 |
| Shimmer EVM | `eip155:148` | evm | mainnet | 旧版維持 |
| Gravity Alpha | `eip155:1625` | evm | mainnet | 旧版維持 |
| Harmony Shard 0 | `eip155:1666600000` | evm | mainnet | 旧版維持 |
| Taiko | `eip155:167000` | evm | mainnet | 旧版維持 |
| AirDAO | `eip155:16718` | evm | mainnet | 旧版維持 |
| Manta Pacific | `eip155:169` | evm | mainnet | 旧版維持 |
| Songbird | `eip155:19` | evm | mainnet | 旧版維持 |
| X Layer | `eip155:196` | evm | mainnet | 旧版維持 |
| Dogechain | `eip155:2000` | evm | mainnet | 旧版維持 |
| Bitlayer | `eip155:200901` | evm | mainnet | 旧版維持 |
| opBNB | `eip155:204` | evm | mainnet | 旧版維持 |
| Corn | `eip155:21000000` | evm | mainnet | 旧版維持 |
| Kava EVM | `eip155:2222` | evm | mainnet | 旧版維持 |
| B2 Network | `eip155:223` | evm | mainnet | 旧版維持 |
| Oasis Sapphire | `eip155:23294` | evm | mainnet | あり |
| Oasis Sapphire Testnet | `eip155:23295` | evm | testnet | あり |
| Cronos | `eip155:25` | evm | mainnet | 旧版維持 |
| Fantom Opera | `eip155:250` | evm | mainnet | 旧版維持 |
| Fraxtal | `eip155:252` | evm | mainnet | 旧版維持 |
| Abstract | `eip155:2741` | evm | mainnet | 旧版維持 |
| Boba | `eip155:288` | evm | mainnet | 旧版維持 |
| Rootstock | `eip155:30` | evm | mainnet | 旧版維持 |
| ZKsync Sepolia | `eip155:300` | evm | testnet | 旧版維持 |
| Local EVM | `eip155:31337` | evm | local | 旧版維持 |
| Filecoin EVM | `eip155:314` | evm | mainnet | 旧版維持 |
| ZKsync Era | `eip155:324` | evm | mainnet | 旧版維持 |
| ApeChain | `eip155:33139` | evm | mainnet | 旧版維持 |
| Shiden EVM | `eip155:336` | evm | mainnet | 旧版維持 |
| Mode | `eip155:34443` | evm | mainnet | 旧版維持 |
| Telos EVM | `eip155:40` | evm | mainnet | 旧版維持 |
| Merlin | `eip155:4200` | evm | mainnet | 旧版維持 |
| Arbitrum One | `eip155:42161` | evm | mainnet | 旧版維持 |
| Arbitrum Sepolia | `eip155:421614` | evm | testnet | 旧版維持 |
| Celo | `eip155:42220` | evm | mainnet | 旧版維持 |
| Oasis Emerald | `eip155:42262` | evm | mainnet | 旧版維持 |
| Avalanche Fuji | `eip155:43113` | evm | testnet | 旧版維持 |
| Avalanche C-Chain | `eip155:43114` | evm | mainnet | 旧版維持 |
| Beam | `eip155:4337` | evm | mainnet | 旧版維持 |
| IoTeX | `eip155:4689` | evm | mainnet | 旧版維持 |
| World Chain | `eip155:480` | evm | mainnet | 旧版維持 |
| XDC Network | `eip155:50` | evm | mainnet | 旧版維持 |
| Mantle | `eip155:5000` | evm | mainnet | 旧版維持 |
| Mantle Sepolia | `eip155:5003` | evm | testnet | 旧版維持 |
| Scroll Sepolia | `eip155:534351` | evm | testnet | 旧版維持 |
| Scroll | `eip155:534352` | evm | mainnet | 旧版維持 |
| BNB Smart Chain | `eip155:56` | evm | mainnet | 旧版維持 |
| Syscoin | `eip155:57` | evm | mainnet | 旧版維持 |
| Ink | `eip155:57073` | evm | mainnet | 旧版維持 |
| Linea Sepolia | `eip155:59141` | evm | testnet | 旧版維持 |
| Linea | `eip155:59144` | evm | mainnet | 旧版維持 |
| Astar EVM | `eip155:592` | evm | mainnet | 旧版維持 |
| BOB | `eip155:60808` | evm | mainnet | 旧版維持 |
| Ethereum Classic | `eip155:61` | evm | mainnet | 旧版維持 |
| Xai | `eip155:660279` | evm | mainnet | 旧版維持 |
| ZetaChain | `eip155:7000` | evm | mainnet | 旧版維持 |
| Zora | `eip155:7777777` | evm | mainnet | 旧版維持 |
| Polygon Amoy | `eip155:80002` | evm | testnet | 旧版維持 |
| Berachain | `eip155:80094` | evm | mainnet | 旧版維持 |
| Blast | `eip155:81457` | evm | mainnet | 旧版維持 |
| Kaia | `eip155:8217` | evm | mainnet | 旧版維持 |
| Base | `eip155:8453` | evm | mainnet | 旧版維持 |
| Base Sepolia | `eip155:84532` | evm | testnet | 旧版維持 |
| IOTA EVM | `eip155:8822` | evm | mainnet | 旧版維持 |
| Wanchain | `eip155:888` | evm | mainnet | 旧版維持 |
| Chiliz | `eip155:88888` | evm | mainnet | 旧版維持 |
| Evmos | `eip155:9001` | evm | mainnet | 旧版維持 |
| BSC Testnet | `eip155:97` | evm | testnet | 旧版維持 |
| ICP local development instance | `icp:local-development` | icp | local | あり |
| Internet Computer | `icp:mainnet` | icp | mainnet | あり |
| Litecoin mainnet | `litecoin:mainnet` | utxo-core | mainnet | あり |
| Litecoin regtest | `litecoin:regtest` | utxo-core | local | あり |
| Litecoin testnet | `litecoin:testnet` | utxo-core | testnet | あり |
| Monero mainnet | `monero:mainnet` | monero | mainnet | あり |
| Monero stagenet | `monero:stagenet` | monero | testnet | あり |
| Monero testnet | `monero:testnet` | monero | testnet | あり |
| Namada Housefire | `namada:housefire` | cometbft | testnet | あり |
| Namada | `namada:mainnet` | cometbft | mainnet | あり |
| NEAR mainnet | `near:mainnet` | near | mainnet | 旧版維持 |
| NEAR testnet | `near:testnet` | near | testnet | 旧版維持 |
| Penumbra | `penumbra:mainnet` | cometbft | mainnet | あり |
| Penumbra Phobos-3 | `penumbra:phobos-3` | cometbft | testnet | あり |
| Solana Devnet | `solana:devnet` | solana | testnet | 旧版維持 |
| Solana | `solana:mainnet-beta` | solana | mainnet | 旧版維持 |
| Solana Testnet | `solana:testnet` | solana | testnet | 旧版維持 |
| Starknet mainnet | `starknet:mainnet` | starknet | mainnet | 旧版維持 |
| Starknet sepolia | `starknet:sepolia` | starknet | testnet | 旧版維持 |
| Stellar public | `stellar:public` | stellar | mainnet | 旧版維持 |
| Stellar testnet | `stellar:testnet` | stellar | testnet | 旧版維持 |
| Kusama | `substrate:kusama` | substrate | mainnet | 旧版維持 |
| Polkadot | `substrate:polkadot` | substrate | mainnet | 旧版維持 |
| Polkadot Asset Hub | `substrate:polkadot-asset-hub` | substrate | mainnet | 旧版維持 |
| Westend | `substrate:westend` | substrate | testnet | 旧版維持 |
| Sui Mainnet | `sui:35834a8a` | sui | mainnet | 旧版維持 |
| Sui Testnet | `sui:4c78adac` | sui | testnet | 旧版維持 |
| Tezos | `tezos:mainnet` | tezos | mainnet | 旧版維持 |
| TON mainnet | `ton:mainnet` | ton | mainnet | 旧版維持 |
| TON testnet | `ton:testnet` | ton | testnet | 旧版維持 |
| TRON mainnet | `tron:mainnet` | tron | mainnet | 旧版維持 |
| TRON nile | `tron:nile` | tron | testnet | 旧版維持 |
| TRON shasta | `tron:shasta` | tron | testnet | 旧版維持 |
| XRP Ledger devnet | `xrpl:devnet` | xrpl | testnet | 旧版維持 |
| XRP Ledger mainnet | `xrpl:mainnet` | xrpl | mainnet | 旧版維持 |
| XRP Ledger testnet | `xrpl:testnet` | xrpl | testnet | 旧版維持 |
| Zcash mainnet | `zcash:mainnet` | utxo-core | mainnet | あり |
| Zcash regtest | `zcash:regtest` | utxo-core | local | あり |
| Zcash testnet | `zcash:testnet` | utxo-core | testnet | あり |
