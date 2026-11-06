/** Independent test-only decoder/OpenSSL verifier. Not used by the signer. */
import {createPublicKey,createHash,verify} from 'node:crypto';
import {accountAddress} from '../codec/bech32.mjs';
const ok=(v,m)=>{if(!v)throw Error('TEST_WIRE_'+m);};
function vi(n){n=BigInt(n);const out=[];do{out.push(Number(n&127n)|(n>=128n?128:0));n>>=7n;}while(n);return Buffer.from(out);}
const pb=(n,b)=>Buffer.concat([vi(n*8+2),vi(b.length),b]);
const pn=(n,v)=>BigInt(v)===0n?Buffer.alloc(0):Buffer.concat([vi(n*8),vi(v)]);
function fields(b){let pos=0;const o=new Map();const take=()=>{let v=0n;for(let k=0;k<10;k++){ok(pos<b.length,'SHORT');const c=b[pos++];v|=BigInt(c&127)<<BigInt(k*7);if(!(c&128))return v;}throw Error('TEST_WIRE_VARINT');};while(pos<b.length){const tag=take(),f=Number(tag>>3n),w=Number(tag&7n);ok(!o.has(f)&&f>0,'DUPLICATE');let v;if(w===0)v=take();else{ok(w===2,'TYPE');const n=Number(take());ok(n>=0&&n<=16384&&pos+n<=b.length,'LENGTH');v=b.subarray(pos,pos+n);pos+=n;}o.set(f,v);}return o;}
const s=(v,f)=>v.get(f)?.toString('utf8')??'';
const i=(v,f)=>String(v.get(f)??0n);
const hash=b=>createHash('sha256').update(b).digest();
export async function decodeAuthz(raw,chainId,resolveAccountNumber,{simulation=false}={}){
  raw=Buffer.from(raw);const tx=fields(raw),body=fields(tx.get(1)),auth=fields(tx.get(2)),signer=fields(auth.get(1));
  ok(tx.size===3&&body.size<=3&&auth.size===2,'ENVELOPE');
  const keyAny=fields(signer.get(1));ok(s(keyAny,1)==='/cosmos.crypto.secp256k1.PubKey','PUBKEY_TYPE');
  const pub=fields(keyAny.get(2)).get(1),mode=fields(fields(signer.get(2)).get(1));ok(i(mode,1)==='1'&&pub.length===33,'MODE');
  const from=accountAddress('cosmos',createHash('ripemd160').update(hash(pub)).digest()),accountNumber=await resolveAccountNumber(from);
  const doc=Buffer.concat([pb(1,tx.get(1)),pb(2,tx.get(2)),pb(3,Buffer.from(chainId)),pn(4,accountNumber)]),signature=tx.get(3);
  ok(signature.length===64,'SIG_LEN');
  if(simulation)ok(signature.equals(Buffer.alloc(64)),'REAL_SIGNATURE_LEAKED');else{
    const key=createPublicKey({key:Buffer.concat([Buffer.from('3036301006072a8648ce3d020106052b8104000a032200','hex'),pub]),format:'der',type:'spki'});
    ok(verify('sha256',doc,{key,dsaEncoding:'ieee-p1363'},signature),'SIGNATURE');
  }
  const any=fields(body.get(1)),type=s(any,1),m=fields(any.get(2)),fee=fields(auth.get(2)),feeCoin=fields(fee.get(1));
  const result={from,type,sequence:i(signer,3),timeoutHeight:i(body,3),memo:s(body,2),feeAtomic:s(feeCoin,2),feeDenom:s(feeCoin,1),gasLimit:i(fee,2),hash:hash(raw).toString('hex').toUpperCase()};
  if(type==='/cosmos.authz.v1beta1.MsgGrant'){
    const g=fields(m.get(3)),z=fields(g.get(1)),a=fields(z.get(2)),c=fields(a.get(1));
    ok(s(z,1)==='/cosmos.bank.v1beta1.SendAuthorization'&&m.size===3&&g.size===2&&a.size===2,'GRANT_TYPE');
    return {...result,action:'grant',granter:s(m,1),grantee:s(m,2),denom:s(c,1),limitAtomic:s(c,2),recipient:s(a,2),expirationSeconds:i(fields(g.get(2)),1)};
  }
  if(type==='/cosmos.authz.v1beta1.MsgRevoke'){
    ok(s(m,3)==='/cosmos.bank.v1beta1.MsgSend'&&m.size===3,'REVOKE_TYPE');return {...result,action:'revoke',granter:s(m,1),grantee:s(m,2)};
  }
  ok(type==='/cosmos.authz.v1beta1.MsgExec'&&m.size===2,'EXEC_TYPE');
  const inner=fields(m.get(2));ok(s(inner,1)==='/cosmos.bank.v1beta1.MsgSend','NESTED_MSG');const send=fields(inner.get(2)),c=fields(send.get(3));
  return {...result,action:'execute',grantee:s(m,1),granter:s(send,1),recipient:s(send,2),denom:s(c,1),amountAtomic:s(c,2)};
}
