import { Interface } from "ethers";
import { ERC20_ABI, FACTORY_ABI, POOL_ABI } from "../abi";
import { assertDistinctPublicRpcEndpoints, createPublicJsonRpcDeploymentReader } from "./evm-json-rpc-reader";
import type { V01ProfileReader } from "./v01-profile";

/** Same bounded, credential-free endpoints serve deployment and token/pool checks. */
export function createV01ProfileReaders(endpoints: readonly string[], fetchImpl: typeof fetch = fetch): V01ProfileReader[] {
  const tokenAbi = new Interface(ERC20_ABI);
  const factoryAbi = new Interface(FACTORY_ABI);
  const poolAbi = new Interface(POOL_ABI);
  return assertDistinctPublicRpcEndpoints(endpoints).map(endpoint => {
    const reader = createPublicJsonRpcDeploymentReader(endpoint, fetchImpl);
    const call = async (address: string, abi: Interface, method: string, args: readonly unknown[] = []) => abi.decodeFunctionResult(method, await reader.call(address, abi.encodeFunctionData(method, args)));
    return Object.freeze({
      ...reader,
      poolFor: async (factory: string, a: string, b: string, feeBasisPoints: number) => (await call(factory, factoryAbi, "getPool", [a, b, feeBasisPoints]))[0] as string,
      poolFee: async (pool: string) => Number((await call(pool, poolAbi, "feeBasisPoints"))[0]),
      poolFactory: async (pool: string) => (await call(pool, poolAbi, "factory"))[0] as string,
      poolTokens: async (pool: string) => {
        const [a, b] = await Promise.all([call(pool, poolAbi, "token0"), call(pool, poolAbi, "token1")]);
        return { token0: a[0] as string, token1: b[0] as string };
      },
      tokenMetadata: async (token: string) => {
        const [name, symbol, decimals] = await Promise.all([call(token, tokenAbi, "name"), call(token, tokenAbi, "symbol"), call(token, tokenAbi, "decimals")]);
        return { name: name[0] as string, symbol: symbol[0] as string, decimals: Number(decimals[0]) };
      }
    });
  });
}
