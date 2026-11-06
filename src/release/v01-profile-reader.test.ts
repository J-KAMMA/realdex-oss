import { Interface } from "ethers";
import { describe, expect, it, vi } from "vitest";
import { ERC20_ABI, FACTORY_ABI, POOL_ABI } from "../abi";
import { createPublicJsonRpcDeploymentReader } from "./evm-json-rpc-reader";
import { createV01ProfileReaders } from "./v01-profile-reader";

const factory = "0x1111111111111111111111111111111111111111";
const pool = "0x2222222222222222222222222222222222222222";
const ambr = "0x3333333333333333333333333333333333333333";
const jade = "0x4444444444444444444444444444444444444444";
const tokenAbi = new Interface(ERC20_ABI);
const factoryAbi = new Interface(FACTORY_ABI);
const poolAbi = new Interface(POOL_ABI);
const endpoints = ["https://rpc-a.example.org", "https://rpc-b.example.org"];

describe("v0.1 bounded profile readers", () => {
  it("reads only the exact token/pool ABI through the same credential-free endpoints", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.method).toBe("eth_call");
      expect(body.params[1]).toBe("latest");
      const { to, data } = body.params[0];
      expect(Object.keys(body.params[0]).sort()).toEqual(["data", "to"]);
      const abi = to === factory ? factoryAbi : to === pool ? poolAbi : tokenAbi;
      const tx = abi.parseTransaction({ data })!;
      let values: unknown[];
      if (tx.name === "getPool") {
        expect(to).toBe(factory); expect([...tx.args]).toEqual([ambr, jade, BigInt(1)]); values = [pool];
      } else if (tx.name === "feeBasisPoints") { expect(to).toBe(pool); values = [1]; }
      else if (tx.name === "factory") values = [factory];
      else if (tx.name === "token0") values = [ambr];
      else if (tx.name === "token1") values = [jade];
      else if (tx.name === "decimals") values = [18];
      else if (tx.name === "name") values = [to === ambr ? "Demo Amber" : "Demo Jade"];
      else if (tx.name === "symbol") values = [to === ambr ? "AMBR" : "JADE"];
      else throw new Error("Unexpected ABI method");
      expect(init?.credentials).toBe("omit"); expect(init?.referrerPolicy).toBe("no-referrer");
      expect(init?.cache).toBe("no-store"); expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: abi.encodeFunctionResult(tx.name, values) }));
    });
    const readers = createV01ProfileReaders(endpoints, fetchMock as typeof fetch);
    expect(readers.map(reader => reader.id)).toEqual(["rpc-a.example.org", "rpc-b.example.org"]);
    for (const reader of readers) {
      expect(Object.isFrozen(reader)).toBe(true);
      await expect(reader.poolFor(factory, ambr, jade, 1)).resolves.toBe(pool);
      await expect(reader.poolFee(pool)).resolves.toBe(1);
      await expect(reader.poolFactory(pool)).resolves.toBe(factory);
      await expect(reader.poolTokens(pool)).resolves.toEqual({ token0: ambr, token1: jade });
      await expect(reader.tokenMetadata(ambr)).resolves.toEqual({ name: "Demo Amber", symbol: "AMBR", decimals: 18 });
      await expect(reader.tokenMetadata(jade)).resolves.toEqual({ name: "Demo Jade", symbol: "JADE", decimals: 18 });
    }
    expect(fetchMock).toHaveBeenCalledTimes(22);
    expect(new Set(fetchMock.mock.calls.map(([url]) => new URL(String(url)).hostname))).toEqual(new Set(["rpc-a.example.org", "rpc-b.example.org"]));
  });

  it("refuses non-independent/credentialed endpoints before fetching", () => {
    const fetchMock = vi.fn();
    for (const values of [[endpoints[0]], [endpoints[0], `${endpoints[0]}/other`], [endpoints[0], "http://rpc-b.example.org"], [endpoints[0], "https://user:pass@rpc-b.example.org"], [endpoints[0], "https://rpc-b.example.org?key=example"]]) {
      expect(() => createV01ProfileReaders(values, fetchMock)).toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects malformed call arguments before transport and never exposes submission", async () => {
    const fetchMock = vi.fn();
    const reader = createPublicJsonRpcDeploymentReader(endpoints[0], fetchMock);
    for (const [target, data] of [["invalid", "0x12345678"], [pool, "0x"], [pool, "0x1234567"], [pool, `0x${"11".repeat(257)}`]]) await expect(reader.call(target, data)).rejects.toThrow("DEPLOYMENT_RPC_CALL_INVALID");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reader).not.toHaveProperty("sendTransaction");
    expect(reader).not.toHaveProperty("request");
  });

  it("fails malformed/oversized ABI responses instead of inventing metadata", async () => {
    for (const result of ["0x", "0xzz", "0x01"]) {
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init?.body)).id, result })));
      await expect(createV01ProfileReaders(endpoints, fetchMock as typeof fetch)[0].tokenMetadata(ambr)).rejects.toThrow();
    }
    const tooLarge = vi.fn(async () => new Response("too large", { headers: { "content-length": "1000001" } }));
    await expect(createV01ProfileReaders(endpoints, tooLarge)[0].poolFactory(pool)).rejects.toThrow("DEPLOYMENT_RPC_RESPONSE_TOO_LARGE");
  });
});
