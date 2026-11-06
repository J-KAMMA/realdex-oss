/** Fixed loopback destination; even absolute-form negative tests never connect off-host. */
import http from 'node:http';
import {need,loopbackOrigin} from './protocol.mjs';
export async function ownerHttp(config,{route='/api/status',body={},headers={},method='POST',rawBody}={}){
 const base=new URL(loopbackOrigin(config.origin));need(typeof route==='string'&&route.length<=512,'E2E_AUTH_HTTP_PATH');
 const h={host:base.host,origin:config.origin,authorization:'Bearer '+config.token,'content-type':'application/json',...headers};
 for(const key of Object.keys(h))if(h[key]===null)delete h[key];
 const data=rawBody===undefined?JSON.stringify(body):rawBody;need(typeof data==='string'&&Buffer.byteLength(data)<=262144,'E2E_AUTH_HTTP_BODY');
 return new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port:base.port,path:route,method,headers:{...h,'content-length':Buffer.byteLength(data)},agent:false},res=>{
   let size=0,parts=[];res.on('data',part=>{size+=part.length;if(size>2097152)req.destroy(Error('E2E_AUTH_HTTP_LIMIT'));else parts.push(part);});
   res.on('end',()=>{clearTimeout(timer);const text=Buffer.concat(parts).toString('utf8');let value=null;try{value=JSON.parse(text);}catch{}
    resolve({status:res.statusCode,data:value,text,headers:res.headers});});res.on('error',()=>{clearTimeout(timer);reject(Error('E2E_AUTH_HTTP_FAILED'));});
  });
  const timer=setTimeout(()=>req.destroy(Error('E2E_AUTH_HTTP_TIMEOUT')),10000);
  req.on('error',e=>{clearTimeout(timer);reject(Error(e?.message==='E2E_AUTH_HTTP_TIMEOUT'?e.message:'E2E_AUTH_HTTP_FAILED'));});req.end(data);
 });
}
export function attackRequest(id,config,route,body){
 const p={route,body};
 switch(id){
 case 'missing-authorization':return {...p,headers:{authorization:null}};
 case 'wrong-capability':return {...p,headers:{authorization:'Bearer '+'0'.repeat(64)}};
 case 'missing-origin':return {...p,headers:{origin:null}};
 case 'foreign-origin-with-owner-capability':return {...p,headers:{origin:'https://hostile.invalid'}};
 case 'allowed-app-origin-with-owner-capability':return {...p,headers:{origin:'http://127.0.0.1:5173'}};
 case 'null-origin':return {...p,headers:{origin:'null'}};
 case 'different-host':return {...p,headers:{host:'localhost:'+new URL(config.origin).port}};
 case 'absolute-foreign-target':return {...p,route:'http://foreign.invalid'+route};
 case 'query-token':return {...p,route:route+'?key='+config.token};
 case 'cross-site-fetch':return {...p,headers:{'sec-fetch-site':'cross-site'}};
 case 'get-operation':return {...p,method:'GET'};
 case 'options-operation':return {...p,method:'OPTIONS'};
 case 'form-content-type':return {...p,headers:{'content-type':'application/x-www-form-urlencoded'}};
 case 'malformed-json':return {...p,rawBody:'{"broken":'};
 default:throw Error('E2E_AUTH_ATTACK_ID');
 }
}
export function crossRouteRequest(id,config,approval){
 const bridge={origin:'http://127.0.0.1:5173','x-realdex-bridge':'1'};
 switch(id){
 case 'unlisted-app-origin':return {route:'/bridge/non-evm/approve',body:approval,headers:{...bridge,origin:'https://hostile.invalid'}};
 case 'bridge-owner-route':return {route:'/bridge/non-evm/approve',body:approval,headers:bridge};
 case 'bridge-without-marker':return {route:'/bridge/connect',body:{chainId:'31337'},headers:{origin:bridge.origin}};
 case 'bridge-cors-owner-header':return {route:'/bridge/connect',method:'OPTIONS',headers:{...bridge,'access-control-request-method':'POST','access-control-request-headers':'content-type,authorization'}};
 case 'agent-browser-origin':return {route:'/agent/v1/transfers',body:approval,headers:{'x-realdex-agent':'1'}};
 case 'agent-invalid-capability':return {route:'/agent/v1/transfers',body:approval,headers:{origin:null,'x-realdex-agent':'1',authorization:'Bearer '+'0'.repeat(64)}};
 default:throw Error('E2E_AUTH_ATTACK_ID');
 }
}
