# Diagnostic IBC bridge execution

This harness starts two distinct single-validator Cosmos/IBC chains and creates real Tendermint clients, connection/channel handshakes, ICS-20 transfers, acknowledgements and timeout refunds. The relayer assembles actual committed state proofs; the destination/source IBC modules verify them. It is not a mock ledger, but it is also not a production relayer or a desktop light client.

See `pin.json` for the exact PR CI artifact and the extracted binary/loader hashes. `provision.py` performs offline extraction and validation. This is not a stable release endorsement or source-rebuild attestation.

```
python3 integration/ibc/provision.py --archive /path/to/RealDEX-IBC-Diagnostic-Toolchain-2026-09-06.zip --output /path/to/new/tools
export REALDEX_IBC_SIMD_BINARY=/path/to/new/tools/simd
export REALDEX_IBC_MUSL_LOADER=/path/to/new/tools/lib/ld-musl-x86_64.so.1
node integration/ibc/run.mjs --output /path/to/new/results
node integration/ibc/demo.mjs
node integration/ibc/interactive.mjs
```

The fixture uses known worthless account keys and a separate ephemeral relayer fee key. All temporary chain/vault directories are removed on normal completion. Never point the lab at a real wallet, live chain or real-asset key. Do not publish the owner capability printed by the interactive lab.

The tests cover native-to-voucher receipt, reverse redemption, malformed proof rejection, duplicate relay handling, nonreceipt timeout refunds, received packets being ineligible for timeout refund, application-error acknowledgement refunds, lost HTTP submission responses, persistence failure, lock cancellation and encrypted journal restoration.

Per-chain two HTTP views forward to the same node; there are two underlying chains, not four independent verifiers. Desktop events and state roots remain RPC observations with `finalityProven:false`. Only one relay message per transaction is parsed by the current owner observer. No automatic recovery resubmission or public-network gate is enabled.
