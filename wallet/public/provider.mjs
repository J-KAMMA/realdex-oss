/** Browser-only EIP-1193 provider. Session grants can REQUEST but never APPROVE signing.
 * No private key, vault password or UI capability is sent through this module.
 */
const error=(message,code=4001)=>Object.assign(new Error(message),{code});
const codes={USER_REJECTED:4001,SESSION_UNAUTHORIZED:4100,PAIRING_UNAUTHORIZED:4100,WALLET_METHOD_UNSUPPORTED:4200,NETWORK_NOT_CONFIGURED:4901,VAULT_LOCKED:4100,APP_ORIGIN_NOT_ALLOWED:4100,REQUEST_EXPIRED:4001};
export class LocalWalletProvider {
  constructor({baseUrl='http://127.0.0.1:8790',chainId='0x7a69',fetchImpl=globalThis.fetch,pollMs=1000,now=Date.now}={}){
    const url=new URL(baseUrl);if(url.origin!==baseUrl||url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw error('LOCAL_WALLET_URL_REQUIRED',4200);
    if(!/^0x[1-9a-f][0-9a-f]*$/i.test(chainId))throw error('CHAIN_ID_INVALID',4200);
    this.baseUrl=baseUrl;this.chainId=chainId.toLowerCase();this.fetch=fetchImpl;this.pollMs=pollMs;this.now=now;this.session=null;this.accounts=[];this.events=new Map();this.connecting=null;this.disposed=false;this.generation=0;
  }
  on(name,listener){if(typeof listener!=='function')throw error('LISTENER_REQUIRED');if(!this.events.has(name))this.events.set(name,new Set());this.events.get(name).add(listener);return this;}
  removeListener(name,listener){this.events.get(name)?.delete(listener);return this;}
  emit(name,value){for(const f of this.events.get(name)??[])try{f(value);}catch{ /* isolate consumer event listeners */ }}
  disconnected(message='WALLET_DISCONNECTED'){this.generation++;this.session=null;this.accounts=[];this.emit('accountsChanged',[]);this.emit('disconnect',error(message,4900));}
  async post(path,body){let r;try{r=await this.fetch(this.baseUrl+path,{method:'POST',mode:'cors',credentials:'omit',redirect:'error',cache:'no-store',headers:{'content-type':'application/json','x-realdex-bridge':'1'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});}catch{throw error('LOCAL_WALLET_UNREACHABLE',4900);}
    let data;try{data=await r.json();}catch{throw error('WALLET_RESPONSE_INVALID',4900);}if(!data||typeof data!=='object'||Array.isArray(data))throw error('WALLET_RESPONSE_INVALID',4900);if(!r.ok||data.error){if(data.error==='SESSION_UNAUTHORIZED')this.disconnected(data.error);throw error(data.error??'WALLET_REQUEST_FAILED',codes[data.error]??-32603);}return data;
  }
  async connect(){if(this.session)return this.accounts.slice();if(this.connecting)return this.connecting;
    this.connecting=(async()=>{const generation=this.generation,pair=await this.post('/bridge/connect',{chainId:this.chainId});
      while(this.now()<pair.expiresAt&&!this.disposed){if(generation!==this.generation)throw error('CONNECTION_CANCELLED');const r=await this.post('/bridge/connect/status',{pairId:pair.pairId,ticket:pair.ticket});
        if(r.state==='approved'){if(typeof r.session!=='string'||!/^([0-9a-f]{64})$/.test(r.session)||!Array.isArray(r.accounts)||r.accounts.length!==1||!/^0x[0-9a-f]{40}$/.test(r.accounts[0])||!/^0x[1-9a-f][0-9a-f]*$/.test(r.chainId))throw error('WALLET_GRANT_INVALID',4900);if(generation!==this.generation)throw error('CONNECTION_CANCELLED');this.session=r.session;this.accounts=r.accounts.slice();this.chainId=r.chainId;this.emit('connect',{chainId:r.chainId});this.emit('accountsChanged',this.accounts.slice());return this.accounts.slice();}
        if(r.state==='rejected')throw error(r.error??'USER_REJECTED',4001);await new Promise(resolve=>setTimeout(resolve,this.pollMs));
      }throw error('CONNECTION_EXPIRED');})().finally(()=>{this.connecting=null;});return this.connecting;
  }
  async request(args){if(this.disposed)throw error('PROVIDER_DISPOSED',4900);if(!args||typeof args.method!=='string'||(args.params!==undefined&&!Array.isArray(args.params)))throw error('REQUEST_ARGUMENTS_INVALID',4200);
    const {method}=args,params=args.params??[];
    if(method==='eth_requestAccounts'&&!this.session)return this.connect();
    if(method==='eth_accounts'&&!this.session)return [];
    if(method==='eth_chainId'&&!this.session)return this.chainId;
    if(!this.session)throw error('CONNECT_WALLET_FIRST',4100);
    const session=this.session,generation=this.generation;let result=await this.post('/bridge/request',{session,method,params});
    if(result.pending){const deadline=this.now()+120000;for(;;){if(generation!==this.generation||this.disposed)throw error('SESSION_CHANGED',4100);if(this.now()>=deadline)throw error('APPROVAL_TIMEOUT_CHECK_WALLET_JOURNAL');
      const poll=await this.post('/bridge/result',{session,id:result.pending});if(poll.state==='approved'){result={result:poll.result};break;}if(poll.state==='rejected')throw error(poll.error??'USER_REJECTED',codes[poll.error]??-32603);await new Promise(r=>setTimeout(r,this.pollMs));}}
    if(generation!==this.generation||this.disposed)throw error('SESSION_CHANGED',4100);
    if(method==='wallet_switchEthereumChain'){const current=await this.post('/bridge/request',{session,method:'eth_chainId',params:[]});if(generation!==this.generation||this.disposed)throw error('SESSION_CHANGED',4100);if(current.result!==this.chainId){this.chainId=current.result;this.emit('chainChanged',this.chainId);}}
    if(method==='wallet_revokePermissions')this.disconnected('SESSION_REVOKED');
    if(method==='eth_accounts'&&JSON.stringify(result.result)!==JSON.stringify(this.accounts)){this.accounts=result.result.slice();this.emit('accountsChanged',this.accounts.slice());}
    return result.result;
  }
  async disconnect(){if(this.session)try{await this.post('/bridge/request',{session:this.session,method:'wallet_revokePermissions',params:[]});}catch{}this.disconnected();}
  dispose(){const session=this.session;this.disposed=true;this.disconnected('PROVIDER_DISPOSED');if(session)void this.post('/bridge/request',{session,method:'wallet_revokePermissions',params:[]}).catch(()=>{});this.events.clear();}
}
export function localWalletDetail(provider,uuid=globalThis.crypto.randomUUID()){
  return {info:{uuid,name:'RealDEX PC Wallet (Test)',rdns:'local.realdex.wallet',icon:'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"%3E%3Crect width="96" height="96" rx="24" fill="%23152632"/%3E%3Cpath d="M28 26h24a14 14 0 010 28H28V26zm0 28v18m18-18 22 18" stroke="%237de0c3" stroke-width="8" fill="none"/%3E%3C/svg%3E'},provider};
}
