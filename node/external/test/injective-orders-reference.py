"""Independent Decimal and protobuf construction. Does not run a venue or signer."""
import sys,json,hashlib
from decimal import Decimal,localcontext

def varint(n):
    b=bytearray()
    while n>=128:b.append((n&127)|128);n>>=7
    b.append(n);return bytes(b)
def field(n,b):
    if isinstance(b,str):b=b.encode()
    return varint(n*8+2)+varint(len(b))+b

def check(v):
    i,p=v['input'],v['plan']
    with localcontext() as ctx:
        ctx.prec=180
        price=Decimal(i['limitPrice'])*Decimal(10)**(v['qd']-v['bd']+18)
        quantity=Decimal(i['quantity'])*Decimal(10)**(v['bd']+18)
        assert price==int(price) and quantity==int(quantity)
    cid='rdx-'+hashlib.sha256(json.dumps([p['network'],i['sender'],i['requestKey']],separators=(',',':')).encode()).hexdigest()[:32]
    info=field(1,i['subaccountId'])+field(2,i['sender'])+field(3,str(int(price)))+field(4,str(int(quantity)))+field(5,cid)
    order=field(1,p['marketId'])+field(2,info)+varint(3*8)+varint(1 if i['side']=='buy' else 2)+field(4,'0')
    raw=field(1,i['sender'])+field(2,order)
    import base64
    assert raw==base64.b64decode(p['message']['valueBase64'],validate=True)
    assert cid==p['clientOrderId']

vectors=json.load(sys.stdin)
for v in vectors:check(v)
print(json.dumps({'passed':len(vectors),'liveVenue':False,'signed':False}))
