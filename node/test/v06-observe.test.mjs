import test from 'node:test';import assert from 'node:assert/strict';
import {observeExtended} from '../extended/observe.mjs';
import {networks,NOW,H,ICP,CKBTC,request,fixtureFetch} from './v06-fixtures.mjs';
import {privateEvmProfile,privateCometProfile,validateExtendedProfile,extendedRegistry,extendedCapabilities} from '../extended/registry.mjs';
const observe=(p,opts={},transform)=>observeExtended(request(p,{...opts,fetchImpl:fixtureFetch(p,{transform})}));
for(const p of networks.list())test('v06 fixture protocol observation '+p.id,async()=>{
 const calls=[],r=await observeExtended(request(p,{fetchImpl:fixtureFetch(p,{calls})}));
 assert.equal(r.networkId,p.id);assert.equal(r.readerCount,2);assert.equal(r.assurance.rpcAgreement,true);assert.equal(r.executable,false);
 assert.equal(r.assurance.consensusProofVerified,false);assert.equal(r.assurance.blockExecutionVerified,false);assert.equal(r.assurance.certifiedLedgerState,false);
 assert.equal(r.privacy.privateBalancesRead,false);assert.equal(r.privacy.peerPublicationAllowed,false);assert.equal(r.privacy.anonymityGuaranteed,false);
 assert.equal(r.anchor.height,p.family==='monero'?'91':p.family==='utxo-core'?'95':'100');
 assert.equal(r.scope,p.family==='icp'?'ledger-canister':'chain');assert.equal(r.expiresAt,NOW+30000);assert.ok(Object.isFrozen(r));
 const serialized=JSON.stringify(r);assert.ok(!serialized.includes('127.0.0.1'));assert.ok(calls.length>0);
 assert.ok(calls.every(c=>['POST'].includes(c.method)&&c.init.redirect==='error'&&c.init.credentials==='omit'));
});
const representatives=['monero:mainnet','zcash:mainnet','cosmos:secret-4','eip155:23294','icp:mainnet'].map(id=>networks.get(id));
for(const p of representatives){
 test(p.family+' one RPC never called a quorum',async()=>{const r=await observe(p,{endpoints:['http://127.0.0.1:18081']});assert.equal(r.assurance.rpcAgreement,false);});
 test(p.family+' explicit pinned identity disagreement stops',async()=>{
  await assert.rejects(observe(p,p.family==='cometbft'?{identityAnchor:{height:'1',hash:H(9)}}:{genesisPin:H(9)}),/IDENTITY_PIN_MISMATCH/);
 });
 test(p.family+' no silent endpoint fallback',async()=>{
  const seen=[];await assert.rejects(observeExtended(request(p,{fetchImpl:async(url,init)=>{seen.push(String(url));if(new URL(url).port==='18082')throw new Error('http://password.secret/failed');return fixtureFetch(p)(url,init);}})),/REQUEST_FAILED/);
  assert.ok(seen.every(u=>['18081','18082'].includes(new URL(u).port)));assert.ok(!seen.some(u=>u.includes('https')));
 });
}
for(const id of ['monero:mainnet','zcash:mainnet','eip155:23294','icp:mainnet'])test(id+' missing genesis pin fails before network',async()=>{
 const p=networks.get(id);let called=false;await assert.rejects(observeExtended(request(p,{genesisPin:undefined,fetchImpl:async()=>{called=true;}})),/GENESIS_PIN_REQUIRED/);assert.equal(called,false);
});
for(const field of ['synchronized','offline','busy_syncing'])test('Monero rejects unhealthy '+field,async()=>{
 const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='get_info')r.result[field]=field==='synchronized'?false:true;return r;}),/RPC_SYNCING/);
});
for(const method of ['get_info','get_block_header_by_height'])test('Monero rejects untrusted '+method,async()=>{
 const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method===method)r.result.untrusted=true;return r;}),/MONERO_RESPONSE_UNTRUSTED/);
});
test('Monero rejects unknown network even unanimous',async()=>{const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='get_info')r.result.nettype='testnet';return r;}),/NETWORK_IDENTITY_MISMATCH/);});
test('Monero height is block count not tip index',async()=>{const p=networks.get('monero:mainnet'),calls=[];await observeExtended(request(p,{fetchImpl:fixtureFetch(p,{calls})}));assert.ok(calls.some(c=>c.body.params?.height===100));assert.ok(!calls.some(c=>c.body.params?.height===101));});
test('Monero catches top hash mismatch',async()=>{const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='get_info')r.result.top_block_hash=H(33);return r;}),/MONERO_TIP_MISMATCH/);});
test('Monero catches orphan anchor',async()=>{const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.params?.height===91)r.result.block_header.orphan_status=true;return r;}),/MONERO_ORPHAN_BLOCK/);});
test('Monero full uint128 ancillary difficulty is not rounded',async()=>{const p=networks.get('monero:mainnet');const r=await observe(p,{},(r,e)=>JSON.stringify(r).replace('"0x1000000000000000000"','340282366920938463463374607431768211455'));assert.equal(r.anchor.height,'91');});
for(const id of ['zcash:mainnet','litecoin:mainnet','dogecoin:mainnet','bitcoin-cash:mainnet','dash:mainnet']){
 test(id+' IBD is rejected',async()=>{const p=networks.get(id);await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='getblockchaininfo')r.result.initialblockdownload=true;return r;}),/RPC_SYNCING/);});
 test(id+' wrong chain is rejected',async()=>{const p=networks.get(id);await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='getblockchaininfo')r.result.chain='test';return r;}),/NETWORK_IDENTITY_MISMATCH/);});
}
test('Dash ChainLock field never promotes proof flag',async()=>{const p=networks.get('dash:mainnet');const r=await observe(p,{},(r,e)=>{if(e.body.method==='getblockheader')r.result.chainlock=true;return r;});assert.equal(r.assurance.consensusProofVerified,false);assert.ok(!Object.hasOwn(r,'chainLockVerified'));});
test('UTXO invalid header confirmations stop',async()=>{const p=networks.get('zcash:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='getblockheader')r.result.confirmations=-1;return r;}));});
test('EVM wrong chain ID stops',async()=>{const p=networks.get('eip155:23294');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='eth_chainId')r.result='0x1';return r;}),/NETWORK_IDENTITY_MISMATCH/);});
test('EVM syncing stops',async()=>{const p=networks.get('eip155:23294');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='eth_syncing')r.result={currentBlock:'0x9'};return r;}),/RPC_SYNCING/);});
test('CometBFT unknown checkpoint requires explicit input',async()=>{const p=networks.get('cosmos:secret-4');let called=false;await assert.rejects(observeExtended(request(p,{identityAnchor:undefined,fetchImpl:async()=>{called=true;}})));assert.equal(called,false);});
test('CometBFT block network disagreement stops',async()=>{const p=networks.get('cosmos:secret-4');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='block')r.result.block.header.chain_id='evil';return r;}),/BLOCK_NETWORK_MISMATCH/);});
test('Namada checkpoint heights cannot silently vary',async()=>{const p=networks.get('namada:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.method==='block')r.result.block.header.height='2';return r;}),/ANCHOR_HEIGHT_MISMATCH/);});
test('Penumbra uses current operator-pinned checkpoint, no invented genesis',async()=>{const p=networks.get('penumbra:mainnet');const r=await observe(p,{identityAnchor:{height:'10',hash:H(10)}});assert.equal(r.identity.checkpointHeight,'10');});
test('ICP Rosetta rejects ledger missing from network list',async()=>{const p=networks.get('icp:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.url.endsWith('/network/list'))r.network_identifiers=[];return r;}),/ROSETTA_LEDGER_NOT_FOUND/);});
test('ICP Rosetta accepts principal-shaped ledger mapping when explicitly configured',async()=>{const p=networks.get('icp:mainnet'),ledger={canister:CKBTC,networkFormat:'principal'};const r=await observeExtended(request(p,{ledger,fetchImpl:fixtureFetch(p,{ledger})}));assert.equal(r.identity.ledger,CKBTC);assert.equal(r.identity.network,CKBTC);});
test('ICP idle ledger is not a stalled ICP network',async()=>{const p=networks.get('icp:mainnet');const r=await observe(p,{},(r,e)=>{if(r.block)r.block.timestamp=NOW-86400000*30;if(r.current_block_timestamp)r.current_block_timestamp=NOW-86400000*30;return r;});assert.equal(r.assurance.sourceFreshnessEstablished,false);assert.equal(r.assurance.icpSubnetIdentityVerified,false);});
test('ICP future timestamps rejected even for idle ledger',async()=>{const p=networks.get('icp:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(r.block)r.block.timestamp=NOW+10000;return r;}),/BLOCK_IN_FUTURE/);});
test('ICP sync false stops',async()=>{const p=networks.get('icp:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(r.sync_status)r.sync_status.synced=false;return r;}),/RPC_SYNCING/);});
test('RPCs disagreeing on anchor stop',async()=>{const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.params?.height===91&&new URL(e.url).port==='18082')r.result.block_header.hash=H(999);return r;}),/RPC_ANCHOR_DISAGREEMENT/);});
test('reorg after first common anchor is caught',async()=>{const p=networks.get('monero:mainnet');const n={};await assert.rejects(observe(p,{},(r,e)=>{if(e.body.params?.height===91){const port=new URL(e.url).port;n[port]=(n[port]??0)+1;if(n[port]>1)r.result.block_header.hash=H(999);}return r;}),/ANCHOR_CHANGED/);});
test('genesis changes during read stop',async()=>{const p=networks.get('monero:mainnet');const n={};await assert.rejects(observe(p,{},(r,e)=>{if(e.body.params?.height===0){const port=new URL(e.url).port;n[port]=(n[port]??0)+1;if(n[port]>1)r.result.block_header.hash=H(999);}return r;}),/RPC_IDENTITY_CHANGED/);});
test('stale block and oversized confirmations stop',async()=>{const p=networks.get('monero:mainnet');await assert.rejects(observe(p,{},(r,e)=>{if(e.body.params?.height>0)r.result.block_header.timestamp=NOW/1000-86401;return r;}),/BLOCK_STALE/);await assert.rejects(observe(p,{policy:{confirmationDepth:129}}),/POLICY_INVALID/);});
test('clock rollback and preaborted operations stop',async()=>{const p=networks.get('monero:mainnet');let n=0;await assert.rejects(observe(p,{now:()=>NOW-n++}),/CLOCK_MOVED_BACKWARDS/);const ac=new AbortController();ac.abort();let called=false;await assert.rejects(observeExtended(request(p,{signal:ac.signal,fetchImpl:async()=>{called=true;}})));assert.equal(called,false);});
test('permissioned EVM stays distinct even with public chain ID 1',async()=>{const p=privateEvmProfile({slug:'lab',chainId:'1',genesisHash:H(0)}),r=await observe(p);assert.equal(r.networkId,'private-evm:lab');assert.equal(r.privacy.model,'permissioned-not-confidential');assert.equal(r.privacy.peerPublicationAllowed,false);assert.equal(extendedCapabilities(p).privacyProofsVerified,false);});
test('permissioned Comet requires checkpoint matching profile',async()=>{const p=privateCometProfile({slug:'lab',chainId:'secret-4',checkpointHash:H(1)});await observe(p);await assert.rejects(observe(p,{identityAnchor:{height:'1',hash:H(2)}}),/PROFILE_PIN_CONFLICT/);});
for(const mutate of [p=>p.id='monero:testnet',p=>p.status='verified',p=>p.genesisHash='abc',p=>p.source='http://secret',p=>p.nativeDecimals=50,p=>p.foo='private_key'])test('profile validation never authorizes arbitrary claims '+mutate.toString(),()=>{const p=structuredClone(networks.get('monero:mainnet'));mutate(p);assert.throws(()=>validateExtendedProfile(p));});
test('28 new extension rows, duplicate rejection and immutable profile',()=>{assert.equal(networks.size,28);const p=networks.list()[0];assert.ok(Object.isFrozen(p));assert.throws(()=>extendedRegistry({schema:'realdex.extended-networks.v1',profiles:[p,p]}),/DUPLICATE_NETWORK/);});
test('permissioned config cannot borrow public namespace',()=>{const p=privateEvmProfile({slug:'office',chainId:'1',genesisHash:H(0)});assert.throws(()=>validateExtendedProfile({...p,id:'eip155:1'}),/PRIVATE_NAMESPACE_REQUIRED/);});
