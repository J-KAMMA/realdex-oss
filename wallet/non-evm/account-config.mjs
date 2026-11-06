#!/usr/bin/env node
/** Read-only local checkpoint collector. This is not trust bootstrap or a signing command. */
import fs from 'node:fs';
import path from 'node:path';
import {need,safeError} from '../lib/guard.mjs';
import {AccountRest,validateAccountNetwork,int,hash} from './account-network.mjs';
import {STELLAR_LOCAL_PASSPHRASE} from './stellar-offline.mjs';
const help='node wallet/non-evm/account-config.mjs --family stellar|aptos --rpc-url http://127.0.0.1:PORT/ --rpc-url http://127.0.0.1:PORT/ --checkpoint-height 1 --output account-network.json';
try{
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--help'){console.log(help);process.exit(0);}
  need(args.length%2===0,'ACCOUNT_CONFIG_ARGUMENTS');const o={},urls=[];
  for(let i=0;i<args.length;i+=2){const k=args[i],v=args[i+1];need(['--family','--rpc-url','--checkpoint-height','--output'].includes(k)&&v,'ACCOUNT_CONFIG_ARGUMENTS');if(k==='--rpc-url')urls.push(v);else {need(o[k]===undefined,'ACCOUNT_CONFIG_DUPLICATE_OPTION');o[k]=v;}}
  const family=o['--family'],stellar=family==='stellar';need(['stellar','aptos'].includes(family)&&o['--output'],'ACCOUNT_CONFIG_ARGUMENTS');
  const height=int(o['--checkpoint-height'],2147483647);need(height>=1,'ACCOUNT_CHECKPOINT_REQUIRED');
  const n=validateAccountNetwork({family,id:stellar?'stellar:standalone':'aptos:local-4',name:'My local '+family,rpcUrls:urls,checkpoint:{height,hash:(stellar?'':'0x')+'01'.repeat(32)},broadcastEnabled:false,maxTransferAtomic:'100000000',maxFeeAtomic:'1000000',minConfirmations:1,...(stellar?{networkPassphrase:STELLAR_LOCAL_PASSPHRASE}:{chainId:4})});
  const rest=new AccountRest();
  for(const r of await rest.all(n,''))need(stellar?r.network_passphrase===n.networkPassphrase:r.chain_id===4,'ACCOUNT_NETWORK_MISMATCH');
  const pin=await rest.agree(n,stellar?`ledgers/${height}`:`blocks/by_height/${height}?with_transactions=false`,undefined,v=>{
    need(int(stellar?v.sequence:v.block_height)===height,'ACCOUNT_CHECKPOINT_HEIGHT_MISMATCH');return hash(stellar?v.hash:v.block_hash,!stellar);
  });
  const network=validateAccountNetwork({...n,checkpoint:{height,hash:pin}});
  fs.writeFileSync(path.resolve(o['--output']),JSON.stringify(network,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({created:true,networkId:n.id,checkpoint:network.checkpoint,broadcastEnabled:false,independentlyTrusted:false,warning:'Verify checkpoint independently. Loopback does not prove the remote network is private.'}));
}catch(e){console.error(safeError(e));console.error(help);process.exitCode=1;}
