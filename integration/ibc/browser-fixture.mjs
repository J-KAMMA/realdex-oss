/** Private stdin test control; no HTTP control endpoint or stored owner capability. */
import readline from 'node:readline';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {until,receivePacket,acknowledgePacket} from './devnet.mjs';
const f=await ibcWalletFixture(process.env.REALDEX_IBC_LOG_DIRECTORY);
let closing=false;
async function close(){if(closing)return;closing=true;await f.close();}
process.once('SIGTERM',()=>void close().then(()=>process.exit(0)));process.once('SIGINT',()=>void close().then(()=>process.exit(0)));
console.log(JSON.stringify({ready:true,origin:f.started.origin,url:f.started.origin+'/wallet/#key='+f.app.uiToken,accountId:f.accounts[0].id,receiver:f.accounts[1].address,routeId:f.route.id}));
try{for await(const line of readline.createInterface({input:process.stdin})){const command=JSON.parse(line);if(command.action==='close')break;
 if(command.action==='relay'){const records=(await f.call('ibc/history')).records,r=records.find(r=>r.requestKey===command.requestKey);if(!r)throw Error('TEST_RECORD_MISSING');const src=await until(async()=>{const x=await f.call('ibc/reconcile',{id:r.id});return x.report.packet?x:false;});const d=await receivePacket(f.a,f.b,f.lane.bClient,src.report.packet),a=await acknowledgePacket(f.a,f.b,f.lane.aClient,src.report.packet,d.acknowledgement);console.log(JSON.stringify({id:r.id,destinationTxHash:d.result.hash,settlementTxHash:a.hash}));}
 else if(command.action==='status')console.log(JSON.stringify({submissions:f.pa.submissions,records:(await f.call('ibc/history')).records.length}));
 else throw Error('TEST_COMMAND_NOT_ALLOWED');
}}catch(e){console.error('IBC_BROWSER_FIXTURE_FAILED: '+e.message);process.exitCode=1;}finally{await close();}
