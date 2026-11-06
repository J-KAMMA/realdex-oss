export const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)"
] as const;

export const FACTORY_ABI = [
  // A pair may have one pool per fee tier, so the tier is part of the lookup.
  "function getPool(address,address,uint256) view returns (address)",
  "function createPool(address,address,uint256) returns (address)",
  // The registry is only walkable from outside if its length is readable.
  "function allPoolsLength() view returns (uint256)",
  "function allPools(uint256) view returns (address)",
  "event PoolCreated(address indexed token0,address indexed token1,uint256 indexed feeBasisPoints,address pool,uint256 poolCount)"
] as const;

export const POOL_ABI = [
  "function factory() view returns (address)",
  "function feeBasisPoints() view returns (uint256)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function quoteExactIn(address,uint256) view returns (uint256)",
  "function swapExactIn(address,uint256,uint256,address,uint256) returns (uint256)",
  "function addLiquidity(uint256,uint256,uint256,address,uint256) returns (uint256)",
  "function removeLiquidity(uint256,uint256,uint256,address,uint256) returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)"
] as const;

export const ROUTER_ABI = [
  "function MAX_HOPS() view returns (uint256)",
  "function quoteExactIn(address[],address,uint256) view returns (uint256,address)",
  "function swapExactIn(address[],address,uint256,uint256,address,uint256) returns (uint256,address)",
  // The router settles the deposit ratio at execution time, so a deposit routed
  // through it leaves nothing approved. Quoting from the same contract keeps the
  // number on screen and the number that will be pulled as one implementation.
  "function quoteAddLiquidity(address,uint256,uint256) view returns (uint256,uint256)",
  "function addLiquidity(address,uint256,uint256,uint256,uint256,uint256,address,uint256) returns (uint256,uint256,uint256)"
] as const;
