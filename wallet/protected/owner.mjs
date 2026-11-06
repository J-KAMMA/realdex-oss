#!/usr/bin/env node
/** UP01 explicit protected owner entry. No test controls, fixture key import or public-chain widening. */
import {CheckpointLeaseStore} from './store.mjs';import {ProtectedOwnerServer} from './server.mjs';
let store,app,closing=false;
async function stop(){if(closing)return;closing=true;if(app)await app.close();else store?.close();}
try{
 const args=process.argv.slice(2);if(args.length!==3)throw Error('CP_ARGUMENTS');
 const port=Number(args[2]);if(!Number.isInteger(port)||port<0||port>65535)throw Error('CP_PORT');
 store=new CheckpointLeaseStore(args[0],args[1]);app=new ProtectedOwnerServer({store});
 const result=await app.start(port);
 process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
 console.log('RealDEX UP02 protected local wallet.');
 console.log('Open locally; this URL is a secret capability:\n'+result.launchUrl);
}catch(e){console.error(e instanceof Error&&/^[A-Z][A-Z0-9_]+$/.test(e.message)?e.message:'CP_OWNER_FAILED');await stop();process.exitCode=1;}
