#!/usr/bin/env node
/** Generates a reviewable policy draft. Never creates keys, queries RPC, or starts relaying. */
import fs from 'node:fs';import {POLICY_SCHEMA,validatePolicy,relayNetworks,hashObject} from './policy.mjs';import {need,safeError} from '../wallet/lib/guard.mjs';
try{
 const args=process.argv.slice(2),o={};
 const required=['--settings','--routes','--fee-atomic','--gas-limit','--total-fee-atomic','--max-txs','--expires-in-seconds','--output'];
 need(args.length===required.length*2,'RELAY_DRAFT_ARGUMENTS');for(let i=0;i<args.length;i+=2){need(required.includes(args[i])&&!Object.hasOwn(o,args[i]),'RELAY_DRAFT_ARGUMENTS');o[args[i]]=args[i+1];}
 need(required.every(k=>o[k]),'RELAY_DRAFT_ARGUMENTS');
 const s=fs.lstatSync(o['--settings']);need(s.isFile()&&!s.isSymbolicLink()&&s.size<=131072,'RELAY_SETTINGS_FILE');const settings=JSON.parse(fs.readFileSync(o['--settings'],'utf8'));
 const ids=o['--routes'].split(',');need(ids.length<=4&&new Set(ids).size===ids.length&&Array.isArray(settings.ibcRoutes),'RELAY_ROUTES_REQUIRED');
 const routes=ids.map(id=>{const r=settings.ibcRoutes.find(r=>r.id===id);need(r,'RELAY_ROUTE_NOT_FOUND');return r;});
 need(/^[1-9][0-9]*$/.test(o['--expires-in-seconds'])&&/^[1-9][0-9]*$/.test(o['--max-txs']),'RELAY_DRAFT_INTEGER');const seconds=Number(o['--expires-in-seconds']);need(seconds>=60&&seconds<=604800,'RELAY_EXPIRY_MAX_7_DAYS');
 const policy=validatePolicy({schema:POLICY_SCHEMA,mode:'local-development',routes,fees:relayNetworks({routes}).map(n=>({networkId:n.id,feeAtomic:o['--fee-atomic'],gasLimit:o['--gas-limit'],maxTotalFeeAtomic:o['--total-fee-atomic'],maxTransactions:Number(o['--max-txs'])})),maxJobs:32,intervalMs:5000,expiresAt:Date.now()+seconds*1000});
 fs.writeFileSync(o['--output'],JSON.stringify(policy,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({policyHash:hashObject(policy),draftOnly:true,signingPermissionGranted:false}));
}catch(e){console.error(safeError(e));process.exitCode=1;}
