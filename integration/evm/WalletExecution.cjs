/** REAL Hardhat EVM acceptance tests. No synthetic RPC results or success fallbacks.
 * Two HTTP endpoints forward to ONE in-process EVM; this is not independent-node consensus.
 * These tests require the pinned root dependencies and solc 0.8.24 to be installed.
 */
const assert=require('node:assert/strict');const http=require('node:http');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');
const hre=require('hardhat');const {ethers}=hre;
const ROOT=path.resolve(__dirname,'../..');
const PASSWORD='integration public test password - never use for funds';
const PUBLIC_TEST_KEY='46'.repeat(32),RECIPIENT='0x3535353535353535353535353535353535353535';
let modules;
async function load(){
  if(!modules)modules=Object.assign({},...await Promise.all(['wallet/lib/storage.mjs','wallet/lib/vault.mjs','wallet/lib/server.mjs','wallet/lib/evm-engine.mjs','wallet/lib/network.mjs','wallet/lib/agent-policy.mjs','wallet/agent/client.mjs','wallet/lib/contract-identity.mjs'].map(p=>import(require('node:url').pathToFileURL(path.join(ROOT,p)).href))));
  return modules;
}
async function endpoints(){
  const servers=[],sent=[];
  for(let i=0;i<2;i++){
    const server=http.createServer(async(req,res)=>{
      let id=null;
      try{let body='';for await(const b of req){body+=b;assert.ok(body.length<524288);}const call=JSON.parse(body);id=call.id;
        if(call.method==='eth_sendRawTransaction')sent.push(call.params[0]);
        const result=await hre.network.provider.request({method:call.method,params:call.params});
        res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,result}));
      }catch(e){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:e.code??-32000,message:'EVM_CALL_REJECTED'}}));}
    });
    await new Promise(r=>server.listen(0,'127.0.0.1',r));servers.push(server);
  }
  return {urls:servers.map(s=>'http://127.0.0.1:'+s.address().port+'/'),sent,
    async close(){await Promise.all(servers.map(s=>new Promise(r=>{s.close(r);s.closeAllConnections();})));}};
}
async function fixture(contracts=[]){
  const m=await load();assert.equal(hre.network.name,'hardhat');assert.equal((await ethers.provider.getNetwork()).chainId,31337n);
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'realdex-real-evm-')),store=new m.PrivateStore(directory),vault=new m.Vault(store);let rpc,app;
  try{
    await vault.create(PASSWORD);const account=await vault.addAccount({family:'evm',label:'PUBLIC INTEGRATION TEST ONLY',secretHex:PUBLIC_TEST_KEY});
    const backup=await vault.backup();await vault.verifyBackup(backup.encrypted,PASSWORD);
    await hre.network.provider.request({method:'hardhat_setBalance',params:[account.address,ethers.toQuantity(ethers.parseEther('100'))]});
    rpc=await endpoints();const genesis=await hre.network.provider.request({method:'eth_getBlockByNumber',params:['0x0',false]});
    const network=m.validateNetwork({chainId:'31337',name:'REAL in-process EVM test',symbol:'TEST',rpcUrls:rpc.urls,genesisHash:genesis.hash,broadcastEnabled:true,contracts,maxFeeWei:'10000000000000000',maxSlippageBps:100,confirmationPolicy:{minConfirmations:1,finalityTag:'none'}});
    app=new m.WalletServer({store,vault,settings:{schema:'realdex.wallet-settings.v1',allowedAppOrigins:[],networks:[network]}});const start=await app.start(0);
    const submit=async(to,data='0x',value='0x0')=>{
      const intent=await app.engine.prepare(network,account,{from:account.address,to:to.toLowerCase(),value,data});
      const record=await app.engine.sign(vault,network,intent);await app.engine.broadcast(vault,network,record);
      const observation=await app.engine.reconcile(vault,network,record);assert.equal(observation.state,'reported-confirmed');return observation;
    };
    return {m,directory,store,vault,account,rpc,network,app,start,submit,
      async owner(route,body){
        const response=await fetch(start.origin+'/api/'+route,{method:'POST',headers:{origin:start.origin,'content-type':'application/json',authorization:'Bearer '+app.uiToken},body:JSON.stringify(body)});
        const result=await response.json();assert.equal(response.ok,true,result.error);return result;
      },
      async agent(asset='native'){
        const policy={label:'REAL EVM bounded agent',accountId:account.id,chainId:'31337',asset,recipients:[RECIPIENT],mode:'auto',expiresAt:Date.now()+3600000,
          limits:{perTransferAtomic:'1000000',rolling24hAtomic:'2000000',lifetimeAtomic:'3000000',perTxFeeWei:'1000000000000000',rolling24hFeeWei:'2000000000000000',lifetimeFeeWei:'3000000000000000',maxTransfers:10,minIntervalMs:0}};
        const draft=await app.agents.preparePolicy(policy);const grant=await app.agents.createPolicy({draftId:draft.draftId,digest:draft.digest,confirmation:m.AUTO_CONFIRMATION});
        return new m.AgentWalletClient({url:start.origin,token:grant.token});
      },
      async close(){await app.close();await rpc.close();fs.rmSync(directory,{recursive:true,force:true});}};
  }catch(e){if(app)await app.close();else{vault.lock();store.close();}await rpc?.close();fs.rmSync(directory,{recursive:true,force:true});throw e;}
}
async function market(){
  const [owner]=await ethers.getSigners(),Token=await ethers.getContractFactory('MockERC20');
  const a=await Token.deploy('Asset A','A',18),b=await Token.deploy('Asset B','B',18);await a.waitForDeployment();await b.waitForDeployment();
  const factory=await (await ethers.getContractFactory('LocalSwapFactory')).deploy();await factory.waitForDeployment();await (await factory.createPool(a.target,b.target,1)).wait();
  const pool=await ethers.getContractAt('LocalSwapPool',await factory.getPool(a.target,b.target,1));
  const router=await (await ethers.getContractFactory('LocalSwapRouter')).deploy();await router.waitForDeployment();
  for(const token of [a,b]){await (await token.mint(owner.address,1000000000000n)).wait();await (await token.approve(pool.target,1000000000000n)).wait();}
  const block=await ethers.provider.getBlock('latest');await (await pool.addLiquidity(1000000000n,1000000000n,1,owner.address,block.timestamp+300)).wait();
  const pin=async(c,kind,extra={})=>({address:c.target.toLowerCase(),kind,runtimeHash:ethers.keccak256(await ethers.provider.getCode(c.target)),...extra});
  const contracts=await Promise.all([pin(a,'erc20',{symbol:'A',decimals:18,approvalCapAtomic:'1000000000000'}),pin(b,'erc20',{symbol:'B',decimals:18,approvalCapAtomic:'1000000000000'}),pin(factory,'factory'),pin(router,'router'),pin(pool,'pool',{token0:(await pool.token0()).toLowerCase(),token1:(await pool.token1()).toLowerCase()})]);
  return {owner,a,b,factory,pool,router,contracts};
}
function sourceMap(info){return Object.fromEntries(Object.keys(info.input.sources).map(name=>[name,fs.readFileSync(path.join(ROOT,name),'utf8')]));}
describe('RealDEX v0.9 real-EVM acceptance',function(){
  this.timeout(120000);
  beforeEach(async()=>{await hre.network.provider.request({method:'hardhat_reset',params:[]});});
  it('executes an agent native payment once, verifies receipt, and retains charge across an actual state revert',async()=>{
    const f=await fixture();try{
      const client=await f.agent(),request={idempotencyKey:'actual-native-1',recipient:RECIPIENT,amountAtomic:'50'};
      const snapshot=await hre.network.provider.request({method:'evm_snapshot',params:[]});
      const before=await ethers.provider.getBalance(RECIPIENT);assert.equal((await client.preview(request)).canRequest,true);
      const first=await client.transfer(request);assert.equal(first.broadcastState,'broadcast');assert.equal((await client.transfer(request)).transactionHash,first.transactionHash);assert.equal(f.rpc.sent.length,1);
      const result=await client.result(request.idempotencyKey,{refresh:true});assert.equal(result.broadcastState,'reported-confirmed');assert.equal(result.receiptObservation.policySatisfied,true);
      assert.equal(await ethers.provider.getBalance(RECIPIENT)-before,50n);
      await hre.network.provider.request({method:'evm_revert',params:[snapshot]});const lost=await client.result(request.idempotencyKey,{refresh:true});assert.equal(lost.broadcastState,'broadcast-unknown');assert.equal(lost.receiptObservation.transactionReportedSuccessful,null);assert.equal((await client.status()).policy.usage.lifetimeAtomic,'50');assert.equal(f.rpc.sent.length,1);
    }finally{await f.close();}
  });
  it('executes an ERC20 payment and checks the actual token balance delta and bound Transfer event',async()=>{
    const m=await market(),f=await fixture(m.contracts);try{
      await (await m.a.mint(f.account.address,10000n)).wait();const client=await f.agent(m.a.target.toLowerCase()),request={idempotencyKey:'actual-token-1',recipient:RECIPIENT,amountAtomic:'100'};
      const before=await m.a.balanceOf(RECIPIENT);await client.transfer(request);const r=await client.result(request.idempotencyKey,{refresh:true});assert.equal(r.receiptObservation.matchingTransferEventObserved,true);assert.equal(await m.a.balanceOf(RECIPIENT)-before,100n);
    }finally{await f.close();}
  });
  it('matches compiler-derived CREATE2 and patched immutable runtime against a deployed pool',async()=>{
    const marketState=await market(),f=await fixture(marketState.contracts);try{
      const info=await hre.artifacts.getBuildInfo('contracts/LocalSwapFactory.sol:LocalSwapFactory');assert.ok(info);
      // No manually supplied substitute compiler output is accepted by this test.
      const {identity,sha256}=f.m.buildPoolIdentity(info,{sources:sourceMap(info),expectedRuntimeHashes:require('../../src/swap/local-amm-code-identities.json')});
      const r=await f.m.inspectPoolIdentity(new f.m.Rpc(),f.network,identity,sha256,{factory:marketState.factory.target.toLowerCase(),tokenA:marketState.a.target.toLowerCase(),tokenB:marketState.b.target.toLowerCase(),feeBps:1});
      assert.equal(r.pool,marketState.pool.target.toLowerCase());assert.equal(r.poolRuntimeMatched,true);assert.equal(r.executable,false);
    }finally{await f.close();}
  });
  it('uses owner HTTP DEX preparation, a separate finite approval and direct-pool swap with an actual balance delta',async()=>{
    const m=await market(),f=await fixture(m.contracts);try{
      await (await m.a.mint(f.account.address,100000n)).wait();const token=m.a.target.toLowerCase(),pool=m.pool.target.toLowerCase();
      const catalogue=await f.owner('dex/catalog',{chainId:'31337'});assert.equal(catalogue.pools.length,1);
      const quoted=await f.owner('dex/quote',{chainId:'31337',quote:{tokenIn:token,tokenOut:m.b.target.toLowerCase(),amount:ethers.formatUnits(1000n,18),slippageBps:50}});
      assert.equal(quoted.additionalFeesIncluded,false);const candidate=quoted.candidates[0];assert.ok(candidate);
      async function confirmed(operation){
        const count=f.rpc.sent.length,pending=await f.owner('dex/prepare',{accountId:f.account.id,chainId:'31337',operation});
        assert.equal(f.rpc.sent.length,count);assert.equal(pending.automaticApproval,false);
        const result=await f.owner('approve',{id:pending.id,intentId:pending.intentId,confirm:pending.summary.recipient,broadcast:true});
        assert.equal(result.broadcastState,'broadcast');assert.equal(f.rpc.sent.length,count+1);
      }
      await confirmed({action:'approve',token,spender:pool,amount:ethers.formatUnits(1000n,18)});
      const before=await m.b.balanceOf(f.account.address);
      await confirmed({action:'swap',pool,tokenIn:token,amount:ethers.formatUnits(1000n,18),minimumOutput:candidate.minimumOutput,recipient:f.account.address,ttlSeconds:180});
      assert.equal(await m.b.balanceOf(f.account.address)-before,BigInt(candidate.outputAtomic));
      assert.equal(await m.a.allowance(f.account.address,m.pool.target),0n);
    }finally{await f.close();}
  });
  it('signs a finite router approval and a pool swap, checks final balances, and blocks impossible slippage',async()=>{
    const m=await market(),f=await fixture(m.contracts);try{
      await (await m.a.mint(f.account.address,100000n)).wait();const amount=1000n;
      await f.submit(m.a.target,m.a.interface.encodeFunctionData('approve',[m.router.target,amount]));
      const [out]=await m.router.quoteExactIn([m.pool.target],m.a.target,amount),block=await ethers.provider.getBlock('latest');
      const before=await m.b.balanceOf(f.account.address);
      const calldata=m.router.interface.encodeFunctionData('swapExactIn',[[m.pool.target],m.a.target,amount,out,f.account.address,block.timestamp+180]);
      await f.submit(m.router.target,calldata);assert.equal(await m.b.balanceOf(f.account.address)-before,out);assert.equal(await m.a.allowance(f.account.address,m.router.target),0n);
      const count=(await f.vault.journal()).length;
      const bad=m.router.interface.encodeFunctionData('swapExactIn',[[m.pool.target],m.a.target,amount,out*100n,f.account.address,block.timestamp+180]);
      await assert.rejects(f.app.engine.prepare(f.network,f.account,{from:f.account.address,to:m.router.target.toLowerCase(),data:bad,value:'0x0'}));assert.equal((await f.vault.journal()).length,count);
    }finally{await f.close();}
  });
});
