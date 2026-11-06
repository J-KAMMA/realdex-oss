import {selector,keccak256} from '../verified/keccak.mjs';
import {uintWord,addressWord} from '../verified/evm.mjs';
export const NOW=1788566400000, H='0x'+'a'.repeat(64), OTHER_H='0x'+'b'.repeat(64);
export const A='0x'+'1'.repeat(40),B='0x'+'2'.repeat(40),F='0x'+'a'.repeat(40),F2='0x'+'b'.repeat(40),P='0x'+'3'.repeat(40),P2='0x'+'4'.repeat(40),ACCOUNT='0x'+'9'.repeat(40);
export const FACTORY_CODE='0x60806040526001600055',POOL_CODE='0x600160005500',TOKEN_CODE='0x600260005500';
export const TEST_POLICY={factoryRuntimeHash:keccak256(FACTORY_CODE)};
export const candidate=(factory=F)=>({chainId:'eip155:84532',address:factory,protocol:'realdex-cpmm-v1'});
export const request=(changes={})=>({requestId:'observation-request-1',chainId:'eip155:84532',tokenIn:A,tokenOut:B,amountIn:100000n,slippageBps:50,feeTiers:[5,30],...changes});
const word=v=>'0x'+uintWord(v),addr=v=>'0x'+addressWord(v);
const SIG=Object.fromEntries(['getPool(address,address,uint256)','factory()','token0()','token1()','feeBasisPoints()','getReserves()',
  'quoteExactIn(address,uint256)','balanceOf(address)','allowance(address,address)','swapExactIn(address,uint256,uint256,address,uint256)'].map(s=>[s,selector(s)]));
export function rpcFixture({hook,allowance=1000000n,balance=1000000n}={}) {
  const calls=[];
  const pools=new Map([[P,{factory:F,fee:5n,r0:1000000n,r1:1000000n}],[P2,{factory:F2,fee:30n,r0:1000000n,r1:1100000n}]]);
  const block={number:'0x63',hash:H,timestamp:'0x'+BigInt(NOW/1000).toString(16)};
  async function result(method,params,index) {
    if(method==='eth_chainId')return '0x14a34';
    if(method==='eth_getBlockByNumber')return {...block,number:params[0]==='latest'?'0x64':params[0]};
    if(method==='eth_gasPrice')return index===0?'0x3b9aca00':'0x4190ab00';
    if(method==='eth_estimateGas')return index===0?'0x1d4c0':'0x1e848';
    if(!['eth_getCode','eth_call'].includes(method))throw new Error('TEST_UNSUPPORTED_METHOD');
    if(params.length!==2 || params[1].blockHash!==H || params[1].requireCanonical!==true)throw new Error('TEST_BLOCK_NOT_PINNED');
    if(method==='eth_getCode') {
      if([F,F2].includes(params[0]))return FACTORY_CODE;
      if(pools.has(params[0]))return POOL_CODE;
      if([A,B].includes(params[0]))return TOKEN_CODE;return '0x';
    }
    const tx=params[0],sel=tx.data.slice(0,10),args=[];
    for(let i=10;i<tx.data.length;i+=64)args.push(BigInt('0x'+tx.data.slice(i,i+64)));
    if([F,F2].includes(tx.to) && sel===SIG['getPool(address,address,uint256)']){
      return args[2]===(tx.to===F?5n:30n)?addr(tx.to===F?P:P2):'0x'+'0'.repeat(64);
    }
    const p=pools.get(tx.to);
    if(p){
      if(sel===SIG['factory()'])return addr(p.factory);
      if(sel===SIG['token0()'])return addr(A);
      if(sel===SIG['token1()'])return addr(B);
      if(sel===SIG['feeBasisPoints()'])return word(p.fee);
      if(sel===SIG['getReserves()'])return '0x'+uintWord(p.r0)+uintWord(p.r1)+uintWord(BigInt(NOW/1000));
      if([SIG['quoteExactIn(address,uint256)'],SIG['swapExactIn(address,uint256,uint256,address,uint256)']].includes(sel)){
        const forward=args[0]===BigInt(A),rin=forward?p.r0:p.r1,rout=forward?p.r1:p.r0,x=args[1]*(10000n-p.fee);
        return word(x*rout/(rin*10000n+x));
      }
    }
    if([A,B].includes(tx.to)){
      if(sel===SIG['balanceOf(address)']){
        const target='0x'+args[0].toString(16).padStart(40,'0'),pool=pools.get(target);
        return word(pool?(tx.to===A?pool.r0:pool.r1):balance);
      }
      if(sel===SIG['allowance(address,address)'])return word(allowance);
    }
    throw new Error('TEST_UNKNOWN_CALL');
  }
  const readers=[0,1].map(index=>({id:`fixture-rpc-${index}`,displayId:`fixture-rpc-${index}`,async send(method,params){
    calls.push({method,params:structuredClone(params),index});
    const value=await result(method,params,index);
    return hook?hook({method,params,index,value,calls,pools,block}):value;
  }}));
  return {readers,calls,pools,block};
}
export const isCall=(params,signature,to)=>params[0]?.data?.slice(0,10)===SIG[signature] && (!to||params[0]?.to===to);
