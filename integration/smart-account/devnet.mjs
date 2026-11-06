#!/usr/bin/env node
/** Disposable GUI demonstration. Never reads the user's normal wallet or forks public chains. */
import {setup} from './fixture.mjs';
import {PASSWORD} from '../anvil/fixture.mjs';
if(process.argv.length!==2)throw Error('SMART_DEVNET_NO_ARGUMENTS');
let f,stopping=false;let done;
const stopped=new Promise(r=>done=r);
async function stop(){if(stopping)return;stopping=true;try{if(f)await f.close();}finally{if(f)done();}}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
f=await setup();if(stopping){await f.close();done();}else{
console.log('使い捨てローカル試験です。実資産・既存鍵を使用しないでください。Ctrl+Cでチェーンと試験保管庫を削除します。');
console.log('所有者URL（AIや他人には共有しない）: '+f.start.origin+'/wallet/#key='+f.app.uiToken);
console.log('この使い捨て保管庫だけの解除パスワード: '+PASSWORD);
console.log('スマートアカウント: '+f.smart.address);
console.log('Factory: '+f.smart.factory);
console.log('ローカル試験残高を入金済みです。ここでは固定nightlyの未監査コードを使用します。');
}
try{await stopped;}finally{await stop();}
