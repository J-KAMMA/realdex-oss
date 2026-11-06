/** Human amounts and payment URIs are interpreted on the signer side, never by an AI. */
import {need, shape, uint, quantity, q} from './guard.mjs';
import {address, selector} from '../../node/verified/keccak.mjs';
import {abiAddress, abiWord} from './transactions.mjs';

// Reuse the verified EIP-55/nonzero-address parser.
export const recipientAddress = raw => address(raw);
export function parseUnits(value, decimals) {
  need(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, 'TOKEN_DECIMALS_INVALID');
  need(typeof value === 'string' && value.length <= 116 && /^(0|[1-9][0-9]{0,77})(\.[0-9]+)?$/.test(value), 'AMOUNT_FORMAT_INVALID');
  const [whole, fraction = ''] = value.split('.');
  need(fraction.length <= decimals, 'AMOUNT_PRECISION_EXCEEDED');
  const n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  need(n > 0n && n < 2n ** 256n, 'AMOUNT_RANGE');
  return n.toString();
}
export function formatUnits(value, decimals) {
  uint(value); need(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36, 'TOKEN_DECIMALS_INVALID');
  if (!decimals) return value;
  const padded = value.padStart(decimals + 1, '0'), fraction = padded.slice(-decimals).replace(/0+$/, '');
  return padded.slice(0, -decimals) + (fraction ? '.' + fraction : '');
}
export function transferAsset(network, asset) {
  if (asset === 'native') return {asset, address: null, symbol: network.symbol, decimals: 18, runtimeHash: null};
  const addr = recipientAddress(asset), token = network.contracts.find(c => c.kind === 'erc20' && c.address === addr);
  need(token, 'TOKEN_NOT_IN_LOCAL_POLICY');
  return {asset: addr, address: addr, symbol: token.symbol, decimals: token.decimals, runtimeHash: token.runtimeHash};
}
export function transferRequest(network, account, input, {atomic = false} = {}) {
  shape(input, ['asset', 'recipient', atomic ? 'amountAtomic' : 'amount']);
  need(account.family === 'evm' && account.kind === 'local', 'EVM_LOCAL_ACCOUNT_REQUIRED');
  const asset = transferAsset(network, input.asset), recipient = recipientAddress(input.recipient);
  need(recipient !== account.address, 'SELF_TRANSFER_NOT_SUPPORTED');
  const amountAtomic = atomic ? String(uint(input.amountAtomic)) : parseUnits(input.amount, asset.decimals);
  need(BigInt(amountAtomic) > 0n, 'ZERO_TRANSFER');
  const transaction = asset.address ? {
    from: account.address, to: asset.address, value: '0x0',
    data: selector('transfer(address,uint256)') + abiAddress(recipient) + abiWord(amountAtomic),
  } : {from: account.address, to: recipient, value: quantity(BigInt(amountAtomic)), data: '0x'};
  return {transaction, transfer: {...asset, recipient, amountAtomic, amount: formatUnits(amountAtomic, asset.decimals)}};
}
export async function readTransferBalance(engine, network, account, assetName) {
  need(account.family === 'evm', 'BALANCE_ADAPTER_UNSUPPORTED');
  const asset = transferAsset(network, assetName), snap = await engine.rpc.snapshot(network, engine.now());
  const nativeAtomic = String(q(await engine.rpc.agree(network, 'eth_getBalance', [account.address, snap.ref])));
  uint(nativeAtomic);
  let atomic = nativeAtomic;
  if (asset.address) {
    await engine.rpc.verifyPins(network, [asset], snap.ref);
    const decimals = await engine.rpc.agree(network, 'eth_call', [{to: asset.address, data: selector('decimals()')}, snap.ref]);
    need(/^0x[0-9a-fA-F]{64}$/.test(decimals) && BigInt(decimals) === BigInt(asset.decimals), 'TOKEN_DECIMALS_CHANGED');
    const balance = await engine.rpc.agree(network, 'eth_call', [{to: asset.address, data: selector('balanceOf(address)') + abiAddress(account.address)}, snap.ref]);
    need(/^0x[0-9a-fA-F]{64}$/.test(balance), 'TOKEN_BALANCE_RESPONSE_INVALID');
    atomic = String(BigInt(balance));
  }
  return {...asset, tokenAddress: asset.address, accountId: account.id, address: account.address, chainId: network.chainId, genesisHash: network.genesisHash,
    atomic, amount: formatUnits(atomic, asset.decimals), nativeAtomic, nativeAmount: formatUnits(nativeAtomic, 18),
    blockHash: snap.hash, observedAt: engine.now(), assurance: 'RPC agreement, not certified balance or spendable guarantee'};
}
export function receiveRequest(network, account, input) {
  shape(input, ['asset'], ['amount']);
  need(account.family === 'evm', 'RECEIVE_URI_ADAPTER_UNSUPPORTED');
  const asset = transferAsset(network, input.asset), recipient = recipientAddress(account.address);
  const amountAtomic = input.amount === undefined || input.amount === '' ? null : parseUnits(input.amount, asset.decimals);
  let uri;
  if (!asset.address) uri = `ethereum:${recipient}@${network.chainId}` + (amountAtomic ? `?value=${amountAtomic}` : '');
  else uri = `ethereum:${asset.address}@${network.chainId}/transfer?address=${recipient}` + (amountAtomic ? `&uint256=${amountAtomic}` : '');
  return {uri, chainId: network.chainId, genesisHash: network.genesisHash, recipient, ...asset, amountAtomic,
    warning: 'Payment requests are untrusted suggestions; chain ID in URI does not authenticate the genesis hash.'};
}
/** Deliberately restricted ERC-681 subset: explicit chain, hex addresses, integer base units. */
export function parsePaymentRequest(network, uri) {
  need(typeof uri === 'string' && uri.length <= 1024, 'PAYMENT_URI_INVALID');
  const m = /^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})@([1-9][0-9]{0,77})(\/transfer)?(?:\?([^#]*))?$/.exec(uri);
  need(m, 'PAYMENT_URI_UNSUPPORTED'); need(m[2] === network.chainId, 'PAYMENT_URI_CHAIN_MISMATCH');
  const target = recipientAddress(m[1]), params = new URLSearchParams(m[4] ?? '');
  const keys = [...params.keys()]; need(new Set(keys).size === keys.length, 'PAYMENT_URI_DUPLICATE_FIELD');
  const token = !!m[3], allowed = token ? ['address', 'uint256'] : ['value'];
  need(keys.every(k => allowed.includes(k)), 'PAYMENT_URI_UNKNOWN_FIELD');
  const asset = transferAsset(network, token ? target : 'native');
  const recipient = token ? recipientAddress(params.get('address')) : target;
  const raw = params.get(token ? 'uint256' : 'value');
  const amountAtomic = raw === null ? null : String(uint(raw));
  need(amountAtomic === null || BigInt(amountAtomic) > 0n, 'ZERO_TRANSFER');
  return {...asset, recipient, chainId: network.chainId, amountAtomic,
    amount: amountAtomic === null ? '' : formatUnits(amountAtomic, asset.decimals), requiresUserReview: true};
}
