#!/usr/bin/env node
/** SYNTHETIC peers and public test keys, only for UI acceptance tests. */
import fs from 'node:fs';import {serverFixture,TO} from './fixtures.mjs';
const output=process.argv[2];if(!output)throw Error('OUTPUT_REQUIRED');const f=await serverFixture();
await f.vault.addAccount({family:'icp',label:'ICP · 公開試験用seed',secretHex:'01'.repeat(32)});
await f.vault.addAccount({family:'solana',label:'Solana · 公開試験用seed',secretHex:'02'.repeat(32)});
await f.vault.addAccount({family:'evm',label:'閲覧専用 · 試験アドレス',watchAddress:'0x'+'36'.repeat(20)});
await f.backup();
await f.call('prepare',{accountId:f.account.id,chainId:'31337',transaction:{from:f.account.address,to:TO,value:'0x2386f26fc10000'}});
fs.writeFileSync(output,JSON.stringify({launchUrl:f.start.launchUrl,origin:f.start.origin,rpcUrls:f.network.rpcUrls}),{mode:0o600});
console.log('SYNTHETIC UI fixture started; launch capability written only to the requested private file.');
let closing=false;const close=async()=>{if(closing)return;closing=true;await f.close();fs.rmSync(output,{force:true});};process.once('SIGINT',close);process.once('SIGTERM',close);
