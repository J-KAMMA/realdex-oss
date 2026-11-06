"""Independent exact accounting and protobuf construction; no Injective SDK or RPC."""
import sys,json,base64
from decimal import Decimal,localcontext
r=json.load(sys.stdin)
def var(n):
 b=bytearray()
 while n>=128:b.append((n&127)|128);n>>=7
 b.append(n);return bytes(b)
def field(i,b):
 if isinstance(b,str):b=b.encode()
 return var(i*8+2)+var(len(b))+b
def integer(i,n):return b'' if n==0 else var(i*8)+var(n)
def un(s):return base64.b64decode(s,validate=True)
p=r['plan'];tx=r['transaction'];a=r['account'];pol=r['policy']
# Rebuild the nested order independently from original human quantities.
with localcontext() as c:
 c.prec=200
 price=Decimal(p['input']['limitPrice'])*Decimal(10)**(p['quoteAsset']['decimals']-p['baseAsset']['decimals']+18)
 quantity=Decimal(p['input']['quantity'])*Decimal(10)**(p['baseAsset']['decimals']+18)
 fee=int((Decimal(pol['gasLimit'])*Decimal(pol['gasPriceAtomic'])).to_integral_value(rounding='ROUND_CEILING'))
 notional=Decimal(p['input']['limitPrice'])*Decimal(p['input']['quantity'])*Decimal(10)**p['quoteAsset']['decimals']
 trading=int((notional*Decimal(pol['maxTradingFeeBps'])/10000).to_integral_value(rounding='ROUND_CEILING'))
 assert str(fee)==r['costs']['gasFeeAtomic'] and str(trading)==r['costs']['tradingFeeQuoteCapAtomic']
info=field(1,p['input']['subaccountId'])+field(2,a['address'])+field(3,str(int(price)))+field(4,str(int(quantity)))+field(5,p['clientOrderId'])
order=field(1,p['marketId'])+field(2,info)+integer(3,1 if p['input']['side']=='buy' else 2)+field(4,'0')
message=field(1,a['address'])+field(2,order)
anymsg=field(1,'/injective.exchange.v1beta1.MsgCreateSpotLimitOrder')+field(2,message)
body=field(1,anymsg)+integer(3,int(r['anchor']['height'])+int(pol['timeoutBlocks']))
pub=field(1,'/injective.crypto.v1beta1.ethsecp256k1.PubKey')+field(2,field(1,bytes.fromhex(a['publicKeyHex'])))
signer=field(1,pub)+field(2,field(1,integer(1,1)))+integer(3,int(a['sequence']))
auth=field(1,signer)+field(2,field(1,field(1,'inj')+field(2,str(fee)))+integer(2,int(pol['gasLimit'])))
sign=field(1,body)+field(2,auth)+field(3,r['chainId'])+integer(4,int(a['accountNumber']))
sim=field(1,body)+field(2,auth)+field(3,b'')
for key,expected in [('bodyBytesBase64',body),('authInfoBytesBase64',auth),('signDocBase64',sign),('simulationTxBase64',sim)]:assert un(tx[key])==expected,key
assert tx['signatures']==[]
print(json.dumps({'passed':True,'independentProtobuf':True,'signed':False,'liveVenue':False}))
