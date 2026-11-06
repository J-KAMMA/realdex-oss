import {observeSettlement,assertJournalBinding,uncertainObservation} from './settlement.mjs';
import {randomUUID} from 'node:crypto';
import {need,shape,hex,hex0,canonical,clone,q,quantity,uint,safeError} from './guard.mjs';
import {address,selector} from '../../node/verified/keccak.mjs';
import {sha256} from './keys.mjs';
import {evmTransaction,evmSigningPayload,classifyEvmCall,signEvmTransaction,parseSignedEvmTransaction,routerQuoteData,abiAddress,abiWord} from './transactions.mjs';
import {Rpc} from './network.mjs';
export class EvmEngine {
  constructor({rpc=new Rpc(),now=Date.now}={}){this.rpc=rpc;this.now=now;this.observing=new Set();}
  async prepare(network,account,request,{origin='wallet-local',fixedId=null}={}){
    need(account.family==='evm'&&account.kind==='local','EVM_LOCAL_ACCOUNT_REQUIRED');
    shape(request,['from','to'],['chainId','nonce','value','data','gas','gasLimit','gasPrice','maxFeePerGas','maxPriorityFeePerGas','type','accessList']);
    const from=address(request.from);need(from===account.address,'SIGNER_ADDRESS_MISMATCH');const to=address(request.to);
    if(request.chainId!==undefined)need(q(request.chainId)===BigInt(network.chainId),'REQUEST_CHAIN_ID_MISMATCH');
    need(request.accessList===undefined||Array.isArray(request.accessList)&&request.accessList.length===0,'ACCESS_LIST_UNSUPPORTED');need(!(request.gas!==undefined&&request.gasLimit!==undefined),'GAS_FIELDS_CONFLICT');
    const value=String(q(request.value??'0x0')),data=hex0(hex(request.data??'0x'));const block=await this.rpc.snapshot(network,this.now());
    const pending=await this.rpc.agree(network,'eth_getTransactionCount',[from,'pending']),latest=await this.rpc.agree(network,'eth_getTransactionCount',[from,'latest']);need(q(pending)===q(latest),'PENDING_NONCE_REQUIRES_RECONCILIATION');
    const nonce=String(q(pending));if(request.nonce!==undefined)need(q(request.nonce)===BigInt(nonce),'NONCE_CHANGED');
    const type=request.type===undefined?(block.baseFeePerGas===null?0:2):Number(q(request.type));need(type===0||type===2,'TRANSACTION_TYPE_UNSUPPORTED');
    let fees={};
    if(type===2){need(block.baseFeePerGas!==null&&request.gasPrice===undefined,'FEE_MODEL_UNSUPPORTED');const base=BigInt(block.baseFeePerGas),priority=request.maxPriorityFeePerGas===undefined?1000000000n:q(request.maxPriorityFeePerGas),max=request.maxFeePerGas===undefined?2n*base+priority:q(request.maxFeePerGas);need(max>=base+priority,'MAX_FEE_BELOW_CURRENT_BASE');fees={maxPriorityFeePerGas:String(priority),maxFeePerGas:String(max)};}
    else {need(request.maxPriorityFeePerGas===undefined&&request.maxFeePerGas===undefined,'FEE_FIELDS_CONFLICT');const prices=await this.rpc.all(network,'eth_gasPrice',[]),current=prices.map(q).reduce((a,b)=>a>b?a:b);const price=request.gasPrice===undefined?current:q(request.gasPrice);need(price>=current,'GAS_PRICE_STALE');fees={gasPrice:String(price)};}
    const call={from,to,value:quantity(BigInt(value)),data};
    const estimated=q(await this.rpc.agree(network,'eth_estimateGas',[call]));const supplied=request.gas??request.gasLimit;const gas=supplied===undefined?(estimated*120n+99n)/100n:q(supplied);
    need(gas>=estimated&&gas>=21000n&&gas<=2000000n,'GAS_LIMIT_INVALID');const t=evmTransaction({type,chainId:network.chainId,nonce,gasLimit:String(gas),to,value,data,...fees});
    const info=classifyEvmCall(t,network,{now:this.now()});
    if(info.kind==='native-transfer')need(await this.rpc.agree(network,'eth_getCode',[to,block.ref])==='0x','NATIVE_CONTRACT_TRANSFER_UNSUPPORTED');
    await this.rpc.verifyPins(network,info.contractPins,block.ref);
    // Human-facing quantities are meaningful only if every displayed token still
    // has the locally configured decimals. Runtime hashes do not bind storage.
    for(const token of new Map(info.contractPins.filter(p=>p.kind==='erc20').map(p=>[p.address,p])).values()){
      const decimals=await this.rpc.agree(network,'eth_call',[{to:token.address,data:selector('decimals()')},block.ref]);
      need(/^0x[0-9a-fA-F]{64}$/.test(decimals)&&BigInt(decimals)===BigInt(token.decimals),'TOKEN_DECIMALS_CHANGED');
    }
    // Never silently overwrite an existing non-zero allowance. An explicit
    // revocation must settle first; sign() repeats this read before signing.
    if(info.kind==='erc20-approve'){
      const allowance=await this.rpc.agree(network,'eth_call',[{to,data:selector('allowance(address,address)')+abiAddress(from)+abiAddress(info.recipient)},block.ref]);
      need(/^0x[0-9a-fA-F]{64}$/.test(allowance),'TOKEN_ALLOWANCE_RESPONSE_INVALID');
      need(BigInt(allowance)===0n,'ALLOWANCE_RESET_REQUIRED');
    }
    const feeCap=gas*BigInt(type===2?t.maxFeePerGas:t.gasPrice);need(feeCap<=BigInt(network.maxFeeWei),'NETWORK_FEE_CAP_EXCEEDED');const balance=q(await this.rpc.agree(network,'eth_getBalance',[from,block.ref]));need(balance>=BigInt(value)+feeCap,'INSUFFICIENT_NATIVE_BALANCE');
    const simulation={...call,gas:quantity(gas),...(type===2?{maxFeePerGas:quantity(BigInt(t.maxFeePerGas)),maxPriorityFeePerGas:quantity(BigInt(t.maxPriorityFeePerGas))}:{gasPrice:quantity(BigInt(t.gasPrice))})};
    const callResult=await this.rpc.agree(network,'eth_call',[simulation,block.ref]);hex(callResult);
    if(info.kind.startsWith('erc20-'))need(callResult==='0x'+'0'.repeat(63)+'1','TOKEN_RETURN_VALUE_NOT_TRUE');
    if(info.kind==='erc20-transfer'){
      const tokenBalance=await this.rpc.agree(network,'eth_call',[{to,data:selector('balanceOf(address)')+abiAddress(from)},block.ref]);
      need(/^0x[0-9a-fA-F]{64}$/.test(tokenBalance),'TOKEN_BALANCE_RESPONSE_INVALID');
      need(BigInt(tokenBalance)>=BigInt(info.amountAtomic),'INSUFFICIENT_TOKEN_BALANCE');
    }
    if(info.kind==='local-router-swap'){
      const quote=await this.rpc.agree(network,'eth_call',[{to,data:routerQuoteData(info)},block.ref]);need(/^0x[0-9a-fA-F]{128}$/.test(quote),'ROUTER_QUOTE_INVALID');const output=BigInt('0x'+quote.slice(2,66));need(quote.slice(66,90)==='0'.repeat(24)&&address('0x'+quote.slice(90))===info.tokenOut,'ROUTER_OUTPUT_ASSET_MISMATCH');
      const minimum=BigInt(info.minimumOutputAtomic);need(minimum<=output&&minimum*10000n>=output*BigInt(10000-network.maxSlippageBps),'SLIPPAGE_OUTSIDE_LOCAL_POLICY');
    }
    const returns=n=>{need(new RegExp('^0x[0-9a-fA-F]{'+n*64+'}$').test(callResult),'SIMULATION_RETURN_INVALID');return Array.from({length:n},(_,i)=>BigInt('0x'+callResult.slice(2+i*64,66+i*64)));};
    const floor=(minimum,observed)=>{const m=BigInt(minimum);need(observed>0n&&m<=observed&&m*10000n>=observed*BigInt(10000-network.maxSlippageBps),'SLIPPAGE_OUTSIDE_LOCAL_POLICY');};
    if(info.kind==='local-pool-swap'){
      const quote=await this.rpc.agree(network,'eth_call',[{to,data:selector('quoteExactIn(address,uint256)')+abiAddress(info.tokenIn)+abiWord(info.amountAtomic)},block.ref]);need(/^0x[0-9a-fA-F]{64}$/.test(quote),'POOL_QUOTE_INVALID');floor(info.minimumOutputAtomic,BigInt(quote));const output=returns(1)[0];floor(info.minimumOutputAtomic,output);
    }
    if(info.kind==='local-pool-add-liquidity')floor(info.details.minimumShares,returns(1)[0]);
    if(info.kind==='local-router-add-liquidity'){const [a,b,shares]=returns(3);need(a<=BigInt(info.details.maximum0)&&b<=BigInt(info.details.maximum1),'LIQUIDITY_DEBIT_EXCEEDS_MAXIMUM');floor(info.details.minimum0,a);floor(info.details.minimum1,b);floor(info.details.minimumShares,shares);}
    if(info.kind==='local-pool-remove-liquidity'){const [a,b]=returns(2);floor(info.details.minimum0,a);floor(info.details.minimum1,b);}
    if(info.kind==='local-factory-create-pool'){returns(1);need(callResult.slice(2,26)==='0'.repeat(24),'ABI_ADDRESS_PADDING_INVALID');address('0x'+callResult.slice(26));}
    const assetMoves=[];
    const addAsset=(tokenAddress,amount,decimals,symbol)=>assetMoves.push({address:tokenAddress,amountAtomic:amount,decimals,symbol});
    if(info.kind==='native-transfer')addAsset(null,info.amountAtomic,18,network.symbol);
    else if(info.kind.startsWith('erc20-')){const token=network.contracts.find(c=>c.address===to);addAsset(to,info.amountAtomic,token.decimals,token.symbol);}
    else if(info.kind.endsWith('-swap')){const token=network.contracts.find(c=>c.address===info.tokenIn);addAsset(info.tokenIn,info.amountAtomic,token.decimals,token.symbol);}
    else if(info.kind.endsWith('add-liquidity')){for(const i of [0,1]){const token=network.contracts.find(c=>c.address===info.details['token'+i]);addAsset(token.address,info.details['maximum'+i],token.decimals,token.symbol);}}
    else if(info.kind==='local-pool-remove-liquidity')addAsset(info.details.pool,info.amountAtomic,18,'LP shares');
    const createdAt=this.now(),expiresAt=Math.min(createdAt+90000,info.deadline?Number(BigInt(info.deadline))*1000:Infinity);const summary={network:network.name,chainId:network.chainId,origin,from,to,operation:info.kind,assetMoves,outputToken:info.tokenOut??null,details:info.details??null,recipient:info.recipient,amountAtomic:info.amountAtomic,asset:info.asset,outputAsset:info.outputAsset??null,minimumOutputAtomic:info.minimumOutputAtomic,gasLimit:t.gasLimit,executionFeeCapWei:String(feeCap),totalNativeDebitCapWei:String(BigInt(value)+feeCap),nonce,deadline:info.deadline??null,blockHash:block.hash,assurance:'RPC agreement and local allowlist; not a light-client proof or token audit',contractPins:info.contractPins.map(p=>({address:p.address,runtimeHash:p.runtimeHash})),expiresAt};
    const id=fixedId??sha256(Buffer.from(canonical({transaction:t,accountId:account.id,origin,createdAt,requestId:randomUUID()}))).toString('hex');
    return {id,accountId:account.id,networkId:network.chainId,transaction:t,request:this.toRequest(from,t),summary,createdAt,expiresAt,signingDigest:evmSigningPayload(t).digest,nonceKey:`evm:${network.chainId}:${network.genesisHash}:${from}:${nonce}`};
  }
  toRequest(from,t){return {from,to:t.to,type:quantity(BigInt(t.type)),chainId:quantity(BigInt(t.chainId)),nonce:quantity(BigInt(t.nonce)),value:quantity(BigInt(t.value)),data:t.data,gas:quantity(BigInt(t.gasLimit)),...(t.type===2?{maxFeePerGas:quantity(BigInt(t.maxFeePerGas)),maxPriorityFeePerGas:quantity(BigInt(t.maxPriorityFeePerGas))}:{gasPrice:quantity(BigInt(t.gasPrice))})};}
  async sign(vault,network,intent,{authorize=()=>{},userActivity=true,commit=null}={}){need(this.now()<intent.expiresAt,'APPROVAL_EXPIRED');const epoch=vault.epoch;const account=vault.account(intent.accountId),fresh=await this.prepare(network,account,intent.request,{origin:intent.summary.origin,fixedId:intent.id});need(epoch===vault.epoch,'WALLET_LOCKED_DURING_RECHECK');need(this.now()<intent.expiresAt&&fresh.signingDigest===intent.signingDigest&&canonical(fresh.transaction)===canonical(intent.transaction),'TRANSACTION_CHANGED');
    return vault.signAndRecord(account.id,intent,secret=>{need(this.now()<intent.expiresAt,'APPROVAL_EXPIRED');authorize();return signEvmTransaction(secret,intent.transaction);},{userActivity,commit});
  }
  async broadcast(vault,network,record,{authorize=()=>{}}={}){vault.check();const epoch=vault.epoch;const check=()=>{need(epoch===vault.epoch,'WALLET_LOCKED_DURING_BROADCAST');vault.check();authorize();};need(network.broadcastEnabled,'BROADCAST_DISABLED');const parsed=parseSignedEvmTransaction(record.signed.rawTransaction);need(parsed.transactionHash===record.signed.transactionHash&&parsed.from===record.summary.from&&parsed.transaction.to===record.summary.to&&parsed.transaction.chainId===network.chainId&&parsed.transaction.nonce===record.summary.nonce,'SIGNED_JOURNAL_BINDING_MISMATCH');need(record.family==='evm'&&record.summary.chainId===network.chainId,'BROADCAST_NETWORK_MISMATCH');need(record.nonceKey===`evm:${network.chainId}:${network.genesisHash}:${parsed.from}:${parsed.transaction.nonce}`,'JOURNAL_GENESIS_BINDING_MISMATCH');need(['signed','broadcast-unknown','broadcast'].includes(record.state),'RECORD_NOT_BROADCASTABLE');await this.rpc.snapshot(network,this.now());check();
    // Durable ambiguous state precedes any outbound send. Never replace bytes on retry.
    await vault.updateRecord(record.id,'broadcast-unknown',{transactionHash:record.signed.transactionHash});check();
    try{const hash=await this.rpc.call(network.rpcUrls[0],'eth_sendRawTransaction',[record.signed.rawTransaction]);need(typeof hash==='string'&&hash.toLowerCase()===record.signed.transactionHash,'BROADCAST_HASH_MISMATCH');check();return await vault.updateRecord(record.id,'broadcast',{transactionHash:hash});}
    catch {return {id:record.id,state:'broadcast-unknown',transactionHash:record.signed.transactionHash,automaticRetry:false};}
  }
  async reconcile(vault,network,input){
    // Read the current durable record rather than trusting a stale caller copy.
    vault.check();const epoch=vault.epoch;
    const record=(await vault.journal()).find(r=>r.id===input.id);need(record,'RECORD_NOT_FOUND');
    assertJournalBinding(record,network);need(!this.observing.has(record.id),'RECONCILIATION_BUSY');
    this.observing.add(record.id);
    const check=()=>{need(epoch===vault.epoch,'WALLET_LOCKED_DURING_RECHECK');vault.check();};
    try {
      const report=await observeSettlement(this.rpc,network,record,this.now());check();
      const state=report.transactionReportedSuccessful===true?'reported-confirmed':report.transactionReportedSuccessful===false?'reported-reverted':record.state==='signed'?'signed':'broadcast-unknown';
      const result=await vault.applyObservation(record,state,report);
      return {...result,observation:report.observation};
    } catch(error) {
      // Fail closed: a previously successful observation is no longer current.
      // Errors never release nonce reservations or agent budgets and never resend.
      if(epoch===vault.epoch&&vault.key&&safeError(error)!=='OBSERVATION_SUPERSEDED'){
        const report=uncertainObservation(record,this.now(),'reconciliation-unavailable',{error:safeError(error)});
        await vault.applyObservation(record,record.state==='signed'?'signed':'broadcast-unknown',report).catch(()=>{});
      }
      throw error;
    } finally {this.observing.delete(record.id);}
  }
}
