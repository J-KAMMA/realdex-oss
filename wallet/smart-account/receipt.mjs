/** An account event is an RPC observation, not a finality or token-balance proof. */
import {keccak256} from '../../node/verified/keccak.mjs';
import {abiWord,abiAddress} from '../lib/transactions.mjs';
import {need} from '../lib/guard.mjs';
const topic=s=>keccak256(Buffer.from(s));
export function smartReceiptObservation(record,receipt){
  if(!record.summary.smart)return {};
  const {descriptor:d,operation:op,callsHash}=record.summary.smart;
  let expected=null;
  const addr=a=>'0x'+abiAddress(a),u=n=>'0x'+abiWord(n);
  if(op.type==='batch')expected={address:d.address,topics:[topic('BatchExecuted(uint256,bytes32)'),u(op.expectedNonce)],data:callsHash};
  if(op.type==='deploy')expected={address:d.factory,topics:[topic('AccountCreated(address,address,bytes32)'),addr(d.address),addr(op.owner)],data:op.salt};
  if(op.type==='session-transfer')expected={address:d.address,topics:[topic('SessionSpent(address,address,address,uint256,uint256,uint256)'),addr(op.key)],data:'0x'+abiWord(op.generation)+abiWord(op.sessionNonce)+abiWord(op.amountAtomic),topicPrefix:true};
  let matching=false;
  if(receipt.status==='0x1'&&expected){
    const logs=receipt.logs.filter(l=>l.address.toLowerCase()===expected.address&&l.topics[0]?.toLowerCase()===expected.topics[0]);
    need(logs.length===1,'SMART_EXECUTION_EVENT_MISSING');const log=logs[0];
    need(expected.topics.every((t,i)=>log.topics[i]?.toLowerCase()===t.toLowerCase())&&log.topics.length===(expected.topicPrefix?4:expected.topics.length)&&log.data.toLowerCase()===expected.data.toLowerCase(),'SMART_EXECUTION_EVENT_MISMATCH');matching=true;
  }
  return {smartAccount: d.address,smartOperation:op.type,smartExecutionEventObserved:matching,
    smartAssetBalanceChangeVerified:false,accountFundingReported:op.type==='fund'&&receipt.status==='0x1',smartFinalityProven:false};
}
