#!/usr/bin/env node
import {startApplication} from './runtime.mjs';import {doctor} from './doctor.mjs';import {need,safeError} from '../wallet/lib/guard.mjs';
const [command,...args]=process.argv.slice(2);
try{
  if(command==='doctor'){need(args.length===0,'APP_OPTION_INVALID');console.log(JSON.stringify(doctor(),null,2));}
  else if(command==='start'){
    need(args.length%2===0,'APP_OPTION_INVALID');const options={},mapping={'--directory':'directory','--node-port':'nodePort','--wallet-port':'walletPort'};
    for(let i=0;i<args.length;i+=2){need(Object.hasOwn(mapping,args[i])&&!Object.hasOwn(options,mapping[args[i]]),'APP_OPTION_INVALID');options[mapping[args[i]]]=args[i+1];}
    const controller=new AbortController();
    // Install handlers before starting either service: early Ctrl+C must not leave an orphan.
    const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    const app=await startApplication(options,{signal:controller.signal});
    console.log('RealDEX v0.17 — local application.');
    console.log('Discovery (read-only): '+app.nodeUrl);
    console.log('PRIVATE wallet link — open locally, never share with an AI or peer:\n'+app.walletLaunchUrl);
    console.log('Separate child processes and private directories. Ctrl+C locks/stops both.');
    app.onUnexpectedExit(()=>{console.error('APP_SERVICE_EXITED');process.exitCode=1;});
  }else{console.log('Usage: node app/cli.mjs start [--directory PATH] [--node-port 8787] [--wallet-port 8790]\n       node app/cli.mjs doctor');if(command)process.exitCode=1;}
}catch(error){console.error(safeError(error));process.exitCode=1;}
