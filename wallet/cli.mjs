#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {PrivateStore} from './lib/storage.mjs';
import {WalletServer} from './lib/server.mjs';
import {validateSettings} from './lib/network.mjs';
import {need,safeError} from './lib/guard.mjs';
const args=process.argv.slice(2);
if(args[0]!=='start'||(args.length-1)%2!==0){console.error('Usage: node wallet/cli.mjs start [--directory .realdex-wallet] [--port 8790]');process.exitCode=1;}
else {
 let store,app;
 try{
  const options={};for(let i=1;i<args.length;i+=2){need(['--directory','--port'].includes(args[i])&&!Object.hasOwn(options,args[i]),'CLI_ARGUMENT_INVALID');options[args[i]]=args[i+1];}
  const port=Number(options['--port']??8790);need(Number.isInteger(port)&&port>0&&port<=65535,'PORT_INVALID');
  store=new PrivateStore(options['--directory']??path.join(os.homedir(),'.realdex-wallet'));const file=path.join(store.directory,'settings.json');
  let settings={schema:'realdex.wallet-settings.v1',allowedAppOrigins:['http://127.0.0.1:8787','http://127.0.0.1:5173','http://localhost:5173'],networks:[]};
  if(fs.existsSync(file)){const stat=fs.lstatSync(file);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<131072,'SETTINGS_FILE_UNSAFE');settings=validateSettings(JSON.parse(fs.readFileSync(file,'utf8')));}
  const saveSettings=s=>{const temp=path.join(store.directory,'.settings-'+process.pid);const fd=fs.openSync(temp,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(s,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);};
  if(!fs.existsSync(file))saveSettings(settings);
  app=new WalletServer({store,settings,saveSettings});const result=await app.start(port);
  // Install shutdown handling before advertising readiness to the parent.
  let closing=false;const close=async()=>{if(closing)return;closing=true;await app.close();};process.once('SIGINT',close);process.once('SIGTERM',close);
  console.log('RealDEX Wallet 0.24 — development/test network wallet; not audited for real funds.');
  console.log('Private directory: '+store.directory);console.log('Open locally (do not share this capability URL):\n'+result.launchUrl);
  console.log('Shared node is a different process. No wallet key is sent to it. Ctrl+C to lock and stop.');

 }catch(e){console.error(safeError(e));if(app)await app.close().catch(()=>{});else store?.close();process.exitCode=1;}
}
