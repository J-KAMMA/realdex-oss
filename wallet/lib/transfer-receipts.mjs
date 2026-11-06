/** Receipt logs are observations, not proof of actual token balance changes or finality. */
import {keccak256} from '../../node/verified/keccak.mjs';
import {abiAddress} from './transactions.mjs';
const TRANSFER_TOPIC = keccak256(new TextEncoder().encode('Transfer(address,address,uint256)'));
export function transferReceiptObservation(record, receipt) {
  const result = {transactionReportedSuccessful: receipt.status === '0x1', finalityVerified: false,
    actualBalanceChangeVerified: false, matchingTransferEventObserved: null, observedEventAmountAtomic: null};
  if (record.summary.operation !== 'erc20-transfer') return result;
  result.matchingTransferEventObserved = false;
  if (receipt.status !== '0x1' || !Array.isArray(receipt.logs) || receipt.logs.length > 512) return result;
  const fromTopic = '0x' + abiAddress(record.summary.from), toTopic = '0x' + abiAddress(record.summary.recipient);
  let amount = 0n, found = false;
  for (const log of receipt.logs) {
    if (!log || log.removed === true || typeof log.address !== 'string' || log.address.toLowerCase() !== record.summary.to || !Array.isArray(log.topics) || log.topics.length !== 3 || !log.topics.every(t => typeof t === 'string')) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || log.topics[1]?.toLowerCase() !== fromTopic || log.topics[2]?.toLowerCase() !== toTopic) continue;
    if (typeof log.data !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) continue;
    amount += BigInt(log.data); found = true;
  }
  result.observedEventAmountAtomic = found ? String(amount) : null;
  result.matchingTransferEventObserved = found && amount === BigInt(record.summary.amountAtomic);
  return result;
}
