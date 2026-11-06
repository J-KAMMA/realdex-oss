/** Narrow XDR decoder for exactly one classic native Payment result.
 * No fee-bump/Soroban/result extensions. Unknown or malformed failures remain unresolved.
 * This validates response structure, NOT SCP consensus or the Horizon server's honesty.
 */
import {need,uint} from '../lib/guard.mjs';

export function decodeStellarPaymentResult(encoded, expectedFee, successful) {
  need(typeof encoded==='string' && encoded.length<=256 && typeof successful==='boolean', 'STELLAR_RESULT_XDR_INVALID');
  const bytes=Buffer.from(encoded,'base64');
  need(bytes.toString('base64')===encoded && bytes.length>=24 && bytes.length<=32, 'STELLAR_RESULT_XDR_INVALID');
  let offset=0;
  const i32=()=>{need(offset+4<=bytes.length,'STELLAR_RESULT_XDR_INVALID');const n=bytes.readInt32BE(offset);offset+=4;return n;};
  const fee=bytes.readBigInt64BE(0);offset=8;
  need(fee>0n && fee===uint(expectedFee,(1n<<63n)-1n),'STELLAR_RESULT_XDR_INVALID');
  const transactionCode=i32();
  // Only operation execution outcomes may finish this payment. Admission failures do not.
  need(transactionCode===0 || transactionCode===-1, 'STELLAR_RESULT_XDR_INVALID');
  need(i32()===1, 'STELLAR_RESULT_XDR_INVALID');
  const operationCode=i32(); let paymentCode=null;
  if(operationCode===0) {
    need(i32()===1, 'STELLAR_RESULT_XDR_INVALID'); // PAYMENT
    paymentCode=i32();
    need(paymentCode>=-9 && paymentCode<=0, 'STELLAR_RESULT_XDR_INVALID');
  } else {
    need(operationCode>=-6 && operationCode<=-1, 'STELLAR_RESULT_XDR_INVALID');
  }
  const actualSuccess=operationCode===0 && paymentCode===0;
  need(actualSuccess===(transactionCode===0) && successful===actualSuccess, 'STELLAR_RESULT_XDR_INVALID');
  need(i32()===0 && offset===bytes.length, 'STELLAR_RESULT_XDR_INVALID');
  return Object.freeze({feeAtomic:String(fee),transactionCode,operationCode,paymentCode,success:actualSuccess});
}
