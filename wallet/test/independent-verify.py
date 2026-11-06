#!/usr/bin/env python3
"""Independent Python parsers + cryptography/OpenSSL signature verification.
No production JS parser/signature routine is called by this verifier.
Keccak digests come from the JS output; EIP155 official vector separately anchors
one digest/transaction. This is not a second independent Keccak implementation.
"""
import json,sys,base64,hashlib,zlib
from cryptography.hazmat.primitives.asymmetric import ec,ed25519,utils
from cryptography.hazmat.primitives import hashes,serialization
B58='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def b58d(s):
 n=0
 for c in s:n=n*58+B58.index(c)
 return b'\0'*(len(s)-len(s.lstrip('1')))+(n.to_bytes((n.bit_length()+7)//8,'big') if n else b'')
def principal(s):
 raw=base64.b32decode(s.replace('-','').upper()+'='*((-len(s.replace('-','')))%8));assert zlib.crc32(raw[4:]).to_bytes(4,'big')==raw[:4];return raw[4:]
def leb(n):
 out=[]
 while n>127:out.append((n&127)|128);n>>=7
 return bytes(out+[n])
def label(s):
 n=0
 for b in s.encode():n=(n*223+b)&0xffffffff
 return n
class Reader:
 def __init__(self,b):self.b=b;self.i=0
 def read(self,n):r=self.b[self.i:self.i+n];self.i+=n;assert len(r)==n;return r
 def u(self):
  n=shift=0
  while True:
   b=self.read(1)[0];n|=(b&127)<<shift;shift+=7
   if not b&128:return n
 def s(self):
  n=shift=0
  while True:
   b=self.read(1)[0];n|=(b&127)<<shift;shift+=7
   if not b&128:return n-(1<<shift) if b&64 else n
 def cbor(self):
  x=self.read(1)[0];major=x>>5;add=x&31
  if major==7:return {20:False,21:True,22:None}[add]
  n=add if add<24 else int.from_bytes(self.read({24:1,25:2,26:4,27:8}[add]),'big')
  if major==0:return n
  if major==1:return -1-n
  if major==2:return self.read(n)
  if major==3:return self.read(n).decode()
  if major==4:return [self.cbor() for _ in range(n)]
  if major==5:return {self.cbor():self.cbor() for _ in range(n)}
  if major==6:assert n==55799;return self.cbor()
  raise AssertionError('CBOR major')
 def rlp(self):
  x=self.read(1)[0]
  if x<128:return bytes([x])
  if x<184:return self.read(x-128)
  if x<192:return self.read(int.from_bytes(self.read(x-183),'big'))
  n=x-192 if x<248 else int.from_bytes(self.read(x-247),'big');end=self.i+n;out=[]
  while self.i<end:out.append(self.rlp())
  assert self.i==end;return out

def candid(b):
 r=Reader(b);assert r.read(4)==b'DIDL';types=[]
 for _ in range(r.u()):
  op=r.s()
  if op in (-18,-19):types.append((op,r.s()))
  elif op==-20:types.append((op,[(r.u(),r.s()) for _ in range(r.u())]))
  else:raise AssertionError('Candid type')
 count=r.u();args=[r.s() for _ in range(count)]
 def value(t):
  if t==-3:return r.u()
  if t==-8:return int.from_bytes(r.read(8),'little')
  if t==-5:return r.read(1)[0]
  if t==-24:assert r.read(1)==b'\x01';return r.read(r.u())
  op,p=types[t]
  if op==-19:return bytes(value(p) for _ in range(r.u()))
  if op==-18:
   tag=r.read(1)[0];assert tag in (0,1);return value(p) if tag else None
  if op==-20:return {k:value(v) for k,v in p}
  raise AssertionError('Candid value')
 out=[value(a) for a in args];assert r.i==len(b);return out

def h(x):return hashlib.sha256(x).digest()
def request_id(c):
 def v(x):
  if isinstance(x,str):return h(x.encode())
  if isinstance(x,int):return h(leb(x))
  if isinstance(x,bytes):return h(x)
  if isinstance(x,list):return h(b''.join(map(v,x)))
  raise AssertionError('Hash type')
 return h(b''.join(k+val for k,val in sorted((h(k.encode()),v(val)) for k,val in c.items())))
def evm_sig(pub,digest,r,s):
 pub.verify(utils.encode_dss_signature(r,s),digest,ec.ECDSA(utils.Prehashed(hashes.SHA256())))

def run(data):
 counts={}
 for v in data['ecdsa']:
  key=ec.derive_private_key(int(v['secret'],16),ec.SECP256K1());pub=key.public_key();assert pub.public_bytes(serialization.Encoding.X962,serialization.PublicFormat.UncompressedPoint).hex()==v['publicKey'];sig=bytes.fromhex(v['signature']);evm_sig(pub,bytes.fromhex(v['digest']),int.from_bytes(sig[:32],'big'),int.from_bytes(sig[32:],'big'))
 counts['ecdsaOpenSSL']=len(data['ecdsa'])
 for v in data['evm']:
  t=v['transaction'];s=v['signed'];b=bytes.fromhex(s['rawTransaction'][2:]);r=Reader(b[1:] if t['type']==2 else b);fields=r.rlp();assert r.i==len(r.b)
  n=lambda x:int.from_bytes(x,'big')
  if t['type']==2:
   assert b[0]==2 and len(fields)==12;assert [n(fields[i]) for i in range(5)]==list(map(int,[t['chainId'],t['nonce'],t['maxPriorityFeePerGas'],t['maxFeePerGas'],t['gasLimit']]));assert fields[5].hex()==t['to'][2:] and n(fields[6])==int(t['value']) and fields[7].hex()==t['data'][2:] and fields[8]==[];assert n(fields[9]) in [0,1]
  else:
   assert len(fields)==9;assert [n(fields[i]) for i in range(3)]==list(map(int,[t['nonce'],t['gasPrice'],t['gasLimit']]));assert fields[3].hex()==t['to'][2:] and n(fields[4])==int(t['value']) and fields[5].hex()==t['data'][2:];assert n(fields[6]) in [2*int(t['chainId'])+35,2*int(t['chainId'])+36]
  pub=ec.derive_private_key(int(v['secret'],16),ec.SECP256K1()).public_key();evm_sig(pub,bytes.fromhex(s['signingDigest'][2:]),n(fields[-2]),n(fields[-1]))
 counts['evmWireAndSignature']=len(data['evm'])
 for v in data['solana']:
  key=ed25519.Ed25519PrivateKey.from_private_bytes(bytes.fromhex(v['seed']));pub=key.public_key();b=base64.b64decode(v['transactionBase64']);assert len(b)==215 and b[0]==1;m=b[65:];pub.verify(b[1:65],m);i=v['input'];assert m[:4]==bytes([1,0,1,3]);assert m[4:36]==b58d(i['from']);assert m[36:68]==b58d(i['to']);assert m[68:100]==bytes(32);assert m[100:132]==b58d(i['recentBlockhash']);assert m[132:138]==bytes([1,2,2,0,1,12]);assert int.from_bytes(m[138:142],'little')==2 and int.from_bytes(m[142:],'little')==int(i['lamports'])
 counts['solanaWireAndSignature']=len(data['solana'])
 for v in data['icp']:
  b=base64.b64decode(v['envelopeBase64']);r=Reader(b);env=r.cbor();assert r.i==len(b);c=env['content'];rid=request_id(c);assert rid.hex()==v['requestId'];pub=serialization.load_der_public_key(env['sender_pubkey']);pub.verify(env['sender_sig'],b'\x0aic-request'+rid)
  assert hashlib.sha224(env['sender_pubkey']).digest()+b'\x02'==c['sender']==principal(v['sender']);i=v['input'];assert c['canister_id']==principal(i['ledger']) and c['ingress_expiry']==int(i['ingressExpiryNs']);assert c['request_type']=='call' and c['method_name']=='icrc1_transfer';t=candid(c['arg'])[0];x=i['transfer'];assert t[label('amount')]==int(x['amountAtomic']) and t[label('fee')]==int(x['feeAtomic']) and t[label('created_at_time')]==int(x['createdAtTimeNs']);assert t[label('memo')].hex()==x['memoHex'];a=t[label('to')];assert a[label('owner')]==principal(x['to']['owner']) and a[label('subaccount')].hex()==x['to']['subaccount'];assert t[label('from_subaccount')].hex()==x['fromSubaccount']
 counts['icpCborCandidRequestAndSignature']=len(data['icp'])
 return {'passed':True,'cases':counts,'totalCases':sum(counts.values()),'liveChain':False,'independentKeccak':False,'runtime':'Python cryptography/OpenSSL + independent parsers'}
if __name__=='__main__':print(json.dumps(run(json.load(open(sys.argv[1]))),indent=2))
