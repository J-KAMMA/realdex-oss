#!/usr/bin/env python3
"""Generate independent protobuf and rational-arithmetic fixtures. No network.
Requires google.protobuf for wire cross-check; arithmetic uses Python's stdlib.
The field numbers match the pinned InjectiveLabs proto cited in SOURCES.md.
"""
from pathlib import Path
from fractions import Fraction
import json, random
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory
HERE=Path(__file__).resolve().parent
file=descriptor_pb2.FileDescriptorProto(name='realdex_spot_reference.proto',package='spot_reference',syntax='proto3')
def message(name,items):
 m=file.message_type.add(name=name)
 for number,fieldname,typ,repeated in items:
  f=m.field.add(number=number,name=fieldname,label=3 if repeated else 1)
  if isinstance(typ,str): f.type=11;f.type_name='.spot_reference.'+typ
  else:f.type=typ
# Types from descriptor.proto: string=9, sint32=17, sint64=18, uint64=4.
message('Meta',[(3,'symbol',9,False),(5,'decimals',17,False)])
message('Market',[(1,'market_id',9,False),(2,'market_status',9,False),(3,'ticker',9,False),(4,'base_denom',9,False),(5,'base_token_meta','Meta',False),(6,'quote_denom',9,False),(7,'quote_token_meta','Meta',False),(9,'taker_fee_rate',9,False),(11,'min_price_tick_size',9,False),(12,'min_quantity_tick_size',9,False),(13,'min_notional',9,False)])
message('MarketResponse',[(1,'market','Market',False)])
message('Level',[(1,'price',9,False),(2,'quantity',9,False)])
message('Book',[(1,'buys','Level',True),(2,'sells','Level',True),(3,'sequence',4,False),(4,'timestamp',18,False),(5,'height',18,False)])
message('BookResponse',[(1,'orderbook','Book',False)])
message('BookRequest',[(1,'market_id',9,False),(2,'depth',17,False)])
pool=descriptor_pool.DescriptorPool();pool.Add(file)
def cls(n):return message_factory.GetMessageClass(pool.FindMessageTypeByName('spot_reference.'+n))
market=cls('MarketResponse')();m=market.market;m.market_id='0x'+'ab'*32;m.market_status='active';m.ticker='DEMO/USDx';m.base_denom='udemo';m.base_token_meta.symbol='DEMO';m.base_token_meta.decimals=18;m.quote_denom='uusdx';m.quote_token_meta.symbol='USDx';m.quote_token_meta.decimals=6;m.taker_fee_rate='0.002';m.min_price_tick_size='0.000000000001';m.min_quantity_tick_size='10000000000000000';m.min_notional='1'
book=cls('BookResponse')();b=book.orderbook;b.buys.add(price='0.00000000001',quantity='500000000000000000');b.buys.add(price='0.000000000009',quantity='2000000000000000000');b.sells.add(price='0.000000000011',quantity='1000000000000000000');b.sells.add(price='0.000000000012',quantity='2000000000000000000');b.sequence=9007199254740993;b.timestamp=1788652800000;b.height=100
req=cls('BookRequest')(market_id=m.market_id,depth=50)
wire={'scope':'independent Python protobuf serialization, not live Injective','marketHex':market.SerializeToString().hex(),'bookHex':book.SerializeToString().hex(),'requestHex':req.SerializeToString().hex()}
(HERE/'golden-protobuf.json').write_text(json.dumps(wire,indent=2)+'\n')
rng=random.Random(250906)
def ceil(f):return -(-f.numerator//f.denominator)
def floor(f):return f.numerator//f.denominator
vectors=[]
for i in range(512):
 sell=(i%2==0);lot=rng.randint(1,5);rates=[Fraction(0),Fraction(1,500),Fraction(1,100),Fraction(1,10)];rate=rng.choice(rates);prices=sorted(rng.sample(range(1,81),rng.randint(1,5)),reverse=sell)
 levels=[{'price':{'numerator':str(Fraction(p,4).numerator),'denominator':str(Fraction(p,4).denominator)},'baseAtomic':str(rng.randint(1,20)*lot)}for p in prices]
 remaining=budget=rng.randint(1,700);base=total=fees=0;stop='depth-exhausted'
 for level in levels:
  p=Fraction(int(level['price']['numerator']),int(level['price']['denominator']));available=int(level['baseAtomic'])
  def gross(qty):return floor(qty*p) if sell else ceil(qty*p)
  def fee(qty):return ceil(gross(qty)*rate)
  if sell:take=min(remaining,available)//lot*lot
  else:take=max((q for q in range(0,available+1,lot) if gross(q)+fee(q)<=remaining),default=0)
  if take==0:stop='residual-input';break
  g=gross(take);f=fee(take);base+=take;total+=g;fees+=f;remaining-=take if sell else g+f
  if remaining==0:stop='filled';break
  if take<available:stop='residual-input';break
 if base==0:stop='no-fill'
 vectors.append({'side':'sell-base' if sell else 'buy-base','inputAtomic':str(budget),'lotAtomic':str(lot),'rate':{'numerator':str(rate.numerator),'denominator':str(rate.denominator)},'levels':levels,'expected':{'baseFilledAtomic':str(base),'quoteNotionalAtomic':str(total),'tradingFeeQuoteAtomic':str(fees),'remainingInputAtomic':str(remaining),'fillStatus':stop,'estimatedOutputAfterTradingFeeAtomic':str(total-fees if sell else base) if base else None}})
(HERE/'arithmetic-vectors.json').write_text(json.dumps({'scope':'Python Fraction plus exhaustive per-level affordable lot enumeration; not global route optimization','cases':vectors},indent=2)+'\n')
print(json.dumps({'protobufFixtures':3,'arithmeticCases':len(vectors),'networkUsed':False}))
