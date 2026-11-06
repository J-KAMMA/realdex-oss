import { LocalWalletProvider, localWalletDetail, type RequestArguments } from '../public/provider.mjs';
const provider = new LocalWalletProvider({chainId:'0x7a69'});
const args: RequestArguments = {method:'eth_chainId',params:[]};
const result: Promise<unknown> = provider.request(args);
const detail = localWalletDetail(provider);
const listener = (...args: unknown[]): void => { void args; };
provider.on('accountsChanged',listener).removeListener('accountsChanged',listener);
const rdns: string = detail.info.rdns;
void result; void rdns;
// @ts-expect-error There is deliberately no raw-key export through the app provider.
provider.exportPrivateKey();
// @ts-expect-error The provider is not an unlock/password API.
provider.unlock('never-send-passwords-to-dapps');
provider.dispose();
