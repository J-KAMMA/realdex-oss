#!/usr/bin/env python3
"""Recompute independent oracle vectors using Python standard-library CRC32/base32
and a small Candid wire encoder written separately from the production decoder.
This is not dfx, an official Candid SDK, a compiler, or a live-ledger test.
"""
import base64,json,zlib
from pathlib import Path
HERE=Path(__file__).resolve().parent

def uleb(n):
 out=bytearray()
 while True:
  b=n&127;n>>=7;out.append(b|128 if n else b)
  if not n:return out

def sleb(n):
 out=bytearray()
 while True:
  b=n&127;n>>=7;done=(n==0 and b&64==0) or (n==-1 and b&64!=0);out.append(b if done else b|128)
  if done:return out

def label(s):
 n=0
 for b in s.encode():n=(n*223+b)%(2**32)
 return n

def text(s):
 b=s.encode();return uleb(len(b))+b

def primitive(t,b):return (b'DIDL\0\1'+sleb(t)+b).hex()

def account_args(owner,subaccount):
 fields=sorted([(label('owner'),-24,b'\1'+uleb(len(owner))+owner),(label('subaccount'),1,b'\1'+uleb(32)+subaccount)])
 table=sleb(-19)+sleb(-5)+sleb(-18)+sleb(0)+sleb(-20)+uleb(2)
 for name,t,_ in fields:table+=uleb(name)+sleb(t)
 return (b'DIDL'+uleb(3)+table+b'\1\2'+b''.join(v for _,_,v in fields)).hex()

def main():
 entries=json.loads((HERE/'v06-principal-vectors.json').read_text())['vectors']
 for v in entries:
  b=bytes.fromhex(v['hex']);crc=zlib.crc32(b).to_bytes(4,'big');raw=base64.b32encode(crc+b).decode().lower().rstrip('=');display='-'.join(raw[i:i+5] for i in range(0,len(raw),5));assert display==v['text']
 computed={'icrc1_name':primitive(-15,text('Fixture Ledger')),'icrc1_symbol':primitive(-15,text('ICP')),'icrc1_decimals':primitive(-5,b'\x08'),'icrc1_fee':primitive(-3,uleb(10000)),'icrc1_balance_of':primitive(-3,uleb(123)),'icrc1_total_supply':primitive(-3,uleb(2**80+17))}
 fields=sorted([(label('name'),'name'),(label('url'),'url')]);table=sleb(-20)+uleb(2)+b''.join(uleb(i)+sleb(-15) for i,_ in fields)+sleb(-19)+sleb(0)
 standards=[{'name':'ICRC-1','url':'https://github.com/dfinity/ICRC-1'},{'name':'ICRC-2','url':'https://github.com/dfinity/ICRC-1/tree/main/standards/ICRC-2'}]
 computed['icrc1_supported_standards']=(b'DIDL'+uleb(2)+table+b'\1\1'+uleb(2)+b''.join(text(v[k]) for v in standards for _,k in fields)).hex()
 assert computed==json.loads((HERE/'v06-candid-vectors.json').read_text())['vectors']
 account=account_args(bytes.fromhex('00000000000000020101'),bytes(32))
 actual=json.loads((HERE/'v06-account-vector.json').read_text());assert actual['hex']==account
 print(json.dumps({'principalVectors':len(entries),'candidReplyVectors':len(computed),'candidAccountVectors':1,'passed':True,'oracle':'Python stdlib plus independent Candid subset encoder','officialSdkTested':False},indent=2))
if __name__=='__main__':main()
