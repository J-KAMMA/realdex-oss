#!/usr/bin/env python3
"""TEST ONLY: local JSON-RPC facade over LiteSVM; NOT an Agave validator.
Execution/signature checks/balances are from LiteSVM. RPC slot/finality/genesis
observations are synthetic fixture metadata. Never use with real funds.
"""
import base64, json, threading, sys, hashlib, struct
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from solders.litesvm import LiteSVM
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction
from solders.transaction_metadata import TransactionMetadata, SimulatedTransactionInfo
from solders.hash import Hash
from solders.signature import Signature
from solders.account import Account

lock=threading.RLock()
svm=LiteSVM().with_sigverify(True).with_blockhash_check(True)
genesis=str(Hash.from_bytes(hashlib.sha256(b'RealDEX-LiteSVM-fixture-no-real-genesis').digest()))
state={'slot':1,'height':1,'lastValid':151,'sent':0,'drop':False,'hide':False,'mismatch':False,'fee':5000,'commitment':'finalized'}
records={}
TOKEN_PROGRAM=Pubkey.from_string('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
def token_balances(keys):
    rows=[]
    for i,k in enumerate(keys):
        a=svm.get_account(Pubkey.from_string(k))
        if a and a.owner==TOKEN_PROGRAM and len(a.data)==165:
            d=bytes(a.data); mint=Pubkey.from_bytes(d[:32]);m=svm.get_account(mint)
            rows.append({'accountIndex':i,'mint':str(mint),'owner':str(Pubkey.from_bytes(d[32:64])),'programId':str(TOKEN_PROGRAM),'uiTokenAmount':{'amount':str(struct.unpack_from('<Q',d,64)[0]),'decimals':bytes(m.data)[44]}})
    return rows


def account_json(a):
    if a is None: return None
    return {'lamports':a.lamports,'owner':str(a.owner),'executable':a.executable,'rentEpoch':a.rent_epoch,'data':[base64.b64encode(bytes(a.data)).decode(),'base64'],'space':len(a.data)}
def context(value): return {'context':{'slot':state['slot']},'value':value}
def balance(key): return svm.get_balance(Pubkey.from_string(key)) or 0

def dispatch(method,p,peer):
    if method=='test_reset':
        global svm
        svm=LiteSVM().with_sigverify(True).with_blockhash_check(True)
        state.clear();state.update(slot=1,height=1,lastValid=151,sent=0,drop=False,hide=False,mismatch=False,fee=5000,commitment='finalized');records.clear();return True
    if method=='test_spl_setup':
        v=p[0];mint=bytearray(82);struct.pack_into('<Q',mint,36,int(v['sourceAmount'])+int(v['destinationAmount']));mint[44]=v['decimals'];mint[45]=1
        svm.set_account(Pubkey.from_string(v['mint']),Account(10000000,bytes(mint),TOKEN_PROGRAM))
        for addr,owner,amount in [(v['source'],v['from'],v['sourceAmount']),(v['destination'],v['to'],v['destinationAmount'])]:
            d=bytearray(165);d[:32]=bytes(Pubkey.from_string(v['mint']));d[32:64]=bytes(Pubkey.from_string(owner));struct.pack_into('<Q',d,64,int(amount));d[108]=1
            svm.set_account(Pubkey.from_string(addr),Account(10000000,bytes(d),TOKEN_PROGRAM))
        return True
    if method=='test_spl_mutate':
        addr,v=p;key=Pubkey.from_string(addr);a=svm.get_account(key);d=bytearray(a.data)
        if 'state' in v:d[108]=v['state']
        if 'amount' in v:struct.pack_into('<Q',d,64,int(v['amount']))
        if 'owner' in v:d[32:64]=bytes(Pubkey.from_string(v['owner']))
        if 'mint' in v:d[:32]=bytes(Pubkey.from_string(v['mint']))
        if 'decimals' in v:d[44]=v['decimals']
        if 'freezeAuthority' in v:struct.pack_into('<I',d,46,1);d[50:82]=bytes(Pubkey.from_string(v['freezeAuthority']))
        if 'delegate' in v:struct.pack_into('<I',d,72,1);d[76:108]=bytes(Pubkey.from_string(v['delegate']))
        if 'extra' in v:d+=bytes(v['extra'])
        svm.set_account(key,Account(a.lamports,bytes(d),Pubkey.from_string(v['program']) if 'program' in v else a.owner,a.executable,a.rent_epoch));return True
    if method=='getTokenAccountsByOwner':
        owner=p[0];mint=p[1]['mint'];rows=[]
        for k,a in svm.get_program_accounts(TOKEN_PROGRAM):
            d=bytes(a.data)
            if len(d)==165 and str(Pubkey.from_bytes(d[:32]))==mint and str(Pubkey.from_bytes(d[32:64]))==owner:rows.append({'pubkey':str(k),'account':account_json(a)})
        return context(rows)
    if method=='test_fund':
        key=Pubkey.from_string(p[0]);a=svm.get_account(key) or Account(0,b'',Pubkey.default())
        a=Account(p[1],bytes(a.data),a.owner,a.executable,a.rent_epoch);svm.set_account(key,a);return True
    if method=='test_control': state.update(p[0]);return True
    if method=='test_expire': svm.expire_blockhash();state['height']=state['lastValid']+1;state['slot']+=200;state['lastValid']=state['height']+150;return True
    if method=='test_info':return {**state,'genesis':genesis,'blockhash':str(svm.latest_blockhash())}
    if method=='getGenesisHash': return str(Hash.default()) if peer==2 and state['mismatch'] else genesis
    if method=='getHealth': return 'ok'
    if method=='getLatestBlockhash': return context({'blockhash':str(svm.latest_blockhash()),'lastValidBlockHeight':state['lastValid']})
    if method=='getBlockHeight':return state['height']
    if method=='isBlockhashValid':return context(p[0]==str(svm.latest_blockhash()))
    if method=='getBalance':return context(balance(p[0]))
    if method=='getMultipleAccounts':return context([account_json(svm.get_account(Pubkey.from_string(a))) for a in p[0]])
    if method=='getFeeForMessage':return context(state['fee'])
    if method=='simulateTransaction':
        tx=Transaction.from_bytes(base64.b64decode(p[0],validate=True))
        opts=p[1]
        if opts.get('replaceRecentBlockhash'):raise ValueError('replacement-forbidden')
        svm.with_sigverify(opts.get('sigVerify',False))
        try: result=svm.simulate_transaction(tx)
        finally: svm.with_sigverify(True)
        if not isinstance(result,SimulatedTransactionInfo):return context({'err':str(result.err()),'accounts':None})
        post={str(key):a for key,a in result.post_accounts()}
        return context({'err':None,'logs':result.meta().logs(),'unitsConsumed':result.meta().compute_units_consumed(),'accounts':[account_json(post.get(a) or svm.get_account(Pubkey.from_string(a))) for a in opts['accounts']['addresses']]})
    if method=='sendTransaction':
        opts=p[1]
        if opts.get('skipPreflight') is not False or opts.get('maxRetries')!=0:raise ValueError('unsafe-options')
        tx=Transaction.from_bytes(base64.b64decode(p[0],validate=True))
        tx.verify() # Independent parser + Ed25519 verification from solders.
        keys=[str(k) for k in tx.message.account_keys]
        pre=[balance(k) for k in keys]; pre_tokens=token_balances(keys)
        sim=svm.simulate_transaction(tx)
        if not isinstance(sim,SimulatedTransactionInfo):raise ValueError('preflight-rejected')
        result=svm.send_transaction(tx)
        if not isinstance(result,TransactionMetadata):raise ValueError('execution-rejected')
        state['sent']+=1
        signature=str(tx.signatures[0]);records[signature]={'slot':state['slot'],'transaction':[p[0],'base64'],'meta':{'err':None,'fee':result.fee(),'preBalances':pre,'postBalances':[balance(k) for k in keys]},'version':'legacy'}
        if pre_tokens:records[signature]['meta'].update(preTokenBalances=pre_tokens,postTokenBalances=token_balances(keys))
        return signature
    if method=='getSignatureStatuses':
        return context([None if state['hide'] or s not in records else {'slot':records[s]['slot'],'confirmations':None if state['commitment']=='finalized' else 1,'err':records[s]['meta']['err'],'confirmationStatus':state['commitment']} for s in p[0]])
    if method=='getTransaction':
        tx=None if state['hide'] else records.get(p[0])
        if tx and state.get('omitTokens'):tx=json.loads(json.dumps(tx));tx['meta'].pop('postTokenBalances',None)
        return tx
    raise ValueError('method-not-implemented')
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*a):pass
    def do_POST(self):
        n=int(self.headers.get('Content-Length','0'))
        if n>65536:self.send_error(413);return
        try:
            r=json.loads(self.rfile.read(n));method=r['method'];peer=2 if self.path=='/two' else 1
            with lock:
                result=dispatch(method,r.get('params',[]),peer)
                if method=='sendTransaction' and state['drop']:
                    self.close_connection=True;self.connection.close();return
            value={'jsonrpc':'2.0','id':r['id'],'result':result}
        except Exception as e:
            value={'jsonrpc':'2.0','id':r.get('id'), 'error':{'code':-32000,'message':type(e).__name__}}
        data=json.dumps(value).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
print(json.dumps({'port':server.server_port,'genesisHash':genesis,'kind':'LiteSVM-with-synthetic-RPC-metadata'}),flush=True)
server.serve_forever()
