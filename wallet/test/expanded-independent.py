#!/usr/bin/env python3
"""Independent Python wire parsers + cryptography/OpenSSL signature checks.
Public test vectors only; no network, no private key input, no wallet writes.
This is format/signature verification, NOT execution by Bitcoin/Cosmos/Stellar/Aptos.
"""
import argparse,base64,binascii,hashlib,json,pathlib,struct,subprocess
from cryptography.hazmat.primitives.asymmetric import ec,ed25519,utils
from cryptography.hazmat.primitives import hashes
ROOT=pathlib.Path(__file__).resolve().parents[2]
H=lambda b:hashlib.sha256(b).digest()
H2=lambda b:H(H(b))
S3=lambda b:hashlib.sha3_256(b).digest()
class Reader:
    def __init__(self,b):self.b=b;self.i=0
    def take(self,n):assert n>=0 and self.i+n<=len(self.b);r=self.b[self.i:self.i+n];self.i+=n;return r
    def u8(self):return self.take(1)[0]
    def n(self,f):return struct.unpack(f,self.take(struct.calcsize(f)))[0]
    def end(self):assert self.i==len(self.b)
    def varint(self):
        n=shift=0
        while True:
            b=self.u8();n|=(b&127)<<shift
            if b<128:return n
            shift+=7;assert shift<=70
    def vec(self):return self.take(self.varint())
    def xdr(self):
        n=self.n('>I');b=self.take(n);assert self.take((-n)%4)==b'\0'*((-n)%4);return b

def protobuf(b):
    r=Reader(b);out={}
    while r.i<len(b):
        tag=r.varint();field=tag>>3;wire=tag&7;assert field>0 and wire in (0,2)
        v=r.varint() if wire==0 else r.vec();out.setdefault(field,[]).append(v)
    return out

def one(o,k,default=None):
    if k not in o:return default
    assert len(o[k])==1;return o[k][0]

def check_secp(pub,digest,sig):
    assert len(sig)==64
    rr=int.from_bytes(sig[:32],'big');ss=int.from_bytes(sig[32:],'big')
    assert 0<ss<=int('fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',16)//2
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256K1(),pub).verify(utils.encode_dss_signature(rr,ss),digest,ec.ECDSA(utils.Prehashed(hashes.SHA256())))

def bech_payload(address,witness=False):
    _,data=address.rsplit('1',1);chars='qpzry9x8gf2tvdw0s3jn54khce6mua7l';v=[chars.index(c) for c in data[:-6]]
    if witness:assert v.pop(0)==0
    bits=''.join(f'{x:05b}' for x in v);payload=bytes(int(bits[i:i+8],2) for i in range(0,len(bits)-7,8));assert set(bits[len(payload)*8:])<={'0'};return payload

def bitcoin(p,s):
    raw=bytes.fromhex(s['rawTransactionHex']);r=Reader(raw);version=r.n('<I');assert version==2 and r.take(2)==b'\0\1'
    count=r.u8();assert count==len(p['utxos']) and count<253
    inputs=[]
    for _ in range(count):
        txid=r.take(32);vout=r.n('<I');assert r.u8()==0;seq=r.n('<I');assert seq==0xffffffff;inputs.append((txid,vout,seq))
    oc=r.u8();assert oc in (1,2);outs=[]
    for _ in range(oc):
        amount=r.n('<Q');script=r.take(r.u8());assert len(script)==22 and script[:2]==b'\0\x14';outs.append((amount,script))
    witness=[]
    for _ in range(count):
        assert r.u8()==2;der=r.take(r.u8());pub=r.take(r.u8());assert len(pub)==33 and der[-1]==1;witness.append((der[:-1],pub))
    assert r.n('<I')==0;r.end()
    for parsed,u in zip(inputs,p['utxos']):assert parsed[0][::-1].hex()==u['txid'] and parsed[1]==u['vout']
    assert outs[0]==(int(p['amountAtomic']),b'\0\x14'+bech_payload(p['to'],True))
    if oc==2:assert outs[1]==(int(p['changeAtomic']),b'\0\x14'+bech_payload(p['from'],True))
    assert sum(int(i['amountAtomic']) for i in p['utxos'])-sum(o[0] for o in outs)==int(p['feeAtomic'])
    prev=b''.join(i[0]+struct.pack('<I',i[1]) for i in inputs);seqs=b''.join(struct.pack('<I',i[2]) for i in inputs)
    outputs=b''.join(struct.pack('<Q',a)+bytes([len(sc)])+sc for a,sc in outs)
    stripped=struct.pack('<I',version)+bytes([count])+b''.join(i[0]+struct.pack('<I',i[1])+b'\0'+struct.pack('<I',i[2]) for i in inputs)+bytes([oc])+outputs+b'\0'*4
    assert H2(stripped)[::-1].hex()==s['requestId'] and H2(raw)[::-1].hex()==s['wtxid']
    assert s['vsize']==(len(stripped)*3+len(raw)+3)//4
    for idx,(der,pub) in enumerate(witness):
        kh=hashlib.new('ripemd160',H(pub)).digest();assert kh==bech_payload(p['from'],True)
        code=b'\x76\xa9\x14'+kh+b'\x88\xac';inp=inputs[idx]
        pre=struct.pack('<I',version)+H2(prev)+H2(seqs)+inp[0]+struct.pack('<I',inp[1])+bytes([len(code)])+code+struct.pack('<Q',int(p['utxos'][idx]['amountAtomic']))+struct.pack('<I',inp[2])+H2(outputs)+struct.pack('<II',0,1)
        rr,ss=utils.decode_dss_signature(der);check_secp(pub,H2(pre),rr.to_bytes(32,'big')+ss.to_bytes(32,'big'))

def cosmos(p,s):
    raw=base64.b64decode(s['txRawBase64']);tx=protobuf(raw);assert set(tx)=={1,2,3};body=protobuf(one(tx,1));auth=protobuf(one(tx,2))
    msgAny=protobuf(one(body,1));assert one(msgAny,1)==b'/cosmos.bank.v1beta1.MsgSend';msg=protobuf(one(msgAny,2))
    assert one(msg,1).decode()==p['networkFrom'] and one(msg,2).decode()==p['to'];coin=protobuf(one(msg,3));assert one(coin,1).decode()==p['denom'] and one(coin,2).decode()==p['amountAtomic']
    assert one(body,2,b'').decode()==p['memo'] and one(body,3,0)==int(p['timeoutHeight'])
    signer=protobuf(one(auth,1));pk=protobuf(one(signer,1));assert one(pk,1)==b'/cosmos.crypto.secp256k1.PubKey';pub=one(protobuf(one(pk,2)),1)
    assert pub.hex()==s['publicKeyHex'] and hashlib.new('ripemd160',H(pub)).digest()==bech_payload(p['from'])
    mode=protobuf(one(protobuf(one(signer,2)),1));assert one(mode,1)==1 and one(signer,3,0)==int(p['sequence'])
    fee=protobuf(one(auth,2));fc=protobuf(one(fee,1));assert one(fc,1).decode()==p['feeDenom'] and one(fc,2).decode()==p['feeAtomic'] and one(fee,2)==int(p['gasLimit'])
    doc=protobuf(bytes.fromhex(s['signDocHex']));assert one(doc,1)==one(tx,1) and one(doc,2)==one(tx,2) and one(doc,3).decode()==p['chainId'] and one(doc,4,0)==int(p['accountNumber'])
    assert H(raw).hex().upper()==s['requestId'];check_secp(pub,H(bytes.fromhex(s['signDocHex'])),one(tx,3))

def strkey(s):
    raw=base64.b32decode(s);assert raw[0]==48 and raw[-2:]==binascii.crc_hqx(raw[:-2],0).to_bytes(2,'little');return raw[1:-2]

def stellar(p,s):
    raw=base64.b64decode(s['envelopeXdrBase64']);r=Reader(raw);assert r.n('>I')==2;start=r.i
    assert r.n('>I')==0;pub=r.take(32);assert pub==strkey(p['from']) and r.n('>I')==int(p['feeAtomic']) and r.n('>q')==int(p['sequence'])
    assert r.n('>I')==1 and r.n('>Q')==0 and r.n('>Q')==int(p['maxTime'])
    memo=r.n('>I');assert memo==(1 if p['memo'] else 0)
    if memo:assert r.xdr().decode()==p['memo']
    assert r.n('>I')==1 and r.n('>I')==0 and r.n('>I')==1 and r.n('>I')==0
    assert r.take(32)==strkey(p['to']) and r.n('>I')==0 and r.n('>q')==int(p['amountAtomic']) and r.n('>I')==0
    end=r.i;assert r.n('>I')==1 and r.take(4)==pub[-4:];sig=r.xdr();assert len(sig)==64;r.end()
    digest=H(H(p['networkPassphrase'].encode())+struct.pack('>I',2)+raw[start:end]);assert digest.hex()==s['requestId'];ed25519.Ed25519PublicKey.from_public_bytes(pub).verify(sig,digest)

def aptos(p,s):
    raw=bytes.fromhex(s['signedTransactionHex']);r=Reader(raw);sender=r.take(32);assert sender.hex()==p['from'][2:] and r.n('<Q')==int(p['sequence']) and r.varint()==2
    assert r.take(32)==b'\0'*31+b'\1' and r.vec()==b'aptos_account' and r.vec()==b'transfer' and r.varint()==0 and r.varint()==2
    assert r.vec().hex()==p['to'][2:] and int.from_bytes(r.vec(),'little')==int(p['amountAtomic'])
    assert r.n('<Q')==int(p['maxGasAmount']) and r.n('<Q')==int(p['gasUnitPrice']) and r.n('<Q')==int(p['expirationTimestampSecs']) and r.u8()==4
    end=r.i;assert r.varint()==0;pub=r.vec();sig=r.vec();r.end();assert len(pub)==32 and len(sig)==64 and S3(pub+b'\0')==sender
    assert raw[:end].hex()==s['rawTransactionHex'];ed25519.Ed25519PublicKey.from_public_bytes(pub).verify(sig,S3(b'APTOS::RawTransaction')+raw[:end]);assert s['requestId']=='0x'+S3(S3(b'APTOS::Transaction')+b'\0'+raw).hex()

def main():
    a=argparse.ArgumentParser();a.add_argument('--output',type=pathlib.Path,required=True);args=a.parse_args()
    out=subprocess.run(['node','wallet/test/expanded-vectors.mjs'],cwd=ROOT,check=True,capture_output=True,text=True,timeout=30)
    cases=json.loads(out.stdout)['vectors'];counts={f:0 for f in ('bitcoin','cosmos','stellar','aptos')}
    for c in cases:globals()[c['family']](c['payment'],c['signed']);counts[c['family']]+=1
    result={'status':'passed','cases':len(cases),'byFamily':counts,'scope':'Independent wire parsing and OpenSSL-backed signature verification only; no Bitcoin/Cosmos/Stellar/Aptos node or consensus execution','productionReady':False}
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
if __name__=='__main__':main()
