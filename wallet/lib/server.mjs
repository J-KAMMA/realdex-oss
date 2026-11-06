import {IbcController} from '../bridge/controller.mjs';
import {SmartController} from '../smart-account/controller.mjs';
import {NonEvmController} from '../non-evm/controller.mjs';
import {NetworkReview} from './network-review.mjs';
import {dexCatalog,dexRequest,quoteDirectPools,quoteLocalRoute} from './dex.mjs';
import {AgentController} from './agents.mjs';
import {transferRequest,readTransferBalance,receiveRequest,parsePaymentRequest} from './transfers.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {Vault} from './vault.mjs';
import {EvmEngine} from './evm-engine.mjs';
import {validateSettings,validateNetwork} from './network.mjs';
import {need,shape,text,clone,safeError,q,quantity,canonical} from './guard.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const STATIC=new Map([['/wallet/ibc.mjs',['public/ibc.mjs','text/javascript; charset=utf-8']],['/wallet/',['public/index.html','text/html; charset=utf-8']],['/wallet/app.mjs',['public/app.mjs','text/javascript; charset=utf-8']],['/wallet/styles.css',['public/styles.css','text/css; charset=utf-8']]]);
const READS=new Set(['eth_blockNumber','eth_getBalance','eth_getCode','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_estimateGas','eth_call','eth_gasPrice','eth_maxPriorityFeePerGas','eth_getBlockByNumber','eth_getBlockByHash','eth_getLogs']);
const token=()=>randomBytes(32).toString('hex');
function equal(a,b){return typeof a==='string'&&typeof b==='string'&&a.length===b.length&&timingSafeEqual(Buffer.from(a),Buffer.from(b));}
export class WalletServer {
  constructor({store,settings={schema:'realdex.wallet-settings.v1',allowedAppOrigins:[],networks:[]},saveSettings=()=>{},vault=null,engine=null,now=Date.now}={}){
    this.store=store;this.now=now;this.vault=vault??new Vault(store,{now});this.engine=engine??new EvmEngine({now});this.settings=validateSettings(settings);this.saveSettings=saveSettings;
    this.uiToken=token();this.dexBusy=false;this.server=null;this.origin=null;this.requests=new Map();this.pairs=new Map();this.sessions=new Map();this.budget={at:0,n:0};this.agentBudget={at:0,n:0};this.bridgeBudget={at:0,n:0};this.timer=null;this.activeApproval=false;this.agents=new AgentController(this);this.networkReview=new NetworkReview(this);this.nonEvm=new NonEvmController(this);this.smart=new SmartController(this);this.ibc=new IbcController(this);
  }
  async start(port=8790){need(!this.server,'WALLET_ALREADY_STARTED');this.server=http.createServer({maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000,keepAliveTimeout:1000},(req,res)=>this.handle(req,res));this.server.maxConnections=32;this.server.on('clientError',(_e,s)=>s.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
    await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(port,'127.0.0.1',resolve);});this.origin=`http://127.0.0.1:${this.server.address().port}`;
    this.timer=setInterval(()=>this.sweep(),1000);this.timer.unref();return {origin:this.origin,launchUrl:`${this.origin}/wallet/#key=${this.uiToken}`};
  }
  async close(){clearInterval(this.timer);this.invalidate('WALLET_STOPPED');this.vault.lock();if(this.server?.listening){const p=new Promise(r=>this.server.close(r));this.server.closeAllConnections();await p;}await this.vault.queue;this.store?.close();}
  sweep(){const status=this.vault.status();if(status.locked)this.invalidate('WALLET_LOCKED');const t=this.now();for(const [k,s] of this.sessions)if(t>=s.expiresAt)this.revoke(k,'SESSION_EXPIRED');
    for(const r of this.requests.values())if(['pending','preparing'].includes(r.state)&&t>=r.expiresAt){r.state='rejected';r.error='REQUEST_EXPIRED';}
    for(const [id,r]of this.requests)if(t>=r.expiresAt+300000&&!['processing'].includes(r.state))this.requests.delete(id);
    for(const [id,p]of this.pairs)if(t>=p.expiresAt+300000)this.pairs.delete(id);
  }
  invalidate(code){this.ibc?.invalidate(code);this.smart?.invalidate();this.networkReview?.invalidate();this.agents?.invalidate();for(const r of this.requests.values())if(['pending','preparing'].includes(r.state)){r.state='rejected';r.error=code;}this.sessions.clear();for(const p of this.pairs.values())if(p.state==='pending'){p.state='rejected';p.error=code;}}
  revoke(sessionToken,code='SESSION_REVOKED'){this.sessions.delete(sessionToken);for(const r of this.requests.values())if(r.sessionToken===sessionToken&&['pending','preparing'].includes(r.state)){r.state='rejected';r.error=code;}}
  network(chainId){const n=this.settings.networks.find(n=>n.chainId===chainId);need(n,'NETWORK_NOT_CONFIGURED');return n;}
  session(key,origin){this.sweep();const s=this.sessions.get(key);need(s&&s.origin===origin&&this.now()<s.expiresAt,'SESSION_UNAUTHORIZED');this.vault.check();return s;}
  addRequest(r){this.sweep();need([...this.requests.values()].filter(x=>['pending','preparing','processing'].includes(x.state)).length<16&&this.requests.size<128,'REQUEST_QUEUE_LIMIT');const id=randomUUID();this.requests.set(id,{id,createdAt:this.now(),expiresAt:this.now()+90000,state:'pending',...r});return this.requests.get(id);}
  pending(){this.sweep();return [...this.requests.values()].filter(r=>['pending','processing'].includes(r.state)).map(r=>({id:r.id,kind:r.kind,state:r.state,origin:r.origin,expiresAt:r.expiresAt,summary:r.intent?.summary??null,intentId:r.intent?.id??null,chainId:r.chainId??null,agentRequestId:r.agentRequestId??null}));}
  async handle(req,res){
    const headers={'cache-control':'no-store','pragma':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer','x-frame-options':'DENY','cross-origin-opener-policy':'same-origin','content-security-policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'"};
    const send=(status,value,mime='application/json; charset=utf-8')=>{if(res.headersSent||res.destroyed)return;res.writeHead(status,{...headers,'content-type':mime});res.end(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));};
    try{
      need(this.origin&&req.headers.host===this.origin.slice(7),'HOST_NOT_ALLOWED');need(req.socket.remoteAddress==='127.0.0.1','LOOPBACK_ONLY');
      const url=new URL(req.url,this.origin);need(url.origin===this.origin&&!url.search&&!url.hash,'REQUEST_URL_INVALID');
      if(req.method==='GET'&&STATIC.has(url.pathname)){const [file,mime]=STATIC.get(url.pathname);return send(200,fs.readFileSync(path.join(ROOT,file)),mime);}
      if(req.method==='GET'&&url.pathname==='/') {res.writeHead(302,{...headers,location:'/wallet/'});return res.end();}
      const isBridge=url.pathname.startsWith('/bridge/'),isAgent=url.pathname.startsWith('/agent/v1/');const origin=req.headers.origin;let agentToken;
      if(isAgent){need(origin===undefined&&!['sec-fetch-site','sec-fetch-dest','sec-fetch-user'].some(h=>req.headers[h]!==undefined),'AGENT_BROWSER_REQUEST_FORBIDDEN');need(req.headers['x-realdex-agent']==='1','AGENT_HEADER_REQUIRED');need(typeof req.headers.authorization==='string'&&/^Bearer [0-9a-f]{64}$/.test(req.headers.authorization),'AGENT_UNAUTHORIZED');agentToken=req.headers.authorization.slice(7);this.agents.authorize(agentToken);}
      if(isAgent){}else if(isBridge){need(typeof origin==='string'&&this.settings.allowedAppOrigins.includes(origin)&&origin!==this.origin,'APP_ORIGIN_NOT_ALLOWED');headers['access-control-allow-origin']=origin;headers.vary='Origin';
        if(req.method==='OPTIONS'){need(req.headers['access-control-request-method']==='POST','METHOD_NOT_ALLOWED');const asked=(req.headers['access-control-request-headers']??'').toLowerCase().split(',').map(x=>x.trim());need(asked.every(h=>['content-type','x-realdex-bridge'].includes(h)),'CORS_HEADERS_FORBIDDEN');headers['access-control-allow-methods']='POST';headers['access-control-allow-headers']='Content-Type, X-Realdex-Bridge';headers['access-control-max-age']='0';return send(204,'');}
        need(req.headers['x-realdex-bridge']==='1','BRIDGE_HEADER_REQUIRED');
      }else{need(url.pathname.startsWith('/api/'),'NOT_FOUND');need(origin===this.origin,'WALLET_ORIGIN_REQUIRED');need(equal(req.headers.authorization,'Bearer '+this.uiToken),'UI_AUTH_REQUIRED');need(!['cross-site'].includes(req.headers['sec-fetch-site']),'FETCH_SITE_FORBIDDEN');}
      need(req.method==='POST','METHOD_NOT_ALLOWED');need(req.headers['content-type']==='application/json','JSON_CONTENT_TYPE_REQUIRED');
      const now=this.now(),bucketName=isAgent?'agentBudget':isBridge?'bridgeBudget':'budget';if(now-this[bucketName].at>60000||now<this[bucketName].at)this[bucketName]={at:now,n:0};const emergency=!isAgent&&!isBridge&&['/api/lock','/api/agents/stop','/api/agents/revoke','/api/ibc/monitor/stop'].includes(url.pathname);if(!emergency)need(++this[bucketName].n<=600,'REQUEST_RATE_LIMIT');
      const requestEpoch=this.vault.epoch;
      const monitorStartGeneration=url.pathname==='/api/ibc/monitor/start'?this.ibc.monitor.generation:null;
      let size=0,chunks=[];for await(const c of req){size+=c.length;need(size<=(isAgent?16384:1048576),'REQUEST_TOO_LARGE');chunks.push(c);}let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('JSON_INVALID');}
      // A body uploaded before a lock cannot become a new-session command afterward.
      if(!emergency)need(requestEpoch===this.vault.epoch,'REQUEST_INVALIDATED_BY_LOCK');
      if(monitorStartGeneration!==null)need(monitorStartGeneration===this.ibc.monitor.generation,'IBC_MONITOR_START_INVALIDATED');
      const result=isAgent?await this.agents.api(url.pathname.slice('/agent/v1/'.length),body,agentToken):isBridge?await this.bridge(url.pathname,body,origin):await this.api(url.pathname,body);return send(200,result);
    }catch(e){const error=safeError(e);const status=['UI_AUTH_REQUIRED','SESSION_UNAUTHORIZED','AGENT_UNAUTHORIZED'].includes(error)?401:error==='NOT_FOUND'?404:error.includes('RATE_LIMIT')?429:400;send(status,{error});}
  }
  async api(route,b){
    if(route.startsWith('/api/ibc/'))return this.ibc.api(route,b);
    if(route.startsWith('/api/smart/'))return this.smart.api(route,b);
    if(route.startsWith('/api/non-evm/'))return this.nonEvm.api(route,b);
    if(route==='/api/status'){shape(b,[]);return {...this.vault.status(),smartAccounts:this.vault.key?this.smart.list():[],networks:this.settings.networks.map(n=>({chainId:n.chainId,name:n.name,symbol:n.symbol,broadcastEnabled:n.broadcastEnabled,tokens:n.contracts.filter(c=>c.kind==='erc20').map(c=>({address:c.address,symbol:c.symbol,decimals:c.decimals}))})),pending:this.pending(),sessions:[...this.sessions.entries()].map(([id,s])=>({id,origin:s.origin,chainId:s.chainId,accountId:s.accountId,expiresAt:s.expiresAt})),allowedAppOrigins:this.settings.allowedAppOrigins,agents:this.vault.key?this.agents.list():[],release:'0.23.0-dev.20260906',mainnetSigning:false,solanaNetworks:this.settings.solanaNetworks??[],bitcoinNetworks:this.settings.bitcoinNetworks??[],accountNetworks:this.settings.accountNetworks??[],cosmosNetworks:this.settings.cosmosNetworks??[],ibcRoutes:this.settings.ibcRoutes??[],bridgeVersion:'0.23.0-dev',ibcMonitoring:this.ibc.monitor.status(),ibcAutomaticEvidenceDiscovery:true,ibcReadOnlyMonitoring:true,nonEvmCapabilities:{cosmosNativeRestrictedAuthorization:true,cosmosAuthzAgentIntegration:false,cosmosLocalBankSubmission:true,stellarStandaloneSubmission:true,aptosLocalSubmission:true,bitcoinRegtestSubmission:true,solanaLocalNativeSubmission:true,solanaClassicSplSubmission:true,bitcoinRegtestOfflineP2wpkh:true,cosmosLocalOfflineMsgSend:true,stellarStandaloneOfflinePayment:true,aptosLocalOfflineTransfer:true,icpOfflineEnvelope:true,icpSubmission:false,offlineFamiliesSubmission:false,agentSubmission:false}};}
    if(route==='/api/create'){shape(b,['password']);return this.vault.create(b.password);}
    if(route==='/api/unlock'){shape(b,['password']);return this.vault.unlock(b.password);}
    if(route==='/api/lock'){shape(b,[]);this.invalidate('WALLET_LOCKED');this.vault.lock();return {locked:true};}
    if(route==='/api/accounts/add'){shape(b,['family','label'],['secretHex','watchAddress']);return this.vault.addAccount(b);}
    if(route==='/api/backup'){shape(b,[]);return this.vault.backup();}
    if(route==='/api/backup/verify'){shape(b,['encrypted','password']);return this.vault.verifyBackup(b.encrypted,b.password);}
    if(route==='/api/restore'){shape(b,['encrypted','password']);return this.vault.restore(b.encrypted,b.password);}
    if(route==='/api/password'){shape(b,['oldPassword','newPassword']);this.invalidate('PASSWORD_CHANGED');return this.vault.changePassword(b.oldPassword,b.newPassword);}
    if(route==='/api/networks/review')return this.networkReview.prepare(b);
    if(route==='/api/networks/replace')return this.networkReview.apply(b);
    if(route==='/api/networks/add'){need(!this.nonEvm.busy,'NON_EVM_OPERATION_BUSY');shape(b,['network']);this.vault.check();const n=validateNetwork(b.network);need(!this.settings.networks.some(x=>x.chainId===n.chainId),'DUPLICATE_CHAIN_ID');const next=validateSettings({...this.settings,networks:[...this.settings.networks,n]});this.saveSettings(next);this.settings=next;this.invalidate('SETTINGS_CHANGED');return {added:true};}
    if(route==='/api/origins/set'){need(!this.nonEvm.busy,'NON_EVM_OPERATION_BUSY');shape(b,['origins']);this.vault.check();const next=validateSettings({...this.settings,allowedAppOrigins:b.origins});need(!next.allowedAppOrigins.includes(this.origin),'SIGNER_ORIGIN_CANNOT_BE_DAPP');this.saveSettings(next);this.settings=next;this.invalidate('SETTINGS_CHANGED');return {changed:true};}
    if(route==='/api/agents/prepare'){shape(b,['policy']);return this.agents.preparePolicy(b.policy);}
    if(route==='/api/agents/create'){shape(b,['draftId','digest','confirmation']);return this.agents.createPolicy(b);}
    if(route==='/api/agents/activate'){shape(b,['id','confirmation']);return this.agents.activate(b.id,b.confirmation);}
    if(route==='/api/agents/revoke'){shape(b,['id']);return this.agents.revoke(b.id);}
    if(route==='/api/agents/stop'){shape(b,[]);return this.agents.stopAll();}
    if(route==='/api/agents/cancel'){shape(b,['requestId']);return this.agents.cancel(b.requestId);}
    if(route==='/api/agents/history'){shape(b,[]);return {requests:this.agents.claims().map(r=>this.agents.requestView(r))};}
    if(route==='/api/dex/catalog'){shape(b,['chainId']);this.vault.check();return dexCatalog(this.network(b.chainId));}
    if(route==='/api/dex/quote'||route==='/api/dex/quote-route'){
      shape(b,['chainId','quote']);this.vault.check();need(!this.dexBusy,'DEX_PREPARATION_BUSY');this.dexBusy=true;
      const epoch=this.vault.epoch;
      try{const result=await (route==='/api/dex/quote-route'?quoteLocalRoute:quoteDirectPools)(this.engine,this.network(b.chainId),b.quote);need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();return result;}finally{this.dexBusy=false;}
    }
    if(route==='/api/dex/prepare'){
      shape(b,['accountId','chainId','operation']);this.vault.touch();need(!this.dexBusy,'DEX_PREPARATION_BUSY');this.dexBusy=true;
      const epoch=this.vault.epoch;
      try{const network=this.network(b.chainId),account=this.vault.account(b.accountId),built=dexRequest(network,account,b.operation,this.now());
        const intent=await this.engine.prepare(network,account,built.transaction);need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();
        const r=this.addRequest({kind:'transaction',origin:this.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});
        return {id:r.id,intentId:intent.id,summary:intent.summary,operation:built.details,automaticApproval:false};
      }finally{this.dexBusy=false;}
    }
    if(route==='/api/transfers/prepare'){
      shape(b,['accountId','chainId','transfer']);this.vault.touch();const epoch=this.vault.epoch,network=this.network(b.chainId),account=this.vault.account(b.accountId);
      const {transaction,transfer}=transferRequest(network,account,b.transfer),intent=await this.engine.prepare(network,account,transaction);
      need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();
      const r=this.addRequest({kind:'transaction',origin:this.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary,transfer};
    }
    if(route==='/api/transfers/balance'){
      shape(b,['accountId','chainId','asset']);this.vault.check();const epoch=this.vault.epoch;
      const result=await readTransferBalance(this.engine,this.network(b.chainId),this.vault.account(b.accountId),b.asset);
      need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();return result;
    }
    if(route==='/api/transfers/receive'){
      shape(b,['accountId','chainId','asset'],['amount']);this.vault.check();return receiveRequest(this.network(b.chainId),this.vault.account(b.accountId),{asset:b.asset,...(b.amount===undefined?{}:{amount:b.amount})});
    }
    if(route==='/api/transfers/parse-uri'){shape(b,['chainId','uri']);this.vault.check();return parsePaymentRequest(this.network(b.chainId),b.uri);}
    if(route==='/api/prepare'){shape(b,['accountId','chainId','transaction']);this.vault.check();const epoch=this.vault.epoch,intent=await this.engine.prepare(this.network(b.chainId),this.vault.account(b.accountId),b.transaction);need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();const r=this.addRequest({kind:'transaction',origin:this.origin,intent,expiresAt:intent.expiresAt,sessionToken:null});return {id:r.id,intentId:intent.id,summary:intent.summary};}
    if(route==='/api/approve'){shape(b,['id','confirm'],['accountId','chainId','intentId','broadcast']);return this.approve(b);}
    if(route==='/api/reject'){shape(b,['id']);const r=this.requests.get(b.id);need(r?.state==='pending','REQUEST_NOT_PENDING');r.state='rejected';r.error='USER_REJECTED';if(r.agentRequestId)await this.agents.cancel(r.agentRequestId);if(r.kind==='connect'){const p=this.pairs.get(r.pairId);p.state='rejected';p.error='USER_REJECTED';}return {rejected:true};}
    if(route==='/api/sessions/revoke'){shape(b,['id']);this.revoke(b.id);return {revoked:true};}
    if(route==='/api/journal'){shape(b,[]);return {records:await this.vault.journal()};}
    if(route==='/api/rebroadcast'||route==='/api/reconcile'){shape(b,['id'],route==='/api/rebroadcast'?['confirm']:[]);this.vault.check();need(!this.activeApproval,'APPROVAL_BUSY');this.activeApproval=true;try {const r=(await this.vault.journal()).find(r=>r.id===b.id);need(r,'RECORD_NOT_FOUND');const network=this.network(r.summary.chainId);if(route==='/api/rebroadcast'){need(b.confirm===r.signed.transactionHash,'CONFIRMATION_MISMATCH');return r.summary.smart?await this.smart.engine.broadcast(r):await this.engine.broadcast(this.vault,network,r);}return await this.engine.reconcile(this.vault,network,r);}finally{this.activeApproval=false;}}
    if(route==='/api/balance'){shape(b,['accountId','chainId']);this.vault.check();const account=this.vault.account(b.accountId);need(account.family==='evm','BALANCE_ADAPTER_UNSUPPORTED');const epoch=this.vault.epoch,n=this.network(b.chainId),snap=await this.engine.rpc.snapshot(n,this.now());const atomic=String(q(await this.engine.rpc.agree(n,'eth_getBalance',[account.address,snap.ref])));need(epoch===this.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');this.vault.check();return {address:account.address,chainId:n.chainId,atomic,symbol:n.symbol,blockHash:snap.hash,assurance:'RPC agreement, not certified balance'};}
    throw Error('NOT_FOUND');
  }
  async approve(b){
    this.vault.check();need(!this.activeApproval,'APPROVAL_BUSY');const r=this.requests.get(b.id);need(r?.state==='pending'&&this.now()<r.expiresAt,'REQUEST_EXPIRED_OR_NOT_PENDING');this.activeApproval=true;r.state='processing';
    try{
      if(r.kind==='connect'){
        need(b.confirm===r.origin,'ORIGIN_CONFIRMATION_MISMATCH');const a=this.vault.account(b.accountId);need(a.family==='evm'&&a.kind==='local','EVM_LOCAL_ACCOUNT_REQUIRED');const n=this.network(b.chainId);need(n.chainId===r.chainId,'CONNECTION_CHAIN_CHANGED');
        const sessionToken=token(),s={origin:r.origin,accountId:a.id,chainId:n.chainId,expiresAt:this.now()+900000};this.sessions.set(sessionToken,s);const p=this.pairs.get(r.pairId);p.state='approved';p.sessionToken=sessionToken;r.state='approved';this.vault.touch();return {approved:true};
      }
      if(r.kind==='switch'){
        need(b.confirm===r.chainId,'CHAIN_CONFIRMATION_MISMATCH');const s=this.session(r.sessionToken,r.origin);this.network(r.chainId);s.chainId=r.chainId;
        for(const other of this.requests.values())if(other.sessionToken===r.sessionToken&&other!==r&&other.state==='pending'){other.state='rejected';other.error='CHAIN_CHANGED';}
        r.result=null;r.state='approved';this.vault.touch();return {approved:true};
      }
      if(r.kind==='smart-transaction'||r.kind==='smart-message')return await this.smart.approveRequest(r,b);
      need(r.kind==='transaction'&&b.intentId===r.intent.id&&b.confirm===r.intent.summary.recipient,'TRANSACTION_CONFIRMATION_MISMATCH');
      if(r.agentRequestId){
        const result=await this.agents.execute(r.agentRequestId,r.intent,r.agentTokenHash,{requestGuard:()=>need(r.state==='processing','REQUEST_NOT_PROCESSING')});
        r.state='approved';r.result=result;return {approved:true,result,broadcastState:result.broadcastState};
      }
      if(r.sessionToken){const s=this.session(r.sessionToken,r.origin);need(s.accountId===r.intent.accountId&&s.chainId===r.intent.networkId,'SESSION_BINDING_CHANGED');}
      const network=this.network(r.intent.networkId),broadcast=r.sessionToken!==null||b.broadcast===true;need(!broadcast||network.broadcastEnabled,'BROADCAST_DISABLED');
      const authorize=()=>{this.vault.check();need(r.state==='processing','REQUEST_NOT_PROCESSING');if(r.sessionToken){const current=this.session(r.sessionToken,r.origin);need(current.accountId===r.intent.accountId&&current.chainId===r.intent.networkId&&this.settings.allowedAppOrigins.includes(r.origin),'SESSION_BINDING_CHANGED');}};
      const record=await this.engine.sign(this.vault,network,r.intent,{authorize});const result=broadcast?await this.engine.broadcast(this.vault,network,record,{authorize}):record;
      r.state='approved';r.result=r.sessionToken?record.signed.transactionHash:{record:result,transactionHash:record.signed.transactionHash};r.recordId=record.id;
      // A possibly-broadcast transaction still returns its deterministic hash to the dapp.
      return {approved:true,result:clone(r.result),broadcastState:result.state};
    }catch(e){r.state='rejected';r.error=safeError(e);if(r.agentRequestId)await this.agents.releaseUnsigned(r.agentRequestId,r.error).catch(()=>{});if(r.kind==='connect'){const p=this.pairs.get(r.pairId);if(p){p.state='rejected';p.error=r.error;}}throw e;}finally{this.activeApproval=false;}
  }
  async bridge(route,b,origin){
    if(route==='/bridge/connect'){shape(b,['chainId']);const chainId=String(q(b.chainId));this.network(chainId);this.vault.check();need(this.pairs.size<64&&!([...this.pairs.values()].some(p=>p.origin===origin&&p.state==='pending'&&this.now()<p.expiresAt)),'CONNECTION_ALREADY_PENDING');const pairId=randomUUID(),ticket=token(),r=this.addRequest({kind:'connect',origin,chainId,pairId});this.pairs.set(pairId,{origin,ticket,requestId:r.id,state:'pending',expiresAt:r.expiresAt});return {pairId,ticket,expiresAt:r.expiresAt};}
    if(route==='/bridge/connect/status'){shape(b,['pairId','ticket']);this.sweep();const p=this.pairs.get(b.pairId);need(p&&p.origin===origin&&equal(p.ticket,b.ticket)&&this.now()<p.expiresAt,'PAIRING_UNAUTHORIZED');
      if(p.state==='approved'){const s=this.session(p.sessionToken,origin);return {state:'approved',session:p.sessionToken,accounts:[this.vault.account(s.accountId).address],chainId:quantity(BigInt(s.chainId)),expiresAt:s.expiresAt};}return {state:p.state,error:p.error??null};}
    if(route==='/bridge/result'){shape(b,['session','id']);this.session(b.session,origin);const r=this.requests.get(b.id);need(r&&r.sessionToken===b.session,'REQUEST_NOT_OWNED');return {state:r.state,result:r.state==='approved'?r.result:null,error:r.error??null};}
    if(route==='/bridge/request'){shape(b,['session','method','params']);const s=this.session(b.session,origin),n=this.network(s.chainId),account=this.vault.account(s.accountId);need(typeof b.method==='string'&&Array.isArray(b.params)&&b.params.length<=3&&JSON.stringify(b.params).length<=65536,'RPC_ARGUMENTS_INVALID');
      if(['eth_accounts','eth_requestAccounts'].includes(b.method)){need(b.params.length===0,'RPC_ARGUMENTS_INVALID');return {result:[account.address]};}
      if(b.method==='eth_chainId'){need(b.params.length===0,'RPC_ARGUMENTS_INVALID');return {result:quantity(BigInt(s.chainId))};}
      if(b.method==='wallet_revokePermissions'){this.revoke(b.session);return {result:null};}
      if(b.method==='wallet_switchEthereumChain'){need(b.params.length===1,'RPC_ARGUMENTS_INVALID');shape(b.params[0],['chainId']);const chainId=String(q(b.params[0].chainId));this.network(chainId);if(chainId===s.chainId)return {result:null};const r=this.addRequest({kind:'switch',origin,chainId,sessionToken:b.session});return {pending:r.id};}
      if(b.method==='eth_sendTransaction'){
        need(b.params.length===1,'RPC_ARGUMENTS_INVALID');need(n.broadcastEnabled,'BROADCAST_DISABLED');const epoch=this.vault.epoch,intent=await this.engine.prepare(n,account,b.params[0],{origin});this.session(b.session,origin);need(epoch===this.vault.epoch&&s.chainId===intent.networkId,'SESSION_CHANGED_DURING_PREPARE');const r=this.addRequest({kind:'transaction',origin,sessionToken:b.session,intent,expiresAt:intent.expiresAt});return {pending:r.id};
      }
      need(READS.has(b.method),'WALLET_METHOD_UNSUPPORTED');need(b.params.length<=2,'RPC_OVERRIDES_FORBIDDEN');await this.engine.rpc.snapshot(n,this.now());const result=await this.engine.rpc.agree(n,b.method,b.params);const current=this.session(b.session,origin);need(current.chainId===n.chainId,'CHAIN_CHANGED');return {result};
    }
    throw Error('NOT_FOUND');
  }
}
