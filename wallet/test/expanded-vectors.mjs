/** Public, deterministic TEST keys only. Never read a user's wallet or configuration. */
import {keyInfo} from '../lib/keys.mjs';
import {decodeWitnessAddress} from '../codec/bech32.mjs';
import {prepareBitcoinOffline,signBitcoinPayment} from '../non-evm/bitcoin-offline.mjs';
import {prepareCosmosOffline,signCosmosPayment} from '../non-evm/cosmos-offline.mjs';
import {prepareStellarOffline,signStellarPayment,STELLAR_LOCAL_PASSPHRASE} from '../non-evm/stellar-offline.mjs';
import {prepareAptosOffline,signAptosPayment} from '../non-evm/aptos-offline.mjs';
const now=1800000000000,rows=[];
for(let k=1;k<=12;k++)for(const family of ['bitcoin','cosmos','stellar','aptos']){
  const secret=Buffer.alloc(32,k),a={...keyInfo(family,secret),id:'11111111-1111-4111-a111-111111111111',kind:'local'},to=keyInfo(family,Buffer.alloc(32,k+40)).address;
  const r={requestKey:'reference-'+family+'-'+k,to,amountAtomic:String(100000+k*123),acknowledgeUnverifiedState:true};
  let prepare,sign;
  if(family==='bitcoin'){Object.assign(r,{networkId:'bitcoin:regtest',feeAtomic:String(1000+k),maxFeeRateSatVb:'100',utxos:Array.from({length:k%3+1},(_,i)=>({txid:Buffer.alloc(32,k+i).toString('hex'),vout:i,amountAtomic:String(200000+k*10),scriptHex:'0014'+decodeWitnessAddress(a.address).toString('hex')}))});prepare=prepareBitcoinOffline;sign=signBitcoinPayment;}
  if(family==='cosmos'){Object.assign(r,{chainId:'realdex-local-reference',hrp:'cosmos',denom:'utest',feeDenom:k%2?'utest':'uother',feeAtomic:String(2000+k),gasLimit:'200000',accountNumber:String(9007199254740993n+BigInt(k)),sequence:String(k),timeoutHeight:'1000',memo:k%2?'日本語 '+k:''});prepare=prepareCosmosOffline;sign=signCosmosPayment;}
  if(family==='stellar'){Object.assign(r,{networkPassphrase:STELLAR_LOCAL_PASSPHRASE,feeAtomic:String(100+k),sequence:String(9007199254740993n+BigInt(k)),maxTime:String(now/1000+180),memo:k%2?'日本語 '+k:''});prepare=prepareStellarOffline;sign=signStellarPayment;}
  if(family==='aptos'){Object.assign(r,{chainId:4,sequence:String(9007199254740993n+BigInt(k)),maxGasAmount:'2000',gasUnitPrice:String(100+k),expirationTimestampSecs:String(now/1000+180)});prepare=prepareAptosOffline;sign=signAptosPayment;}
  const intent=prepare(a,r,now),signed=sign(secret,intent.payment);secret.fill(0);rows.push({family,payment:intent.payment,summary:intent.summary,signed});
}
console.log(JSON.stringify({schema:'realdex.public-test-vectors.v014',vectors:rows}));
