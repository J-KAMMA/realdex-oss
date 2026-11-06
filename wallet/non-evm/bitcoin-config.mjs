#!/usr/bin/env node
/** Read-only diagnostic configuration collector. Independent checkpoint verification remains the owner's job. */
import fs from 'node:fs';import path from 'node:path';
import {need,safeError} from '../lib/guard.mjs';
import {BitcoinRpc,validateBitcoinNetwork,BITCOIN_REGTEST_GENESIS,rpcInteger,bitcoinHash} from './bitcoin-network.mjs';
const usage='node wallet/non-evm/bitcoin-config.mjs --rpc-url http://127.0.0.1:18443/ --rpc-url http://127.0.0.1:18444/ --cookie-file /absolute/path/.cookie --checkpoint-height 1 --output bitcoin-regtest.json';
try{
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--help'){console.log(usage);process.exit(0);}
  need(args.length%2===0,'BITCOIN_CONFIG_ARGUMENTS');const o={},urls=[];
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];need(['--rpc-url','--cookie-file','--checkpoint-height','--output'].includes(k)&&v,'BITCOIN_CONFIG_ARGUMENTS');if(k==='--rpc-url')urls.push(v);else{need(!o[k],'BITCOIN_CONFIG_DUPLICATE_OPTION');o[k]=v;}}
  const height=rpcInteger(o['--checkpoint-height'],2147483647);need(height>=1&&o['--output']&&o['--cookie-file'],'BITCOIN_CONFIG_ARGUMENTS');
  const provisional=validateBitcoinNetwork({family:'bitcoin',id:'bitcoin:regtest',name:'My Bitcoin Core regtest',chain:'regtest',genesisHash:BITCOIN_REGTEST_GENESIS,checkpoint:{height,hash:'01'.repeat(32)},rpcUrls:urls,cookieFile:path.resolve(o['--cookie-file']),broadcastEnabled:false,maxTransferSats:'100000000',maxFeeSats:'100000',maxFeeRateSatVb:'100',minConfirmations:2});
  const rpc=new BitcoinRpc(),roots=await rpc.all(provisional,'getblockhash',[0]);need(roots.every(x=>x===BITCOIN_REGTEST_GENESIS),'BITCOIN_GENESIS_MISMATCH');
  const infos=await rpc.all(provisional,'getblockchaininfo',[]);need(infos.every(i=>i.chain==='regtest'&&i.initialblockdownload===false&&rpcInteger(i.blocks)>=height),'BITCOIN_NODE_NOT_READY');
  const hash=bitcoinHash(await rpc.agree(provisional,'getblockhash',[height]));
  const network=validateBitcoinNetwork({...provisional,checkpoint:{height,hash}});
  fs.writeFileSync(path.resolve(o['--output']),JSON.stringify(network,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({created:true,broadcastEnabled:false,checkpoint:network.checkpoint,assurance:'RPC observation only; verify the checkpoint independently before registering',cookieContentsExported:false}));
}catch(e){console.error(safeError(e));console.error(usage);process.exitCode=1;}
