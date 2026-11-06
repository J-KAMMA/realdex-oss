import type {CosmosNetwork,CosmosPrepare,CosmosObservation} from '../non-evm/cosmos-api.d.ts';
const r:CosmosPrepare={accountId:'uuid',networkId:'cosmos:realdex-local-dev',payment:{requestKey:'intent',to:'cosmos...',amount:'1.25',feeAtomic:'500',gasLimit:'200000'}};
const p:CosmosObservation={observedAt:123,received:false,reason:'observation',assurance:'RPC only',finalityProven:false};
// @ts-expect-error This local API does not accept Cosmos Hub as a signing network.
const bad:CosmosNetwork['id']='cosmos:cosmoshub-4';
// @ts-expect-error RPC observations cannot certify finality.
p.finalityProven=true;
// @ts-expect-error Amount must be decimal text, never binary floating point.
r.payment.amount=1.25;
void r;void p;void bad;
