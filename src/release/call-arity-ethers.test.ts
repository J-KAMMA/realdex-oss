import { describe, expect, it } from "vitest";
import { Contract, Interface, type ContractRunner } from "ethers";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Independent ABI/overrides decoding by the repository's locked ethers version.
// The runner is in-memory; sendTransaction throws at a deliberate offline boundary.
// No providers, keys, RPC, real transactions, or evaluation of fixture source.
const address="0x1000000000000000000000000000000000000001";
const other="0x2000000000000000000000000000000000000002";
const abi=["function createPool(address,address,uint256) view returns (address)"];
const iface=new Interface(abi);
const stop=new Error("OFFLINE_SEND_BOUNDARY");
const runner: ContractRunner={
  provider:null,
  call:async()=>iface.encodeFunctionResult("createPool",[address]),
  estimateGas:async()=>21000n,
  sendTransaction:async()=>{throw stop;}
};
const factory=new Contract(address,abi,runner);
const script=fileURLToPath(new URL("../../scripts/checkContractCallArity.mjs",import.meta.url));
function check(code:string){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"realdex ethers oracle "));
  try{
    for(const dir of ["src","scripts","contracts"])fs.mkdirSync(path.join(root,dir));
    fs.copyFileSync(script,path.join(root,"scripts/checkContractCallArity.mjs"));
    fs.writeFileSync(path.join(root,"contracts/Fixture.sol"),"contract Fixture { function createPool(address a,address b,uint256 fee) external view returns(address) {} }");
    fs.writeFileSync(path.join(root,"src/fixture.ts"),code);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>["PATH","HOME","SystemRoot","WINDIR","TEMP","TMP","TMPDIR","LANG","LC_ALL","TZ"].includes(key)));
    const r=spawnSync(process.execPath,["scripts/checkContractCallArity.mjs","--json"],{cwd:root,env,encoding:"utf8",timeout:10000,shell:false});
    expect(r.error).toBeUndefined();expect(r.signal).toBeNull();
    const report=JSON.parse(r.stdout);
    expect(report.matchedCalls).toBe(1);
    return r.status===0;
  }finally{fs.rmSync(root,{recursive:true,force:true});}
}
const cases: {name:string;values:unknown[];source:string;valid:boolean}[]=[
  {name:"zero",values:[],source:"",valid:false},
  {name:"one",values:[address],source:"a",valid:false},
  {name:"missing fee",values:[address,other],source:"a,b",valid:false},
  {name:"three",values:[address,other,300n],source:"a,b,300n",valid:true},
  {name:"extra scalar",values:[address,other,300n,1n],source:"a,b,300n,1n",valid:false},
  {name:"literal overrides",values:[address,other,300n,{gasLimit:100000n}],source:"a,b,300n,{gasLimit:100000n}",valid:true},
  {name:"two extra objects",values:[address,other,300n,{},{}],source:"a,b,300n,{},{}",valid:false}
];
describe("offline locked-ethers differential arity checks",()=>{
  for(const helper of ["staticCall","staticCallResult","send","estimateGas","populateTransaction"] as const){
    for(const explicit of [false,true])for(const c of cases){
      it(`${explicit?"getFunction":"direct"}.${helper}: ${c.name}`,async()=>{
        const method=explicit?factory.getFunction("createPool"):factory.createPool;
        let accepted=false;
        try{await method[helper](...c.values);accepted=true;}
        catch(error){if(error===stop)accepted=true;}
        expect(accepted).toBe(c.valid);
        const access=explicit?'factory.getFunction("createPool")':"factory.createPool";
        expect(check(`${access}.${helper}(${c.source});`)).toBe(accepted);
      });
    }
  }
  it("BaseContract.getAddress is a host method, not a Solidity method helper",async()=>{
    expect(await factory.getAddress()).toBe(address);
    expect((factory.getAddress as unknown as {staticCall?:unknown}).staticCall).toBeUndefined();
  });
});
