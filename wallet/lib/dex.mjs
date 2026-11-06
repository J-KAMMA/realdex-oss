/** Owner-only structured DEX operations. No blind calldata, AI grants, or automatic approvals. */
import {need, shape, safeError} from './guard.mjs';
import {address, selector} from '../../node/verified/keccak.mjs';
import {parseUnits, formatUnits} from './transfers.mjs';
import {abiAddress, abiWord, FACTORY_CREATE_SELECTOR, POOL_SWAP_SELECTOR, POOL_ADD_SELECTOR, POOL_REMOVE_SELECTOR, SWAP_SELECTOR, resolveLocalRoute, routerQuoteData} from './transactions.mjs';

function configured(network, raw, kind) {
  const a = address(raw), c = network.contracts.find(c => c.address === a && c.kind === kind);
  need(c, kind === 'erc20' ? 'TOKEN_NOT_IN_LOCAL_POLICY' : 'DEX_CONTRACT_NOT_IN_LOCAL_POLICY');
  return c;
}
function pair(network, raw) {
  const pool = configured(network, raw, 'pool');
  return {pool, token0: configured(network, pool.token0, 'erc20'), token1: configured(network, pool.token1, 'erc20')};
}
function deadline(raw, now) {
  need(Number.isSafeInteger(raw) && raw >= 30 && raw <= 600, 'DEX_DEADLINE_INVALID');
  return String(Math.floor(now / 1000) + raw);
}
export function dexCatalog(network) {
  return {chainId: network.chainId, genesisHash: network.genesisHash, maxSlippageBps: network.maxSlippageBps,
    tokens: network.contracts.filter(c => c.kind === 'erc20').map(c => ({address:c.address,symbol:c.symbol,decimals:c.decimals,approvalCapAtomic:c.approvalCapAtomic})),
    pools: network.contracts.filter(c => c.kind === 'pool').map(c => ({address:c.address,token0:c.token0,token1:c.token1})),
    factories: network.contracts.filter(c => c.kind === 'factory').map(c => ({address:c.address})),
    spenders: network.contracts.filter(c => ['pool','router'].includes(c.kind)).map(c => ({address:c.address,kind:c.kind})),
    automaticCandidatePromotion:false, source:'Owner-configured contract policy; catalogue is not an on-chain verification'};
}
/** Human amounts are converted here, inside the signer process, not in the browser. */
export function dexRequest(network, account, input, now = Date.now()) {
  need(account.family === 'evm' && account.kind === 'local', 'EVM_LOCAL_ACCOUNT_REQUIRED');
  need(input && typeof input === 'object' && !Array.isArray(input), 'DEX_OPERATION_INVALID');
  let to, data, details;
  if(input.action === 'create-pool') {
    shape(input,['action','factory','tokenA','tokenB','feeBps']);
    const factory = configured(network,input.factory,'factory'), a=configured(network,input.tokenA,'erc20'), b=configured(network,input.tokenB,'erc20');
    need(a.address!==b.address && Number.isSafeInteger(input.feeBps) && input.feeBps>=1 && input.feeBps<=100,'FACTORY_PARAMETERS_INVALID');
    to=factory.address;data=FACTORY_CREATE_SELECTOR+abiAddress(a.address)+abiAddress(b.address)+abiWord(input.feeBps);
    details={action:input.action,factory:to,tokenA:a.address,tokenB:b.address,feeBps:input.feeBps,createdPoolAutomaticallyTrusted:false};
  } else if(input.action==='approve' || input.action==='revoke') {
    shape(input,input.action==='approve'?['action','token','spender','amount']:['action','token','spender']);
    const token=configured(network,input.token,'erc20'),spender=address(input.spender);
    need(network.contracts.some(c=>c.address===spender&&['pool','router'].includes(c.kind)),'DEX_SPENDER_NOT_IN_LOCAL_POLICY');
    const amount=input.action==='revoke'?'0':parseUnits(input.amount,token.decimals);
    need(BigInt(amount)<=BigInt(token.approvalCapAtomic),'APPROVAL_CAP_EXCEEDED');
    to=token.address;data=selector('approve(address,uint256)')+abiAddress(spender)+abiWord(amount);
    details={action:input.action,token:to,spender,amountAtomic:amount,symbol:token.symbol,automaticFollowup:false};
  } else if(input.action==='swap') {
    shape(input,['action','pool','tokenIn','amount','minimumOutput','recipient','ttlSeconds']);
    const {pool,token0,token1}=pair(network,input.pool),tokenIn=address(input.tokenIn);
    need([token0.address,token1.address].includes(tokenIn),'POOL_PATH_INVALID');
    const a=tokenIn===token0.address?token0:token1,b=tokenIn===token0.address?token1:token0;
    const amount=parseUnits(input.amount,a.decimals),minimum=parseUnits(input.minimumOutput,b.decimals),recipient=address(input.recipient),until=deadline(input.ttlSeconds,now);
    to=pool.address;data=POOL_SWAP_SELECTOR+abiAddress(a.address)+abiWord(amount)+abiWord(minimum)+abiAddress(recipient)+abiWord(until);
    details={action:input.action,pool:to,tokenIn:a.address,tokenOut:b.address,amountAtomic:amount,minimumOutputAtomic:minimum,recipient,deadline:until};
  } else if(input.action==='route-swap') {
    shape(input,['action','router','pools','tokenIn','amount','minimumOutput','recipient','ttlSeconds']);
    const route=resolveLocalRoute(network,input.router,input.pools,input.tokenIn);
    const amount=parseUnits(input.amount,route.tokenIn.decimals),minimum=parseUnits(input.minimumOutput,route.tokenOut.decimals);
    const recipient=address(input.recipient),until=deadline(input.ttlSeconds,now),pools=route.pools.map(p=>p.address);
    to=route.router.address;
    data=SWAP_SELECTOR+abiWord(192)+abiAddress(route.tokenIn.address)+abiWord(amount)+abiWord(minimum)+abiAddress(recipient)+abiWord(until)+abiWord(pools.length)+pools.map(abiAddress).join('');
    details={action:input.action,router:to,pools,tokenPath:route.tokens.map(t=>t.address),tokenIn:route.tokenIn.address,tokenOut:route.tokenOut.address,amountAtomic:amount,minimumOutputAtomic:minimum,recipient,deadline:until,automaticApproval:false};
  } else if(input.action==='add-liquidity') {
    shape(input,['action','pool','amount0','amount1','minimumShares','recipient','ttlSeconds']);
    const {pool,token0,token1}=pair(network,input.pool),a=parseUnits(input.amount0,token0.decimals),b=parseUnits(input.amount1,token1.decimals),shares=parseUnits(input.minimumShares,18),recipient=address(input.recipient),until=deadline(input.ttlSeconds,now);
    to=pool.address;data=POOL_ADD_SELECTOR+abiWord(a)+abiWord(b)+abiWord(shares)+abiAddress(recipient)+abiWord(until);
    details={action:input.action,pool:to,token0:token0.address,token1:token1.address,amount0Atomic:a,amount1Atomic:b,minimumSharesAtomic:shares,recipient,deadline:until};
  } else if(input.action==='remove-liquidity') {
    shape(input,['action','pool','shares','minimum0','minimum1','recipient','ttlSeconds']);
    const {pool,token0,token1}=pair(network,input.pool),shares=parseUnits(input.shares,18),a=parseUnits(input.minimum0,token0.decimals),b=parseUnits(input.minimum1,token1.decimals),recipient=address(input.recipient),until=deadline(input.ttlSeconds,now);
    to=pool.address;data=POOL_REMOVE_SELECTOR+abiWord(shares)+abiWord(a)+abiWord(b)+abiAddress(recipient)+abiWord(until);
    details={action:input.action,pool:to,sharesAtomic:shares,minimum0Atomic:a,minimum1Atomic:b,recipient,deadline:until};
  } else throw Error('DEX_OPERATION_UNSUPPORTED');
  return {transaction:{from:account.address,to,value:'0x0',data},details};
}
function words(data,count,code) {
  need(typeof data==='string' && new RegExp('^0x[0-9a-fA-F]{'+(count*64)+'}$').test(data),code);
  return Array.from({length:count},(_,i)=>BigInt('0x'+data.slice(2+i*64,66+i*64)));
}
async function read(engine,network,to,signature,args,ref) {
  return engine.rpc.agree(network,'eth_call',[{to,data:selector(signature)+args},ref]);
}
/** Direct-pair quotes only; gas, approvals, split and cross-chain costs are NOT optimized here. */
export async function quoteDirectPools(engine,network,input) {
  shape(input,['tokenIn','tokenOut','amount','slippageBps']);
  const a=configured(network,input.tokenIn,'erc20'),b=configured(network,input.tokenOut,'erc20');need(a.address!==b.address,'IDENTICAL_POOL_ASSETS');
  need(Number.isSafeInteger(input.slippageBps)&&input.slippageBps>=0&&input.slippageBps<=network.maxSlippageBps,'SLIPPAGE_OUTSIDE_LOCAL_POLICY');
  const amount=parseUnits(input.amount,a.decimals),startedAt=engine.now(),snap=await engine.rpc.snapshot(network,startedAt),expiresAt=startedAt+30000;
  const pools=network.contracts.filter(p=>p.kind==='pool'&&[p.token0,p.token1].includes(a.address)&&[p.token0,p.token1].includes(b.address));
  need(pools.length>0&&pools.length<=16,'DIRECT_POOL_COUNT_UNSUPPORTED');
  await engine.rpc.verifyPins(network,[a,b],snap.ref);
  for(const token of [a,b])need(words(await read(engine,network,token.address,'decimals()','',snap.ref),1,'TOKEN_DECIMALS_RESPONSE_INVALID')[0]===BigInt(token.decimals),'TOKEN_DECIMALS_CHANGED');
  const candidates=[],excluded=[];
  for(const pool of pools) {
    try {
      await engine.rpc.verifyPins(network,[pool],snap.ref);
      for(const n of [0,1])need(words(await read(engine,network,pool.address,`token${n}()`,'',snap.ref),1,'POOL_TOKEN_RESPONSE_INVALID')[0]===BigInt(pool['token'+n]),'POOL_ASSET_MAPPING_MISMATCH');
      const fee=words(await read(engine,network,pool.address,'feeBasisPoints()','',snap.ref),1,'POOL_FEE_RESPONSE_INVALID')[0];need(fee>=1n&&fee<=100n,'POOL_FEE_INVALID');
      const [reserve0,reserve1,timestamp]=words(await read(engine,network,pool.address,'getReserves()','',snap.ref),3,'POOL_RESERVES_INVALID');
      need(reserve0>0n&&reserve1>0n&&reserve0<(1n<<112n)&&reserve1<(1n<<112n)&&timestamp<(1n<<32n),'POOL_RESERVES_INVALID');
      const [rin,rout]=a.address===pool.token0?[reserve0,reserve1]:[reserve1,reserve0];
      const afterFee=BigInt(amount)*(10000n-fee),expected=afterFee*rout/(rin*10000n+afterFee);
      const output=words(await read(engine,network,pool.address,'quoteExactIn(address,uint256)',abiAddress(a.address)+abiWord(amount),snap.ref),1,'POOL_QUOTE_INVALID')[0];
      need(output===expected&&output>0n,'POOL_QUOTE_FORMULA_MISMATCH');
      // Round UP: floor rounding could exceed the configured slippage by one atomic unit.
      const minimum=(output*BigInt(10000-input.slippageBps)+9999n)/10000n;
      candidates.push({pool:pool.address,feeBps:Number(fee),outputAtomic:String(output),output:formatUnits(String(output),b.decimals),minimumOutputAtomic:String(minimum),minimumOutput:formatUnits(String(minimum),b.decimals)});
    } catch(error) {excluded.push({pool:pool.address,error:safeError(error)});}
  }
  const end=await engine.rpc.agree(network,'eth_getBlockByNumber',[snap.number,false]);
  need(end&&end.hash===snap.hash&&BigInt(end.number)===BigInt(snap.number),'DEX_QUOTE_BLOCK_CHANGED');need(engine.now()<expiresAt,'DEX_QUOTE_EXPIRED_DURING_READ');
  candidates.sort((x,y)=>BigInt(x.outputAtomic)===BigInt(y.outputAtomic)?x.pool.localeCompare(y.pool):BigInt(x.outputAtomic)>BigInt(y.outputAtomic)?-1:1);
  return {schema:'realdex.direct-pool-quotes.v1',chainId:network.chainId,genesisHash:network.genesisHash,tokenIn:a.address,tokenOut:b.address,
    amountAtomic:amount,amount:formatUnits(amount,a.decimals),inputSymbol:a.symbol,outputSymbol:b.symbol,slippageBps:input.slippageBps,
    blockHash:snap.hash,blockNumber:snap.number,observedAt:startedAt,expiresAt,candidates,excluded,comparisonComplete:excluded.length===0,
    highestGrossOutputPool:candidates[0]?.pool??null,executionReady:false,additionalFeesIncluded:false,
    warning:'Only owner-configured direct pools, after pool fee but before gas/approval costs; not a net-optimal, executable, or independently certified quote.'};
}

/** Quote ONE explicit 1–4 hop route. This is not route search, split execution or
 * net optimization. All pools and assets (including intermediate ones) must be
 * in the owner's policy. No allowance changes, signatures or nonce reservations. */
export async function quoteLocalRoute(engine,network,input) {
  shape(input,['router','pools','tokenIn','amount','slippageBps']);
  const route=resolveLocalRoute(network,input.router,input.pools,input.tokenIn);
  need(Number.isSafeInteger(input.slippageBps)&&input.slippageBps>=0&&input.slippageBps<=network.maxSlippageBps,'SLIPPAGE_OUTSIDE_LOCAL_POLICY');
  const amount=parseUnits(input.amount,route.tokenIn.decimals),startedAt=engine.now(),expiresAt=startedAt+30000;
  const snap=await engine.rpc.snapshot(network,startedAt);
  await engine.rpc.verifyPins(network,route.contractPins,snap.ref);
  for(const t of route.tokens)need(words(await read(engine,network,t.address,'decimals()','',snap.ref),1,'TOKEN_DECIMALS_RESPONSE_INVALID')[0]===BigInt(t.decimals),'TOKEN_DECIMALS_CHANGED');
  let current=BigInt(amount);const hops=[];
  for(let i=0;i<route.pools.length;i++){
    const pool=route.pools[i],a=route.tokens[i],b=route.tokens[i+1];
    for(const n of [0,1])need(words(await read(engine,network,pool.address,`token${n}()`,'',snap.ref),1,'POOL_TOKEN_RESPONSE_INVALID')[0]===BigInt(pool['token'+n]),'POOL_ASSET_MAPPING_MISMATCH');
    const fee=words(await read(engine,network,pool.address,'feeBasisPoints()','',snap.ref),1,'POOL_FEE_RESPONSE_INVALID')[0];need(fee>=1n&&fee<=100n,'POOL_FEE_INVALID');
    const [r0,r1,time]=words(await read(engine,network,pool.address,'getReserves()','',snap.ref),3,'POOL_RESERVES_INVALID');
    need(r0>0n&&r1>0n&&r0<(1n<<112n)&&r1<(1n<<112n)&&time<(1n<<32n),'POOL_RESERVES_INVALID');
    // Conservative: stale reserves, donations and deficient balances need review,
    // not silent selection. These remain RPC observations, not token-behaviour proofs.
    for(const n of [0,1])need(words(await read(engine,network,pool['token'+n],'balanceOf(address)',abiAddress(pool.address),snap.ref),1,'TOKEN_BALANCE_RESPONSE_INVALID')[0]===[r0,r1][n],'POOL_BALANCE_RESERVE_MISMATCH');
    const [rin,rout]=a.address===pool.token0?[r0,r1]:[r1,r0],adjusted=current*(10000n-fee),expected=adjusted*rout/(rin*10000n+adjusted);
    const observed=words(await read(engine,network,pool.address,'quoteExactIn(address,uint256)',abiAddress(a.address)+abiWord(current),snap.ref),1,'POOL_QUOTE_INVALID')[0];
    need(expected>0n&&expected===observed,'POOL_QUOTE_FORMULA_MISMATCH');
    hops.push({pool:pool.address,tokenIn:a.address,tokenOut:b.address,inputAtomic:String(current),outputAtomic:String(observed),feeBps:Number(fee)});current=observed;
  }
  const routerData=routerQuoteData({tokenIn:route.tokenIn.address,amountAtomic:amount,pools:route.pools.map(p=>p.address)});
  const routerResult=words(await engine.rpc.agree(network,'eth_call',[{to:route.router.address,data:routerData},snap.ref]),2,'ROUTER_QUOTE_INVALID');
  need(routerResult[0]===current,'ROUTER_QUOTE_FORMULA_MISMATCH');need(routerResult[1]===BigInt(route.tokenOut.address),'ROUTER_OUTPUT_ASSET_MISMATCH');
  const end=await engine.rpc.agree(network,'eth_getBlockByNumber',[snap.number,false]);
  need(end&&end.hash===snap.hash&&BigInt(end.number)===BigInt(snap.number),'DEX_QUOTE_BLOCK_CHANGED');need(engine.now()<expiresAt,'DEX_QUOTE_EXPIRED_DURING_READ');
  const minimum=(current*BigInt(10000-input.slippageBps)+9999n)/10000n;
  return {schema:'realdex.local-route-quote.v1',chainId:network.chainId,genesisHash:network.genesisHash,router:route.router.address,
    pools:route.pools.map(p=>p.address),tokenPath:route.tokens.map(t=>t.address),tokenIn:route.tokenIn.address,tokenOut:route.tokenOut.address,
    amountAtomic:amount,amount:formatUnits(amount,route.tokenIn.decimals),inputSymbol:route.tokenIn.symbol,outputSymbol:route.tokenOut.symbol,
    outputAtomic:String(current),output:formatUnits(String(current),route.tokenOut.decimals),minimumOutputAtomic:String(minimum),minimumOutput:formatUnits(String(minimum),route.tokenOut.decimals),
    hops,slippageBps:input.slippageBps,blockHash:snap.hash,blockNumber:snap.number,observedAt:startedAt,expiresAt,
    executionReady:false,additionalFeesIncluded:false,routeSearchPerformed:false,automaticApproval:false,
    warning:'One explicit owner-configured route; fees within pools only. No gas/approval costs, optimality claim, automatic approval, token audit or independent consensus proof.'};
}
