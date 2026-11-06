/** Deterministic PUBLIC test vectors for the independent Python/OpenSSL verifier. */
import {createHash} from 'node:crypto';
import {keyInfo,signDigest,base58Encode} from '../lib/keys.mjs';
import {signEvmTransaction,signSolanaTransfer,signIcrcTransfer} from '../lib/transactions.mjs';
const vectors={description:'Public deterministic test keys only; not usable wallets',ecdsa:[],evm:[],solana:[],icp:[]};
for(let i=1;i<=24;i++){
  const key=Buffer.alloc(32);key.writeUInt32BE(i,28);const digest=createHash('sha256').update('RealDEX independent vector '+i).digest(),sig=signDigest(key,digest,{extraEntropy:false});
  vectors.ecdsa.push({secret:key.toString('hex'),digest:digest.toString('hex'),signature:sig.toCompactHex(),recovery:sig.recovery,publicKey:keyInfo('evm',key).publicKeyHex});
  const type=i%2?0:2,tx={type,chainId:'31337',nonce:String(i),gasLimit:'50000',to:'0x'+'35'.repeat(20),value:String(BigInt(i)*1000000001n),data:'0x'+Buffer.from([i,0,255]).toString('hex'),...(type===0?{gasPrice:'2000000000'}:{maxPriorityFeePerGas:'1000000000',maxFeePerGas:'4000000000'})};
  vectors.evm.push({secret:key.toString('hex'),transaction:tx,signed:signEvmTransaction(key,tx,{extraEntropy:false})});
  const seed=Buffer.alloc(32,i),recipient=Buffer.alloc(32,i+30);const sol={from:keyInfo('solana',seed).address,to:keyInfo('solana',recipient).address,lamports:String(BigInt(i)*987654321n),recentBlockhash:base58Encode(Buffer.alloc(32,33))};
  vectors.solana.push({seed:seed.toString('hex'),input:sol,...signSolanaTransfer(seed,sol)});
  const transfer={fromSubaccount:'00'.repeat(32),to:{owner:keyInfo('icp',recipient).address,subaccount:'01'.repeat(32)},amountAtomic:String(BigInt(i)*9999n),feeAtomic:'10000',memoHex:Buffer.alloc(32,i).toString('hex'),createdAtTimeNs:String(1788560000000000000n+BigInt(i))};
  const input={ledger:'ryjl3-tyaaa-aaaaa-aaaba-cai',transfer,ingressExpiryNs:'1788560300000000000',nonceHex:'55'.repeat(32)};
  vectors.icp.push({seed:seed.toString('hex'),input,...signIcrcTransfer(seed,input)});
}
console.log(JSON.stringify(vectors,null,2));
