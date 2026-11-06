import {AgentWalletClient, type AgentTransfer, type AgentPaymentResult} from '../agent/client.mjs';
const client = new AgentWalletClient({token:'example-token-only-not-executed'});
const request: AgentTransfer = {idempotencyKey:'invoice-001',recipient:'0x3535353535353535353535353535353535353535',amountAtomic:'1000000'};
const promise: Promise<AgentPaymentResult> = client.transfer(request);
const refreshed = client.result('invoice-001', {refresh:true});
const history = client.history(); void promise; void refreshed; void history;
// @ts-expect-error AI is not allowed to unlock a wallet.
client.unlock('not-a-password');
// @ts-expect-error AI has no key export function.
client.exportPrivateKey();
// @ts-expect-error Integer atomic amounts must be strings, not floating point numbers.
client.transfer({...request,amountAtomic:1});
// @ts-expect-error There is no raw calldata argument on the transfer interface.
client.transfer({...request,data:'0x'});
// @ts-expect-error Receipt refresh is a boolean, not a string.
client.result('invoice-001',{refresh:'yes'});
client.destroy();

const preview = client.preview(request); void preview;
