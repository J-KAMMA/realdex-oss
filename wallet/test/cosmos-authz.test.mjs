import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {keyInfo} from '../lib/keys.mjs';
import {canonical} from '../lib/guard.mjs';
import {cosmosFixtureNetwork} from './cosmos-online-fixtures.mjs';
import {AUTHZ_TYPES,authzUser,makeAuthzIntent,signAuthz,verifyAuthz,validateAuthzRecord,authzPaymentHash,authzTransaction} from '../non-evm/cosmos-authz-codec.mjs';
import {CosmosAuthzEngine} from '../non-evm/cosmos-authz-engine.mjs';
import {CosmosRpc} from '../non-evm/cosmos-network.mjs';
import {decodeAuthz} from './cosmos-authz-wire.mjs';
import {fieldBytes} from '../codec/protobuf.mjs';
import {validateNonEvmJournal} from '../non-evm/records.mjs';
const secret=Buffer.alloc(32,0x31),k=keyInfo('cosmos',secret);
const a={id:'11111111-1111-4111-8111-111111111111',family:'cosmos',kind:'local',address:k.address,publicKeyHex:k.publicKeyHex};
const helper=keyInfo('cosmos',Buffer.alloc(32,0x32)).address,to=keyInfo('cosmos',Buffer.alloc(32,0x33)).address;
const n=cosmosFixtureNetwork([{rpcUrl:'http://127.0.0.1:9001',restUrl:'http://127.0.0.1:9002'},{rpcUrl:'http://127.0.0.1:9003',restUrl:'http://127.0.0.1:9004'}]);
const now=1788650000000;
function raw(action='grant'){return {action,requestKey:'unit-'+action,feeAtomic:'800',gasLimit:'400000',...(action==='grant'?{grantee:helper,recipient:to,limitAtomic:'3000000',expirationSeconds:'1788653600'}:action==='execute'?{granter:helper,recipient:to,amountAtomic:'1000000'}:{grantee:helper})};}
function intent(action='grant',changes={}){
 const u=authzUser(a,n,{...raw(action),...changes}),prior=action==='grant'?null:{kind:'restricted-send',fingerprint:'a'.repeat(64),denom:n.denom,remainingAtomic:'3000000',recipient:to,expirationSeconds:'1788653600'};
 return makeAuthzIntent(n,a,u,{accountNumber:'23',sequence:'4'},{height:42},prior,now);
}
function record(action='grant'){const i=intent(action);return {id:randomUUID(),intentId:i.id,requestKey:i.payment.requestKey,paymentHash:i.payment.paymentHash,accountId:a.id,family:'cosmos',state:'signed',createdAt:now,summary:i.summary,signed:signAuthz(secret,i.payment)};}
for(const action of ['grant','execute','revoke']){
 test('authz '+action+' has exact independent decoded payload and OpenSSL signature',async()=>{
  const i=intent(action),s=signAuthz(secret,i.payment);verifyAuthz(s,i.summary);
  const v=await decodeAuthz(Buffer.from(s.txRawBase64,'base64'),n.chainId,async()=>23n);assert.equal(v.action,action);assert.equal(v.from,a.address);assert.equal(v.sequence,'4');assert.equal(v.timeoutHeight,'62');assert.equal(v.feeAtomic,'800');assert.equal(v.hash,s.requestId);
  if(action==='grant'){assert.equal(v.grantee,helper);assert.equal(v.limitAtomic,'3000000');assert.equal(v.recipient,to);assert.equal(v.expirationSeconds,'1788653600');}
  if(action==='execute'){assert.equal(v.granter,helper);assert.equal(v.grantee,a.address);assert.equal(v.amountAtomic,'1000000');}
 });
 test('authz '+action+' builds simulation with zero signature only',async()=>{
  const i=intent(action),t=authzTransaction(i.payment,k.publicKeyHex),raw=Buffer.concat([fieldBytes(1,t.body),fieldBytes(2,t.auth),fieldBytes(3,Buffer.alloc(64))]);
  const d=await decodeAuthz(raw,n.chainId,async()=>23n,{simulation:true});assert.equal(d.action,action);
  await assert.rejects(decodeAuthz(Buffer.from(signAuthz(secret,i.payment).txRawBase64,'base64'),n.chainId,async()=>23n,{simulation:true}),/LEAKED/);
 });
 test('authz '+action+' signed journal is validated and duplicate sequence refused',()=>{const r=record(action);validateAuthzRecord(r,a);validateNonEvmJournal({accounts:[a],nonEvmJournal:[r]});assert.throws(()=>validateNonEvmJournal({accounts:[a],nonEvmJournal:[r,{...r,id:randomUUID(),requestKey:'other'}]}));});
 for(const [field,value] of [['feeAtomic','801'],['sequence','5'],['chainId','realdex-local-other'],['timeoutHeight','63'],['memo','changed']])test('authz '+action+' signature cannot be reused with changed '+field,()=>{
  const i=intent(action),s=signAuthz(secret,i.payment);assert.throws(()=>verifyAuthz(s,{...i.summary,transfer:{...i.payment,[field]:value}}));
 });
}
for(const [label,changes] of [
 ['unknown action',{action:'generic'}],['unlimited',{limitAtomic:'0'}],['numeric amount',{limitAtomic:3000000}],['exponent amount',{limitAtomic:'3e6'}],['negative fee',{feeAtomic:'-1'}],['zero gas',{gasLimit:'0'}],['over-policy gas',{gasLimit:'1000001'}],['over-policy limit',{limitAtomic:'1000000001'}],['self delegate',{grantee:a.address}],['self destination',{recipient:a.address}],['wrong prefix',{grantee:'osmo1invalid'}],['multiple recipients',{recipient:[to,helper]}],['fee payer',{payer:helper}],['generic type',{typeUrl:'/cosmos.authz.v1beta1.GenericAuthorization'}],['no expiry',{expirationSeconds:null}],['fractional expiry',{expirationSeconds:'1788653600.5'}],['unknown extension',{extension:{}}],['unsafe memo',{memo:'a\nb'}],['invalid request key',{requestKey:'../../x'}]
])test('authz input refuses '+label,()=>{assert.throws(()=>authzUser(a,n,{...raw(),...changes}));});
test('authz execute cannot select a different denomination or attach a second message',()=>{for(const change of [{denom:'ugas'},{msgs:[]},{grantee:helper}])assert.throws(()=>authzUser(a,n,{...raw('execute'),...change}));});
test('grant request hash includes scope, expiry, fee and recipient',()=>{
 const b=authzUser(a,n,raw());for(const change of [{limitAtomic:'3000001'},{expirationSeconds:'1788653601'},{recipient:helper},{feeAtomic:'801'}])assert.notEqual(authzPaymentHash(a,n,b),authzPaymentHash(a,n,authzUser(a,n,{...b,...change})));
});
test('record rejects fake receipt or claimed finality',()=>{
 const r=record();for(const report of [{observedAt:now,received:true,completed:true,reason:'fake',assurance:r.summary.assurance,finalityProven:false},{observedAt:now,received:false,completed:false,reason:'fake',assurance:r.summary.assurance,finalityProven:true}])assert.throws(()=>validateAuthzRecord({...r,report},a));
});
test('stored display scope cannot be changed while retaining signed bytes',()=>{
 const r=record();for(const change of [{grantee:to},{granter:helper},{confirmationText:'approve'},{limitAtomic:'99999'},{feePayer:helper},{submissionEnabled:false}])assert.throws(()=>validateAuthzRecord({...r,summary:{...r.summary,...change}},a));
});
const response=()=>({grants:[{authorization:{'@type':AUTHZ_TYPES.authorization,spend_limit:[{denom:n.denom,amount:'3000000'}],allow_list:[to]},expiration:'2026-09-06T06:53:20Z'}],pagination:{next_key:null,total:'0'}});
async function observation(v){const rpc=new CosmosRpc();rpc.rest=async()=>v;const e=new CosmosAuthzEngine({rpc});return e.grantAt(n,a.address,helper,5);}
test('grant query distinguishes absent permission and restrictive allowance',async()=>{assert.equal(await observation({grants:[],pagination:{next_key:null,total:'0'}}),null);const g=await observation(response());assert.equal(g.kind,'restricted-send');assert.equal(g.remainingAtomic,'3000000');assert.equal(g.recipient,to);});
for(const [label,mutate]of [
 ['generic',v=>v.grants[0].authorization={'@type':'/cosmos.authz.v1beta1.GenericAuthorization',msg:AUTHZ_TYPES.send}],
 ['no recipients',v=>v.grants[0].authorization.allow_list=[]],
 ['multiple denominations',v=>v.grants[0].authorization.spend_limit.push({denom:'ugas',amount:'1'})],
 ['other denomination',v=>v.grants[0].authorization.spend_limit[0].denom='ugas'],
 ['no expiration',v=>v.grants[0].expiration=null],
 ['fractional expiration',v=>v.grants[0].expiration='2026-09-06T06:53:20.001Z']
])test('unsafe grant is observable for revocation but is not executable: '+label,async()=>{const v=response();mutate(v);assert.equal((await observation(v)).kind,'unsupported');});
for(const [label,mutate]of [
 ['more grants',v=>v.grants.push(structuredClone(v.grants[0]))],
 ['pagination',v=>v.pagination.next_key='MORE'],
 ['zero remaining',v=>v.grants[0].authorization.spend_limit[0].amount='0'],
 ['unsafe numeric quantity',v=>v.grants[0].authorization.spend_limit[0].amount=3000000],
 ['invalid recipient',v=>v.grants[0].authorization.allow_list[0]='invalid']
])test('malformed grant fails closed: '+label,async()=>{const v=response();mutate(v);await assert.rejects(observation(v));});
test('grant fetch is restricted to two exact addresses and no foreign path',async()=>{
 const rpc=new CosmosRpc({fetchImpl:()=>{throw Error('unexpected network');}});
 for(const path of ['cosmos/authz/v1beta1/grants?granter=a&grantee=b&msg_type_url=evil','cosmos/authz/v1beta1/grants?granter=a&granter=b','cosmos/authz/v1beta1/grants/granter/x','https://remote.invalid/'])await assert.rejects(rpc.rest(n,0,path,{height:5}));
});

test('owner status advertises v0.20 restricted Cosmos authorization without AI enablement',async()=>{
 const {serverFixture}=await import('./fixtures.mjs');const f=await serverFixture();try{
  const v=await f.call('status');assert.equal(v.release,'0.23.0-dev.20260906');
  assert.equal(v.nonEvmCapabilities.cosmosNativeRestrictedAuthorization,true);assert.equal(v.nonEvmCapabilities.cosmosAuthzAgentIntegration,false);
  assert.equal(v.nonEvmCapabilities.agentSubmission,false);assert.equal(v.mainnetSigning,false);
 }finally{await f.close();}
});
