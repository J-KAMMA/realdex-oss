#!/usr/bin/env node
/** Disposable laboratory only. Test relayer has its own throwaway fee key; no production secrets. */
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {ibcWalletFixture} from './wallet-fixture.mjs';
import {until,receivePacket,acknowledgePacket,timeoutPacket} from './devnet.mjs';

/** Defer shutdown during initialization until the acquired fixture can be disposed. */
export async function runIbcLab({createFixture=ibcWalletFixture,input=process.stdin,output=console,signals=process}={}){
 let f,reader,stopping=false;
 const stop=()=>{stopping=true;reader?.close();};
 signals.on('SIGINT',stop);signals.on('SIGTERM',stop);
 try{
  f=await createFixture();
  if(stopping)return;
  output.log('DISPOSABLE LOCAL LAB ONLY / 既知の試験鍵。実資産は禁止。終了時にチェーンと保管庫を削除します。');
  output.log('所有者専用URL（共有しない）: '+f.started.origin+'/wallet/#key='+f.app.uiToken);
  output.log('送信元テスト口座: '+f.accounts[0].address+'\n受取先テスト口座: '+f.accounts[1].address);
  output.log('画面で初回送信した後、relay <支払い識別キー> または timeout <支払い識別キー>。quit / Ctrl+C で終了。');
  reader=readline.createInterface({input});
  for await(const line of reader){
   if(stopping)break;
   const parts=line.trim().split(/\s+/);if(parts[0]==='quit')break;
   try{
    if(!['relay','timeout'].includes(parts[0])||parts.length!==2||!/^[A-Za-z0-9_-]{1,80}$/.test(parts[1]))throw Error('Use relay <requestKey>, timeout <requestKey>, or quit');
    const rs=(await f.call('ibc/history')).records.filter(r=>r.requestKey===parts[1]);if(rs.length!==1)throw Error('Unique submitted bridge record required');const r=rs[0];
    const src=await until(async()=>{const v=await f.call('ibc/reconcile',{id:r.id});return v.report?.packet?v:false;});if(src.report.completed)throw Error('Already completed; no relay submitted');
    if(stopping)break;
    const reverse=r.summary.route.id===f.reverse.id,from=reverse?f.b:f.a,to=reverse?f.a:f.b,dc=reverse?f.lane.aClient:f.lane.bClient,sc=reverse?f.lane.bClient:f.lane.aClient;
    let refs;
    if(parts[0]==='relay'){
     const d=await receivePacket(from,to,dc,src.report.packet);
     if(stopping)break;
     const ack=await acknowledgePacket(from,to,sc,src.report.packet,d.acknowledgement);refs={destinationTxHash:d.result.hash,settlementTxHash:ack.hash};
    }else{const t=await timeoutPacket(from,to,sc,src.report.packet);refs={settlementTxHash:t.hash};}
    if(stopping)break;
    const observed=await f.call('ibc/reconcile',{id:r.id,...refs});output.log(JSON.stringify({requestKey:r.requestKey,...refs,stage:observed.report.stage,finalityProven:false}));
   }catch(e){output.error('LAB: '+e.message);}
  }
 }finally{
  reader?.close();
  try{await f?.close();}finally{signals.removeListener('SIGINT',stop);signals.removeListener('SIGTERM',stop);}
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{await runIbcLab();}catch(e){console.error('IBC_LAB_FAILED: '+e.message);process.exitCode=1;}
}
