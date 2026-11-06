import type {BitcoinPayment,BitcoinPrepare,BitcoinOwnerRoutes} from '../non-evm/bitcoin-api';
const payment:BitcoinPayment={requestKey:'invoice-1',to:'bcrt1...',amount:'0.001',feeAtomic:'1000',maxFeeRateSatVb:'50',utxos:[]};
const prepare:BitcoinPrepare={accountId:'id',networkId:'bitcoin:regtest',payment};
const route:BitcoinOwnerRoutes['non-evm/bitcoin-online/prepare']=prepare;
// @ts-expect-error Amounts are never floating-point numbers.
const invalid:BitcoinPayment={...payment,amount:0.001};
// @ts-expect-error No ambiguous dual amount representation.
const ambiguous:BitcoinPayment={...payment,amountAtomic:'100000'};
void [route,invalid,ambiguous];
