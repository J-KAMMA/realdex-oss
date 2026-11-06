#!/usr/bin/env node
/** Read-only checkpoint collection, not authentication or broadcast permission. */
import fs from 'node:fs';import path from 'node:path';
import {need,safeError} from '../lib/guard.mjs';
import {CosmosRpc,validateCosmosNetwork} from './cosmos-network.mjs';
import {CosmosAdapter} from './cosmos-online.mjs';
const usage='node wallet/non-evm/cosmos-config.mjs --input draft-local-cosmos.json --output checked-local-cosmos.json';
try{
 const a=process.argv.slice(2);if(a.length===1&&a[0]==='--help'){console.log(usage);process.exit(0);}
 need(a.length===4&&a[0]==='--input'&&a[2]==='--output','COSMOS_CONFIG_ARGUMENTS');
 const bytes=fs.readFileSync(path.resolve(a[1]));need(bytes.length<=32768,'COSMOS_CONFIG_SIZE');const n=validateCosmosNetwork(JSON.parse(bytes));need(n.broadcastEnabled===false,'COSMOS_CONFIG_MUST_DISABLE_BROADCAST');
 const rpc=new CosmosRpc(),adapter=new CosmosAdapter(rpc);
 const block=await adapter.block(n,n.checkpoint.height);
 const configured=validateCosmosNetwork({...n,checkpoint:{height:block.height,hash:block.hash}});
 await adapter.head(configured);
 fs.writeFileSync(path.resolve(a[3]),JSON.stringify(configured,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({created:true,networkId:n.id,checkpoint:configured.checkpoint,broadcastEnabled:false,independentlyTrusted:false,warning:'This only collects matching RPC reports. Independently authenticate your checkpoint. Do not use production keys.'}));
}catch(e){console.error(safeError(e));console.error(usage);process.exitCode=1;}
