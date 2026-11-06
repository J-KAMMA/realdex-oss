/** Actual deployments on an explicitly disposable Anvil chain, never a public chain. */
import {deploy,prepareDeployer,send,read,number,addr,DEPLOYER} from './abi.mjs';
import {keccak256} from '../../node/verified/keccak.mjs';
export async function createMarket(chain,account,build) {
  await prepareDeployer(chain);
  const token = async symbol => deploy(chain,build,'contracts/test/MockERC20.sol','MockERC20',['Test '+symbol,symbol,6]);
  const a=await token('A'),b=await token('B'),c=await token('C');
  const factory=await deploy(chain,build,'contracts/LocalSwapFactory.sol','LocalSwapFactory');
  const router=await deploy(chain,build,'contracts/LocalSwapRouter.sol','LocalSwapRouter');
  const contracts=[];
  const pin=async(address,kind,details={})=>({address,kind,runtimeHash:keccak256(await chain.call('eth_getCode',[address,'latest'])),...details});
  for(const [address,symbol] of [[a,'A'],[b,'B'],[c,'C']]) {
    contracts.push(await pin(address,'erc20',{symbol,decimals:6,approvalCapAtomic:'1000000000000'}));
    await send(chain,address,'mint(address,uint256)',[DEPLOYER,1000000000000n]);
    await send(chain,address,'mint(address,uint256)',[account.address,100000000n]);
  }
  contracts.push(await pin(factory,'factory'),await pin(router,'router'));
  const makePool=async(x,y,fee=30n)=>{
    await send(chain,factory,'createPool(address,address,uint256)',[x,y,fee]);
    const p=addr(await read(chain,factory,'getPool(address,address,uint256)',[x,y,fee]));
    const t0=addr(await read(chain,p,'token0()')),t1=addr(await read(chain,p,'token1()'));
    for(const t of [t0,t1])await send(chain,t,'approve(address,uint256)',[p,1000000000n]);
    const head=await chain.call('eth_getBlockByNumber',['latest',false]);
    await send(chain,p,'addLiquidity(uint256,uint256,uint256,address,uint256)',[1000000000n,1000000000n,1n,DEPLOYER,BigInt(head.timestamp)+300n]);
    contracts.push(await pin(p,'pool',{token0:t0,token1:t1}));return p;
  };
  const ab=await makePool(a,b),bc=await makePool(b,c),ab5=await makePool(a,b,5n);
  return {contracts,a,b,c,ab,bc,ab5,factory,router,pin,makePool,
    balance:(token,owner)=>number(chain,token,'balanceOf(address)',[owner]),
    allowance:(token,owner,spender)=>number(chain,token,'allowance(address,address)',[owner,spender])};
}
