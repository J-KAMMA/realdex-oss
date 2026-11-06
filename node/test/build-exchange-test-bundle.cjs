/* Offline DOM TEST ONLY. Not served by the node. Uses installed TypeScript to
 * package the actual modules for an about:blank test harness (no dependency npm install).
 * The test loader permits an explicitly synthetic LOCAL Factory policy. Production
 * exchange.mjs, CLI and browser-served modules never contain this override. */
const fs=require('fs'),path=require('path');
const ts=(()=>{if(process.env.TYPESCRIPT_LIBRARY)return require(process.env.TYPESCRIPT_LIBRARY);try{return require('typescript');}catch{return require(path.resolve(path.dirname(process.execPath),'../lib/node_modules/typescript'));}})();
const base=path.resolve(__dirname,'..');
const files={
 '/node/shared/protocol-core.mjs':'shared/protocol-core.mjs',
 '/node/verified/keccak.mjs':'verified/keccak.mjs','/node/verified/catalogue.mjs':'verified/catalogue.mjs',
 '/node/verified/rpc.mjs':'verified/rpc.mjs','/node/verified/evm.mjs':'verified/evm.mjs',
 '/node/optimizer/quote-objective.mjs':'optimizer/quote-objective.mjs','/node/optimizer/discrete-split.mjs':'optimizer/discrete-split.mjs',
 '/node/exchange.mjs':'public/exchange.mjs','/node/test/verified-fixtures.mjs':'test/verified-fixtures.mjs'
};
let script='(()=>{const modules=Object.create(null),cache=Object.create(null);\n';
for(const [id,file] of Object.entries(files)) {
 let text=fs.readFileSync(path.join(base,file),'utf8');
 // about:blank has an opaque origin. Only the offline TEST copy uses this explicit origin.
 if(file==='public/exchange.mjs')text=text.replaceAll('location.origin',"'http://127.0.0.1:8787'");
 const out=ts.transpileModule(text,{fileName:file.replace(/\.mjs$/,'.ts'),compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 script+=`modules[${JSON.stringify(id)}]=(module,exports,require)=>{\n${out}\n};\n`;
}
script+=`function load(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,s=>load(new URL(s,'https://offline.invalid'+id).pathname));return m.exports;}
 const fixtureModule=load('/node/test/verified-fixtures.mjs');
 const evm=load('/node/verified/evm.mjs'),originalObserve=evm.observeLocalPools;
 evm.observeLocalPools=(s,c,r)=>window.__useSyntheticPolicy ? originalObserve(s,c,r,fixtureModule.TEST_POLICY) : originalObserve(s,c,r);
 window.__fixture=fixtureModule.rpcFixture({allowance:1000000n,hook: x=>{
   if(window.__forceDisagreement && x.index===1 && x.method==='eth_getCode')return '0x00';
   if(window.__approvalMissing && fixtureModule.isCall(x.params,'allowance(address,address)'))return '0x'+'0'.repeat(64);
   return x.value;
 }});
 window.fetch=async(url,opt={})=>{
  opt.signal?.throwIfAborted();
  if(window.__delayReads)await new Promise(resolve=>setTimeout(resolve,600));opt.signal?.throwIfAborted();
  const parsed=new URL(url),payload=opt.body?JSON.parse(opt.body):null;
  let result;
  if(parsed.pathname==='/v1/catalogue'){
    result=await window.__signedSnapshot(parsed.searchParams.get('nonce'),window.__clock);
    if(window.__forgeSignature)result.signature='0'.repeat(128);
  }else{
    if(!['8545','8546'].includes(parsed.port))throw new Error('TEST_ENDPOINT_NOT_CONFIGURED');
    window.__requests.push(payload.method);
    result={jsonrpc:'2.0',id:payload.id,result:await window.__fixture.readers[parsed.port==='8545'?0:1].send(payload.method,payload.params)};
  }
  opt.signal?.throwIfAborted();return new Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
 };
 load('/node/exchange.mjs');
})();`;
process.stdout.write(script);
