/** Owner-only smart-account preflight. The EOA signs/pays gas; assets belong to the contract. */
import {randomUUID} from 'node:crypto';
import {need,shape,clone,canonical,uint,q,quantity,hex} from '../lib/guard.mjs';
import {parseUnits,transferAsset} from '../lib/transfers.mjs';
import {address,selector,keccak256} from '../../node/verified/keccak.mjs';
import {sha256} from '../lib/keys.mjs';
import {abiWord,abiAddress,evmTransaction,evmSigningPayload,signEvmTransaction,parseSignedEvmTransaction,resolveLocalRoute,SWAP_SELECTOR,routerQuoteData} from '../lib/transactions.mjs';
import {ZERO,U48,encodeOperation,predictAddress,factoryCode,accountCode,factoryHash,verifyBuildSources,artifactForDescriptor,callsHash,decodeBytesArray,assertSmartTransaction} from './codec.mjs';
const hash=o=>sha256(Buffer.from(canonical(o))).toString('hex');
const word=raw=>{need(/^0x[0-9a-fA-F]{64}$/.test(raw),'SMART_RPC_WORD_INVALID');return BigInt(raw);};
const asAddress=raw=>{need(/^0x0{24}[0-9a-fA-F]{40}$/.test(raw),'SMART_RPC_ADDRESS_INVALID');return raw==='0x'+'0'.repeat(64)?ZERO:address('0x'+raw.slice(26));};
export class SmartEngine {
  constructor(wallet){this.wallet=wallet;this.rpc=wallet.engine.rpc;}
  now(){return this.wallet.now();}
  async call(n,to,signature,args,ref){return this.rpc.agree(n,'eth_call',[{to,data:selector(signature)+(args??'')},ref]);}
  async inspect(n,d,owner,snap=null){
    const artifact=artifactForDescriptor(d);verifyBuildSources(artifact);need(n.chainId===d.chainId&&n.genesisHash===d.genesisHash,'SMART_NETWORK_BINDING_MISMATCH');
    const block=snap??await this.rpc.snapshot(n,this.now());
    const fcode=await this.rpc.agree(n,'eth_getCode',[d.factory,block.ref]);need(fcode.toLowerCase()===factoryCode(artifact),'SMART_FACTORY_CODE_MISMATCH');
    need(predictAddress(d.factory,owner.address,d.salt,artifact)===d.address,'SMART_DERIVATION_MISMATCH');
    const predicted=asAddress(await this.call(n,d.factory,'getAddress(address,bytes32)',abiAddress(owner.address)+d.salt.slice(2),block.ref));need(predicted===d.address,'SMART_FACTORY_DERIVATION_MISMATCH');
    const code=await this.rpc.agree(n,'eth_getCode',[d.address,block.ref]),deployed=code!=='0x';
    if(deployed){need(code.toLowerCase()===accountCode(owner.address,d.factory,artifact),'SMART_ACCOUNT_CODE_MISMATCH');
      need(asAddress(await this.call(n,d.address,'owner()','',block.ref))===owner.address&&asAddress(await this.call(n,d.address,'factory()','',block.ref))===d.factory,'SMART_OWNER_OR_FACTORY_CHANGED');}
    const balance=String(q(await this.rpc.agree(n,'eth_getBalance',[d.address,block.ref])));
    return {descriptor:clone(d),owner:owner.address,deployed,balanceWei:balance,block,
      executionNonce:deployed?String(word(await this.call(n,d.address,'executionNonce()','',block.ref))):'0',
      sessionEpoch:deployed?String(word(await this.call(n,d.address,'sessionEpoch()','',block.ref))):'0',
      signatureEpoch:deployed?String(word(await this.call(n,d.address,'signatureEpoch()','',block.ref))):'0',
      codeIdentityVerified:deployed,experimentalCompiler:true,finalityProven:false,erc4337Implemented:false,gasPayer:owner.address};
  }
  async token(n,asset,ref){
    const t=transferAsset(n,asset);
    if(t.address){await this.rpc.verifyPins(n,[t],ref);need(word(await this.call(n,t.address,'decimals()','',ref))===BigInt(t.decimals),'TOKEN_DECIMALS_CHANGED');}
    return t;
  }
  async tokenBalance(n,t,who,ref){return t.address?word(await this.call(n,t.address,'balanceOf(address)',abiAddress(who),ref)):q(await this.rpc.agree(n,'eth_getBalance',[who,ref]));}
  async session(n,d,key,ref){
    const raw=await this.call(n,d.address,'sessions(address)',abiAddress(key),ref);need(/^0x[0-9a-fA-F]{768}$/.test(raw),'SMART_SESSION_RESPONSE_INVALID');
    const w=Array.from({length:12},(_,i)=>'0x'+raw.slice(2+i*64,66+i*64));
    return {key,recipient:asAddress(w[0]),token:asAddress(w[1]),tokenCodeHash:w[2].toLowerCase(),perCall:String(word(w[3])),daily:String(word(w[4])),total:String(word(w[5])),spent:String(word(w[6])),daySpent:String(word(w[7])),validUntil:String(word(w[8])),day:String(word(w[9])),epoch:String(word(w[10])),generation:String(word(w[11])),sessionNonce:String(word(await this.call(n,d.address,'sessionNonces(address)',abiAddress(key),ref)))};
  }
  async prepare(d,request,{fixed=null,fixedId=null}={}){
    const w=this.wallet,n=w.network(d.chainId),owner=w.vault.account(d.ownerAccountId),artifact=artifactForDescriptor(d);need(owner.family==='evm'&&owner.kind==='local','SMART_OWNER_REQUIRED');
    const snapshot=await this.rpc.snapshot(n,this.now()),inspected=await this.inspect(n,d,owner,snapshot),ref=snapshot.ref;
    const raw=clone(request);need(raw&&typeof raw.type==='string','SMART_OPERATION_REQUIRED');
    let actor=owner,op,recipient=d.address,pins=[],assetMoves=[],details={},binding={};
    const addPin=t=>{if(t.address)pins.push({address:t.address,runtimeHash:t.runtimeHash});};
    const deadline=()=>{raw.validUntil??=String(Math.floor(this.now()/1000)+300);const t=uint(raw.validUntil,U48),now=BigInt(Math.floor(this.now()/1000));need(t>now&&t<=now+600n,'SMART_DEADLINE_INVALID');return raw.validUntil;};
    if(raw.type==='deploy'){shape(raw,['type']);need(!inspected.deployed,'SMART_ALREADY_DEPLOYED');op={type:'deploy',owner:owner.address,salt:d.salt};details={predictedAddress:d.address,factory:d.factory,owner:owner.address};}
    else {
      need(inspected.deployed,'SMART_NOT_DEPLOYED');
      if(raw.type==='fund'){shape(raw,['type','amount']);op={type:'fund',amountAtomic:parseUnits(raw.amount,18)};assetMoves=[{address:null,symbol:n.symbol,decimals:18,amountAtomic:op.amountAtomic}];}
      else if(raw.type==='payments'){
        shape(raw,['type','transfers'],['validUntil']);const validUntil=deadline();need(Array.isArray(raw.transfers)&&raw.transfers.length>=1&&raw.transfers.length<=8,'SMART_BATCH_LIMIT');
        const calls=[],sums=new Map();
        for(const p of raw.transfers){shape(p,['asset','recipient','amount']);const t=await this.token(n,p.asset,ref),to=address(p.recipient),amount=parseUnits(p.amount,t.decimals);need(to!==d.address,'SELF_TRANSFER_NOT_SUPPORTED');
          if(!t.address)need(await this.rpc.agree(n,'eth_getCode',[to,ref])==='0x','SMART_NATIVE_RECIPIENT_MUST_BE_EOA');
          const key=t.address??ZERO,old=sums.get(key);sums.set(key,{t,amount:BigInt(amount)+(old?.amount??0n)});addPin(t);
          calls.push(t.address?{target:t.address,value:'0',data:selector('transfer(address,uint256)')+abiAddress(to)+abiWord(amount)}:{target:to,value:amount,data:'0x'});
          assetMoves.push({address:t.address,symbol:t.symbol,decimals:t.decimals,amountAtomic:amount});
        }
        for(const {t,amount} of sums.values())need(await this.tokenBalance(n,t,d.address,ref)>=amount,'SMART_INSUFFICIENT_ASSET_BALANCE');
        op={type:'batch',calls,expectedNonce:inspected.executionNonce,validUntil};recipient=raw.transfers.length===1?address(raw.transfers[0].recipient):d.address;
        details={transfers:raw.transfers,atomic:true,feePayer:owner.address,assetHolder:d.address};
      } else if(raw.type==='swap'){
        shape(raw,['type','router','pools','tokenIn','amount','minimumOutput','recipient'],['validUntil']);const validUntil=deadline();
        const route=resolveLocalRoute(n,raw.router,raw.pools,raw.tokenIn),input=await this.token(n,route.tokenIn.address,ref),output=await this.token(n,route.tokenOut.address,ref);
        const amount=parseUnits(raw.amount,input.decimals),minimum=parseUnits(raw.minimumOutput,output.decimals),to=address(raw.recipient);recipient=to;
        need(BigInt(amount)<=BigInt(route.tokenIn.approvalCapAtomic),'APPROVAL_EXCEEDS_LOCAL_CAP');
        pins.push(...route.contractPins);
        for(const t of route.tokens)await this.token(n,t.address,ref);
        await this.rpc.verifyPins(n,route.contractPins,ref);
        need(await this.tokenBalance(n,input,d.address,ref)>=BigInt(amount),'SMART_INSUFFICIENT_ASSET_BALANCE');
        need(word(await this.call(n,input.address,'allowance(address,address)',abiAddress(d.address)+abiAddress(route.router.address),ref))===0n,'ALLOWANCE_RESET_REQUIRED');
        const info={tokenIn:input.address,amountAtomic:amount,pools:route.pools.map(p=>p.address)},quote=await this.rpc.agree(n,'eth_call',[{to:route.router.address,data:routerQuoteData(info)},ref]);
        need(/^0x[0-9a-fA-F]{128}$/.test(quote)&&asAddress('0x'+quote.slice(66))===output.address,'SMART_QUOTE_INVALID');const out=BigInt('0x'+quote.slice(2,66));
        need(BigInt(minimum)<=out&&BigInt(minimum)*10000n>=out*BigInt(10000-n.maxSlippageBps),'SLIPPAGE_OUTSIDE_LOCAL_POLICY');
        const swap=SWAP_SELECTOR+abiWord(192)+abiAddress(input.address)+abiWord(amount)+abiWord(minimum)+abiAddress(to)+abiWord(validUntil)+abiWord(info.pools.length)+info.pools.map(abiAddress).join('');
        op={type:'batch',calls:[{target:input.address,value:'0',data:selector('approve(address,uint256)')+abiAddress(route.router.address)+abiWord(amount)},{target:route.router.address,value:'0',data:swap},{target:input.address,value:'0',data:selector('approve(address,uint256)')+abiAddress(route.router.address)+abiWord(0)}],expectedNonce:inspected.executionNonce,validUntil};
        assetMoves=[{address:input.address,symbol:input.symbol,decimals:input.decimals,amountAtomic:amount}];
        details={router:route.router.address,tokenPath:route.tokens.map(t=>t.address),minimumOutputAtomic:minimum,outputToken:output.address,quoteBeforeGas:String(out),atomicApproveSwapRevoke:true};
      } else if(raw.type==='grant-session'){
        shape(raw,['type','sessionAccountId','asset','recipient','perCall','daily','total','validUntil']);
        const key=w.vault.account(raw.sessionAccountId);need(key.kind==='local'&&key.family==='evm'&&key.address!==owner.address,'SMART_SESSION_KEY_REQUIRED');
        need(await this.rpc.agree(n,'eth_getCode',[key.address,ref])==='0x','SMART_SESSION_KEY_MUST_BE_EOA');
        const t=await this.token(n,raw.asset,ref);addPin(t);recipient=key.address;
        const until=uint(raw.validUntil,U48),now=BigInt(Math.floor(this.now()/1000));need(until>now&&until<=now+604800n,'SMART_SESSION_EXPIRY_INVALID');
        op={type:raw.type,key:key.address,recipient:address(raw.recipient),token:t.address??ZERO,perCall:parseUnits(raw.perCall,t.decimals),daily:parseUnits(raw.daily,t.decimals),total:parseUnits(raw.total,t.decimals),validUntil:raw.validUntil};
        need(op.recipient!==d.address,'SELF_TRANSFER_NOT_SUPPORTED');details={...op,dailyWindow:'UTC calendar day',gasPaidBy:key.address,localLockDoesNotRevokeOnChain:true};
      } else if(raw.type==='revoke-session'){
        shape(raw,['type','key']);op={type:raw.type,key:address(raw.key)};recipient=op.key;
      } else if(['revoke-all','invalidate-signatures'].includes(raw.type)){shape(raw,['type']);op={type:raw.type};}
      else if(raw.type==='session-transfer'){
        shape(raw,['type','sessionAccountId','amount']);actor=w.vault.account(raw.sessionAccountId);need(actor.family==='evm'&&actor.kind==='local','SMART_SESSION_KEY_REQUIRED');
        const s=await this.session(n,d,actor.address,ref),t=await this.token(n,s.token===ZERO?'native':s.token,ref);addPin(t);
        const now=BigInt(Math.floor(this.now()/1000));need(s.epoch===inspected.sessionEpoch&&BigInt(s.validUntil)>now&&s.recipient!==ZERO,'SMART_SESSION_INACTIVE');
        const amount=parseUnits(raw.amount,t.decimals);need(BigInt(amount)<=BigInt(s.perCall)&&BigInt(amount)+BigInt(s.spent)<=BigInt(s.total),'SMART_SESSION_BUDGET_EXCEEDED');
        const spentToday=BigInt(s.day)===now/86400n?BigInt(s.daySpent):0n;need(BigInt(amount)+spentToday<=BigInt(s.daily),'SMART_SESSION_DAILY_EXCEEDED');
        if(t.address)need(t.runtimeHash===s.tokenCodeHash,'SMART_SESSION_TOKEN_CODE_CHANGED');
        need(await this.tokenBalance(n,t,d.address,ref)>=BigInt(amount),'SMART_INSUFFICIENT_ASSET_BALANCE');
        op={type:raw.type,key:actor.address,generation:s.generation,sessionNonce:s.sessionNonce,amountAtomic:amount};recipient=s.recipient;
        details={session:s,dailyWindow:'UTC calendar day',assetHolder:d.address,gasPaidBy:actor.address};binding={session:hash(s)};
        assetMoves=[{address:t.address,symbol:t.symbol,decimals:t.decimals,amountAtomic:amount}];
      } else throw Error('SMART_OPERATION_UNSUPPORTED');
    }
    const data=encodeOperation(op);need(await this.rpc.agree(n,'eth_getCode',[actor.address,ref])==='0x','SMART_CONTROLLER_MUST_BE_EOA');
    const pending=String(q(await this.rpc.agree(n,'eth_getTransactionCount',[actor.address,'pending']))),latest=String(q(await this.rpc.agree(n,'eth_getTransactionCount',[actor.address,'latest'])));
    need(pending===latest,'PENDING_NONCE_REQUIRES_RECONCILIATION');if(fixed)need(pending===fixed.nonce,'NONCE_CHANGED');
    const type=fixed?.type??(snapshot.baseFeePerGas===null?0:2);let fees;
    if(type===2){need(snapshot.baseFeePerGas!==null,'FEE_MODEL_UNSUPPORTED');const base=BigInt(snapshot.baseFeePerGas),priority=BigInt(fixed?.maxPriorityFeePerGas??1000000000n),max=BigInt(fixed?.maxFeePerGas??2n*base+priority);need(max>=base+priority,'MAX_FEE_BELOW_CURRENT_BASE');fees={maxPriorityFeePerGas:String(priority),maxFeePerGas:String(max)};}
    else{const price=(await this.rpc.all(n,'eth_gasPrice',[])).map(q).reduce((a,b)=>a>b?a:b),chosen=BigInt(fixed?.gasPrice??price);need(chosen>=price,'GAS_PRICE_STALE');fees={gasPrice:String(chosen)};}
    const value=op.type==='fund'?op.amountAtomic:'0',to=op.type==='deploy'?d.factory:d.address,call={from:actor.address,to,data,value:quantity(BigInt(value))};
    const estimated=q(await this.rpc.agree(n,'eth_estimateGas',[call])),gas=BigInt(fixed?.gasLimit??(estimated*125n+99n)/100n);need(gas>=estimated&&gas>=21000n&&gas<=(op.type==='deploy'?3500000n:2000000n),'GAS_LIMIT_INVALID');
    const feeCap=gas*BigInt(type===2?fees.maxFeePerGas:fees.gasPrice);need(feeCap<=BigInt(n.maxFeeWei),'NETWORK_FEE_CAP_EXCEEDED');
    need(q(await this.rpc.agree(n,'eth_getBalance',[actor.address,ref]))>=feeCap+BigInt(value),'INSUFFICIENT_NATIVE_BALANCE');
    const tx=evmTransaction({type,chainId:n.chainId,nonce:pending,gasLimit:String(gas),to,value,data,...fees});
    const simulated=await this.rpc.agree(n,'eth_call',[{...call,gas:quantity(gas)},ref]);hex(simulated);
    if(op.type==='batch'){
      const returns=decodeBytesArray(simulated,op.calls.length);
      if(raw.type==='swap')need(/^0x[0-9a-fA-F]{128}$/.test(returns[1])&&asAddress('0x'+returns[1].slice(66))===details.outputToken&&BigInt('0x'+returns[1].slice(2,66))>=BigInt(details.minimumOutputAtomic),'SMART_SWAP_RESULT_INVALID');
      for(let i=0;i<op.calls.length;i++)if(['0xa9059cbb','0x095ea7b3'].includes(op.calls[i].data.slice(0,10)))need(returns[i]==='0x'||word(returns[i])===1n,'TOKEN_RETURN_VALUE_NOT_TRUE');
    } else if(op.type==='deploy')need(asAddress(simulated)===d.address,'SMART_DEPLOY_RESULT_MISMATCH');
    const createdAt=this.now(),expiresAt=Math.min(createdAt+90000,raw.validUntil?Number(raw.validUntil)*1000:Infinity);
    const smart={descriptor:clone(d),owner:owner.address,operation:op,callsHash:op.type==='batch'?callsHash(op.calls):null,request:raw};
    const summary={network:n.name,chainId:n.chainId,origin:w.origin??'wallet-local',from:actor.address,to,operation:'smart-account-'+raw.type,recipient,
      amountAtomic:assetMoves.length===1?assetMoves[0].amountAtomic:'0',asset:assetMoves.length===1?assetMoves[0].symbol:'Smart account operation',assetMoves,
      outputToken:details.outputToken??null,minimumOutputAtomic:details.minimumOutputAtomic??null,deadline:raw.validUntil??null,details,
      executionFeeCapWei:String(feeCap),totalNativeDebitCapWei:String(feeCap+BigInt(value)),gasLimit:String(gas),nonce:pending,blockHash:snapshot.hash,expiresAt,
      contractPins:[{address:d.factory,runtimeHash:factoryHash(artifact)},...(inspected.deployed?[{address:d.address,runtimeHash:keccak256(accountCode(owner.address,d.factory,artifact))}]:[]),...pins.map(p=>({address:p.address,runtimeHash:p.runtimeHash}))],
      smart,assurance:'Exact bundled experimental runtime + RPC agreement; not audited; not ERC4337/7702'};
    return {id:fixedId??hash({smart,tx,createdAt,random:randomUUID()}),accountId:actor.id,networkId:n.chainId,transaction:tx,summary,createdAt,expiresAt,
      signingDigest:evmSigningPayload(tx).digest,nonceKey:`evm:${n.chainId}:${n.genesisHash}:${actor.address}:${pending}`,settingsHash:hash(n),binding};
  }
  async sign(intent,authorize=()=>{}){
    const w=this.wallet,epoch=w.vault.epoch;need(this.now()<intent.expiresAt,'APPROVAL_EXPIRED');
    const n=w.network(intent.networkId);need(hash(n)===intent.settingsHash,'NETWORK_SETTINGS_CHANGED');
    const fresh=await this.prepare(intent.summary.smart.descriptor,intent.summary.smart.request,{fixed:intent.transaction,fixedId:intent.id});
    need(epoch===w.vault.epoch,'WALLET_LOCKED_DURING_RECHECK');w.vault.check();
    need(fresh.signingDigest===intent.signingDigest&&canonical(fresh.binding)===canonical(intent.binding),'SMART_STATE_CHANGED');
    return w.vault.signAndRecord(intent.accountId,intent,secret=>{authorize();need(this.now()<intent.expiresAt,'APPROVAL_EXPIRED');return signEvmTransaction(secret,intent.transaction);});
  }
  async broadcast(record,authorize=()=>{}){
    const w=this.wallet,epoch=w.vault.epoch;w.vault.check();need(record.state==='signed','SMART_ONLY_INITIAL_BROADCAST');
    const n=w.network(record.summary.chainId);need(n.broadcastEnabled,'BROADCAST_DISABLED');
    const decoded=parseSignedEvmTransaction(record.signed.rawTransaction);assertSmartTransaction(record,decoded);
    const fresh=await this.prepare(record.summary.smart.descriptor,record.summary.smart.request,{fixed:decoded.transaction});
    need(epoch===w.vault.epoch,'WALLET_LOCKED_DURING_BROADCAST');w.vault.check();authorize();
    need(fresh.signingDigest===record.signed.signingDigest,'SMART_STATE_CHANGED');
    return w.engine.broadcast(w.vault,n,record,{authorize});
  }
}
