"""Independent protobuf encoder and Decimal gas calculation; no imported RealDEX modules."""
import base64,json,sys
from decimal import Decimal,localcontext,ROUND_CEILING
r=json.load(sys.stdin);a=r['action'];ac=r['account'];p=r['policy']
def var(n):
 out=bytearray()
 while n>=128:out.append((n&127)|128);n>>=7
 out.append(n);return bytes(out)
def f(i,b):
 if isinstance(b,str):b=b.encode()
 return var(i*8+2)+var(len(b))+b
def n(i,x):return b'' if x==0 else var(i*8)+var(x)
with localcontext() as c:
 c.prec=200;fee=str(int((Decimal(p['gasLimit'])*Decimal(p['gasPriceAtomic'])).to_integral_value(rounding=ROUND_CEILING)))
if a['kind']=='cancel':
 typ='/injective.exchange.v1beta1.MsgCancelSpotOrder'
 msg=f(1,a['sender'])+f(2,a['marketId'])+f(3,a['subaccountId'])+f(4,a['orderHash'])
else:
 assert a['kind'] in ('deposit','withdraw')
 typ='/injective.exchange.v1beta1.'+('MsgDeposit' if a['kind']=='deposit' else 'MsgWithdraw')
 assert a['destination']==(a['subaccountId'] if a['kind']=='deposit' else a['sender'])
 msg=f(1,a['sender'])+f(2,a['subaccountId'])+f(3,f(1,a['denom'])+f(2,a['amountAtomic']))
body=f(1,f(1,typ)+f(2,msg))+n(3,int(r['anchor']['height'])+p['timeoutBlocks'])
pub=f(1,'/injective.crypto.v1beta1.ethsecp256k1.PubKey')+f(2,f(1,bytes.fromhex(ac['publicKeyHex'])))
signer=f(1,pub)+f(2,f(1,n(1,1)))+n(3,int(ac['sequence']))
auth=f(1,signer)+f(2,f(1,f(1,'inj')+f(2,fee))+n(2,int(p['gasLimit'])))
doc=f(1,body)+f(2,auth)+f(3,'injective-888')+n(4,int(ac['accountNumber']))
sim=f(1,body)+f(2,auth)+f(3,b'')
for k,v in [('bodyBytesBase64',body),('authInfoBytesBase64',auth),('signDocBase64',doc),('simulationTxBase64',sim)]:
 assert base64.b64decode(r['transaction'][k],validate=True)==v,k
assert r['transaction']['fee']['amount']==fee
print(json.dumps({'passed':True,'signed':False,'network':False,'kind':a['kind']}))
