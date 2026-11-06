#!/usr/bin/env node
/** Read-only spot-book CLI. Defaults to a local synthetic demonstration. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath}from'node:url';
import {observeSpot}from'./external/observer.mjs';import {quoteSpot}from'./external/quote.mjs';import {demoSnapshot}from'./external/demo.mjs';import {units,need}from'./external/math.mjs';
export async function runSpotCli(args,{now=Date.now}={}) {
 const allowed=['--provider','--endpoint','--network','--market','--amount','--side','--limit','--allow-origin','--output'];const o={};
 for(let i=0;i<args.length;i+=2){need(allowed.includes(args[i])&&args[i+1]!==undefined&&!Object.hasOwn(o,args[i]),'SPOT_ARGUMENTS');o[args[i]]=args[i+1];}
 const provider=o['--provider']??'injective',side=o['--side']??'sell-base';need(['injective','hypercore'].includes(provider),'SPOT_PROVIDER');
 const snap=o['--endpoint']?await observeSpot({provider,network:o['--network'],endpoint:o['--endpoint'],...(provider==='injective'?{marketId:o['--market']}:{pairIndex:o['--market']})},{access:o['--allow-origin']?{mode:'explicit-remote',allowedOrigins:[o['--allow-origin']]}:{},now}):demoSnapshot(provider,now());
 const inputAtomic=units(o['--amount']??'1',side==='sell-base'?snap.market.base.decimals:snap.market.quote.decimals).toString();
 const result={mode:o['--endpoint']?'unverified-public-observation':'synthetic-demo',snapshot:snap,estimate:quoteSpot(snap,{side,inputAtomic,...(o['--limit']?{limitPrice:o['--limit']}:{})},{now:now()}),executionEnabled:false};
 const data=JSON.stringify(result,null,2)+'\n';if(o['--output'])fs.writeFileSync(o['--output'],data,{flag:'wx',mode:0o600});return data;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runSpotCli(process.argv.slice(2)).then(x=>console.log(x)).catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'SPOT_FAILED');process.exitCode=1;});
