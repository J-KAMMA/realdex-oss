/** Separate state machines A/B; two local HTTP observation endpoints per state machine. */
import fs from 'node:fs';
import http from 'node:http';
import {startChain,connect} from './devnet.mjs';
import {createHttpDiagnostics} from './http-diagnostics.mjs';
import {WalletServer} from '../../wallet/lib/server.mjs';
import {Vault} from '../../wallet/lib/vault.mjs';
import {storeFixture,PASSWORD} from '../../wallet/test/fixtures.mjs';
import {validateIbcRoute} from '../../wallet/bridge/ibc-config.mjs';
export async function endpointPair(c){
 const servers=[],fault={hook:null,mutate:null,dropSubmit:false,submissions:0,requests:[],diagnostics:createHttpDiagnostics()};
 for(let peer=0;peer<2;peer++){
  const pair={};
  for(const type of ['rpc','rest']){
   const server=http.createServer(async(req,res)=>{try{const chunks=[];for await(const x of req)chunks.push(x);const body=Buffer.concat(chunks),u=new URL(req.url,type==='rpc'?c.rpcUrl:c.restUrl);fault.requests.push({peer,type,path:req.url,body:body.toString()});if(fault.hook)await fault.hook({peer,type,path:req.url,body:body.toString()});
    const submit=type==='rest'&&req.method==='POST'&&u.pathname==='/cosmos/tx/v1beta1/txs';if(submit)fault.submissions++;
    const response=await fetch(u,{method:req.method,headers:{'content-type':'application/json',...(req.headers['x-cosmos-block-height']?{'x-cosmos-block-height':req.headers['x-cosmos-block-height']}:{})},...(body.length?{body}:{}),signal:AbortSignal.timeout(12000)});let text=await response.text();fault.diagnostics.record({peer,type,method:req.method,path:req.url,requestBody:body.toString(),requestHeight:req.headers['x-cosmos-block-height'],status:response.status,responseHeight:response.headers.get('x-cosmos-block-height'),gatewayResponseHeight:response.headers.get('grpc-metadata-x-cosmos-block-height'),responseBody:text});if(fault.mutate)text=fault.mutate({peer,type,path:req.url,text})??text;
    if(submit&&fault.dropSubmit){req.socket.destroy();return;}
    res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json',...(response.headers.get('x-cosmos-block-height')?{'x-cosmos-block-height':response.headers.get('x-cosmos-block-height')}:{})});res.end(text);
   }catch{fault.diagnostics.record({peer,type,method:req.method,path:req.url,requestHeight:req.headers['x-cosmos-block-height'],transportFailure:true});if(!res.headersSent)res.writeHead(502,{'content-type':'application/json'});res.end('{"error":"test proxy failure"}');}});
   await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);pair[type+'Url']=`http://127.0.0.1:${server.address().port}/`;
  }
  fault.endpoints??=[];fault.endpoints.push(pair);
 }
 return {...fault,fault,async close(){await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));}};
}
export async function ibcWalletFixture(logDir){let a,b,pa,pb,app,store;try{
 a=await startChain('a',logDir);b=await startChain('b',logDir);const lane=await connect(a,b);pa=await endpointPair(a);pb=await endpointPair(b);
 const n=(c,p)=>({family:'cosmos',id:'cosmos:'+c.chainId,name:'IBC disposable '+c.label,chainId:c.chainId,hrp:'cosmos',endpoints:p.fault.endpoints,checkpoint:c.checkpoint,denom:'stake',decimals:6,symbol:'STAKE-test',feeDenom:'stake',feeDecimals:6,maxTransferAtomic:'1000000000000',maxFeeAtomic:'1000000',maxGasLimit:'5000000',timeoutBlocks:100,minConfirmations:1,broadcastEnabled:true});
 const na=n(a,pa),nb=n(b,pb),sa={network:na,channel:lane.aChannel,connection:lane.aConnection,client:lane.aClient},sb={network:nb,channel:lane.bChannel,connection:lane.bConnection,client:lane.bClient};
 const route=validateIbcRoute({schema:'realdex.ibc-route.v1',id:'ibc-local-a-to-b',name:'Disposable A to B',source:sa,destination:sb,asset:{baseDenom:'stake',originChainId:a.chainId,decimals:6,symbol:'STAKE-test'},maxTransferAtomic:'1000000000',minTimeoutSeconds:30,maxTimeoutSeconds:3600});
 const reverse=validateIbcRoute({...route,id:'ibc-local-b-to-a',name:'Return B to A',source:sb,destination:sa});
 store=storeFixture();const vault=new Vault(store.store);await vault.create(PASSWORD);const accounts=[];for(let i=0x31;i<=0x40;i++)accounts.push(await vault.addAccount({family:'cosmos',label:'Disposable IBC key '+i,secretHex:i.toString(16).repeat(32)}));const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
 const settings={schema:'realdex.wallet-settings.v1',networks:[],allowedAppOrigins:[],cosmosNetworks:[na,nb],ibcRoutes:[route,reverse]};app=new WalletServer({store:store.store,vault,settings});const started=await app.start(0);
 const ui=async(route,body={})=>fetch(started.origin+'/api/'+route,{method:'POST',headers:{'content-type':'application/json',origin:started.origin,authorization:'Bearer '+app.uiToken},body:JSON.stringify(body)});
 const diagnosticFailures=[];
 const diagnosticReport=()=>({schema:'realdex.ibc-fixture-diagnostics.v1',failures:structuredClone(diagnosticFailures),a:pa.fault.diagnostics.snapshot(),b:pb.fault.diagnostics.snapshot()});
 const call=async(route,body={})=>{const r=await ui(route,body),j=await r.json();if(!r.ok){if(['COSMOS_RPC_HTTP_ERROR','COSMOS_RPC_DISAGREEMENT','COSMOS_RPC_TRANSPORT_UNCERTAIN','COSMOS_QUERY_HEIGHT_MISMATCH','COSMOS_COMET_RPC_ERROR','COSMOS_RPC_JSON_INVALID','COSMOS_RPC_RESPONSE_LIMIT'].includes(j.error)){diagnosticFailures.push({code:j.error,a:pa.fault.diagnostics.snapshot(),b:pb.fault.diagnostics.snapshot()});if(diagnosticFailures.length>4)diagnosticFailures.shift();}throw Error(j.error);}return j;};
 const payment=(receiver,extra={})=>({requestKey:'bridge-'+Date.now(),receiver,amountAtomic:'1000000',feeAtomic:'50000',gasLimit:'2000000',timeoutSeconds:120,...extra});
 return {a,b,lane,pa:pa.fault,pb:pb.fault,route,reverse,accounts,app,vault,store,started,ui,call,payment,diagnosticReport,async close(){await app.close();await pa.close();await pb.close();await a.close();await b.close();fs.rmSync(store.directory,{recursive:true,force:true});}};
 }catch(e){await app?.close().catch(()=>{});await pa?.close();await pb?.close();await a?.close();await b?.close();store?.close();throw e;}}
