/** Synthetic RPC fixture: intentionally not a Solana execution runtime. */
import {storeFixture,PASSWORD} from './fixtures.mjs';
import {Vault} from '../lib/vault.mjs';
import {keyInfo,base58Encode} from '../lib/keys.mjs';
import {SolanaEngine} from '../non-evm/solana-engine.mjs';
import {validateSolanaNetwork} from '../non-evm/solana-network.mjs';
export const SOL_SEED='2a'.repeat(32), SOL_TO=keyInfo('solana',Buffer.alloc(32,43)).address;
export const SOL_NETWORK=validateSolanaNetwork({family:'solana',id:'solana-local:unit',name:'Synthetic only',cluster:'localnet',rpcUrls:['http://127.0.0.1:1/','http://127.0.0.1:2/'],genesisHash:base58Encode(Buffer.alloc(32,9)),maxFeeLamports:'10000',maxTransferLamports:'1000000000',broadcastEnabled:true});
const system=(lamports)=>({lamports,owner:'11111111111111111111111111111111',executable:false,data:['','base64'],rentEpoch:18446744073709551615});
export class FakeSolanaRpc {
  constructor(){this.block=base58Encode(Buffer.alloc(32,8));this.height=10;this.last=160;this.slot=10;this.source=1000000000;this.dest=1000000;this.fee=5000;this.valid=true;this.calls=[];this.status=null;this.tx=null;this.delay=null;this.mutate=null;this.sent=0;this.drop=false;}
  async call(url,method,params){this.calls.push({url,method,params});if(this.delay)await this.delay(method);
    const ctx=value=>({context:{slot:this.slot},value});let r;
    switch(method){
      case 'getGenesisHash':r=SOL_NETWORK.genesisHash;break;
      case 'getHealth':r='ok';break;
      case 'getLatestBlockhash':r=ctx({blockhash:this.block,lastValidBlockHeight:this.last});break;
      case 'getBlockHeight':r=this.height;break;
      case 'isBlockhashValid':r=ctx(this.valid);break;
      case 'getBalance':r=ctx(this.source);break;
      case 'getMultipleAccounts':r=ctx([system(this.source),system(this.dest)]);break;
      case 'getFeeForMessage':r=ctx(this.fee);break;
      case 'simulateTransaction':{const raw=Buffer.from(params[0],'base64');const amount=Number(raw.readBigUInt64LE(207));r=ctx({err:null,accounts:[system(this.source-amount-this.fee),system(this.dest+amount)]});break;}
      case 'sendTransaction':{this.sent++;if(this.drop)throw Error('RPC_TRANSPORT_UNCERTAIN');r=base58Encode(Buffer.from(params[0],'base64').subarray(1,65));break;}
      case 'getSignatureStatuses':r=ctx([this.status]);break;
      case 'getTransaction':r=this.tx;break;
      default:throw Error('FAKE_METHOD_UNSUPPORTED');
    }
    return this.mutate?this.mutate(r,method,url):r;
  }
  async all(n,m,p){return Promise.all(n.rpcUrls.map(u=>this.call(u,m,p)));}
}
export async function solFixture(){const f=storeFixture(),now={value:Date.now()},vault=new Vault(f.store,{now:()=>now.value});await vault.create(PASSWORD);const account=await vault.addAccount({family:'solana',label:'unit',secretHex:SOL_SEED});const b=await vault.backup();await vault.verifyBackup(b.encrypted,PASSWORD);const rpc=new FakeSolanaRpc(),engine=new SolanaEngine({rpc,now:()=>now.value});return {...f,vault,account,rpc,engine,now,network:SOL_NETWORK,request:{requestKey:'payment-1',to:SOL_TO,lamports:'1000000'},close(){vault.lock();f.close();}};}
