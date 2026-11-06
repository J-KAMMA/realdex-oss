import http from 'node:http';import {demoInputs,DEMO_MARKET}from'../demo.mjs';import {field,str,vint,join,frame,fields,text,one}from'../protobuf.mjs';
export const NOW=1788652800000;
export const clone=x=>structuredClone(x);
export const zz=n=>{n=BigInt(n);return n<0n?(-n*2n)-1n:n*2n;};
export function marketBytes(m=demoInputs(NOW).market){const meta=x=>join(str(3,x.symbol),vint(5,zz(x.decimals)));return field(1,join(str(1,m.marketId),str(2,m.marketStatus),str(3,m.ticker),str(4,m.baseDenom),field(5,meta(m.baseTokenMeta)),str(6,m.quoteDenom),field(7,meta(m.quoteTokenMeta)),str(9,m.takerFeeRate),str(11,m.minPriceTickSize),str(12,m.minQuantityTickSize),str(13,m.minNotional)));}
export function bookBytes(b=demoInputs(NOW).book){const levels=(xs,id)=>join(...xs.map(x=>field(id,join(str(1,x.price),str(2,x.quantity)))));return field(1,join(levels(b.buys,1),levels(b.sells,2),vint(3,BigInt(b.sequence)),vint(4,zz(b.timestamp)),vint(5,zz(b.height))));}
export const grpc=(bytes,status='0')=>join(frame(bytes),frame(new TextEncoder().encode(`grpc-status: ${status}\r\n`),128));
export async function providerServer(t,{now=NOW,modify,delay=0}={}){
 const requests=[];let marketReads=0;
 const server=http.createServer(async(req,res)=>{try{const parts=[];for await(const p of req)parts.push(p);const body=Buffer.concat(parts);requests.push({path:req.url,method:req.method,headers:req.headers,body});
  const x=demoInputs(now);if(delay)await new Promise(r=>setTimeout(r,delay));let payload,type;
  if(req.url.endsWith('/Market')){const f=fields(body.subarray(5));if(text(f,1)!==DEMO_MARKET)throw Error();marketReads++;modify?.(x,'Market',marketReads);payload=grpc(marketBytes(x.market));type='application/grpc-web+proto';}
  else if(req.url.endsWith('/OrderbookV2')){const f=fields(body.subarray(5));if(text(f,1)!==DEMO_MARKET||one(f,2,0)!==100n)throw Error();modify?.(x,'OrderbookV2',marketReads);payload=grpc(bookBytes(x.book));type='application/grpc-web+proto';}
  else if(req.url==='/info'){const p=JSON.parse(body);if(p.type==='spotMeta'){marketReads++;modify?.(x,'spotMeta',marketReads);payload=JSON.stringify(x.hyperMeta);}else if(p.type==='l2Book'&&p.coin==='@1'){modify?.(x,'l2Book',marketReads);payload=JSON.stringify(x.hyperBook);}else throw Error();type='application/json';}
  else throw Error();res.writeHead(200,{'content-type':type});res.end(payload);
 }catch{res.writeHead(400,{'content-type':'application/json'});res.end('{}');}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return {endpoint:`http://127.0.0.1:${server.address().port}`,requests};
}
