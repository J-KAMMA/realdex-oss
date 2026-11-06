/** Local compiler-artifact identity checks. Never accepts an identity supplied by a peer. */
import {need, shape, canonical, clone, hex, q} from './guard.mjs';
import {sha256} from './keys.mjs';
import {keccak256, address, selector} from '../../node/verified/keccak.mjs';
import {deriveLocalPoolAddress} from '../../node/verified/create2.mjs';
import {abiWord, abiAddress} from './transactions.mjs';
const PATHS = Object.freeze({factory:'contracts/LocalSwapFactory.sol',pool:'contracts/LocalSwapPool.sol',router:'contracts/LocalSwapRouter.sol'});
const FIELDS = ['factory','token0','token1','feeBasisPoints'];
const digest = value => sha256(Buffer.from(canonical(value))).toString('hex');
function code(value,maximum=24576) {need(typeof value==='string'&&/^(?:[0-9a-fA-F]{2})+$/.test(value)&&value.length/2<=maximum,'COMPILED_CODE_INVALID');return '0x'+value.toLowerCase();}
function ranges(references,template) {
  shape(references,FIELDS);const occupied=new Set();
  for(const field of FIELDS){need(Array.isArray(references[field])&&references[field].length>=1&&references[field].length<=128,'IMMUTABLE_REFERENCES_INVALID');
    for(const range of references[field]){shape(range,['start','length']);need(Number.isSafeInteger(range.start)&&range.start>=0&&range.length===32&&(range.start+32)*2<=template.length-2,'IMMUTABLE_RANGE_INVALID');
      need(template.slice(2+range.start*2,2+(range.start+32)*2)==='0'.repeat(64),'IMMUTABLE_PLACEHOLDER_NOT_ZERO');
      for(let i=range.start;i<range.start+32;i++){need(!occupied.has(i),'IMMUTABLE_RANGES_OVERLAP');occupied.add(i);}
    }
  }
}
/** Requires exact source bytes and a caller-owned runtime anchor. This does not execute solc. */
export function buildPoolIdentity(info,{sources,expectedRuntimeHashes}) {
  need(info&&info.input&&info.output&&info.solcLongVersion==='0.8.24+commit.e11b9ed9','SOLC_BUILD_VERSION_MISMATCH');
  need(info.input.language==='Solidity'&&info.input.settings?.optimizer?.enabled===true&&info.input.settings.optimizer.runs===500,'SOLC_BUILD_SETTINGS_MISMATCH');
  need(info.input.settings.viaIR!==true,'SOLC_VIA_IR_NOT_REVIEWED');
  need(!(info.output.errors??[]).some(e=>e.severity==='error'),'SOLC_BUILD_CONTAINS_ERRORS');
  const sourceHashes={};need(info.input.sources&&Object.keys(info.input.sources).length<=128,'SOLC_SOURCE_LIMIT');
  for(const [name,entry] of Object.entries(info.input.sources)){
    need(typeof entry.content==='string'&&typeof sources[name]==='string'&&entry.content===sources[name],'SOLC_SOURCE_BYTES_MISMATCH');
    sourceHashes[name]=sha256(Buffer.from(entry.content)).toString('hex');
  }
  need(Object.values(PATHS).every(p=>Object.hasOwn(sourceHashes,p)),'SOLC_REQUIRED_SOURCE_MISSING');
  const contract=(kind,name)=>{const c=info.output.contracts?.[PATHS[kind]]?.[name];need(c?.evm?.bytecode&&c?.evm?.deployedBytecode,'SOLC_ARTIFACT_MISSING');
    for(const b of [c.evm.bytecode,c.evm.deployedBytecode])need(!Object.keys(b.linkReferences??{}).length,'SOLC_LINKED_LIBRARY_UNSUPPORTED');return c.evm;};
  const f=contract('factory','LocalSwapFactory'),p=contract('pool','LocalSwapPool'),r=contract('router','LocalSwapRouter');
  const factoryRuntime=code(f.deployedBytecode.object),routerRuntime=code(r.deployedBytecode.object),poolCreationCode=code(p.bytecode.object,49152-96),poolRuntimeTemplate=code(p.deployedBytecode.object);
  need(keccak256(factoryRuntime)===expectedRuntimeHashes.factoryRuntimeCodeHash&&keccak256(routerRuntime)===expectedRuntimeHashes.routerRuntimeCodeHash,'LOCAL_RUNTIME_ANCHOR_MISMATCH');
  const embeddedAt=factoryRuntime.slice(2).indexOf(poolCreationCode.slice(2));
  need(embeddedAt>=0&&embeddedAt%2===0,'FACTORY_DOES_NOT_EMBED_POOL_CREATION_CODE');
  need(!Object.keys(f.deployedBytecode.immutableReferences??{}).length&&!Object.keys(r.deployedBytecode.immutableReferences??{}).length,'UNEXPECTED_NONPOOL_IMMUTABLES');
  const definition=info.output.sources?.[PATHS.pool]?.ast?.nodes?.find(n=>n.nodeType==='ContractDefinition'&&n.name==='LocalSwapPool');
  need(definition,'POOL_AST_MISSING');const declarations=definition.nodes.filter(n=>n.nodeType==='VariableDeclaration'&&n.mutability==='immutable');
  need(declarations.length===4&&new Set(declarations.map(n=>n.name)).size===4&&declarations.every(n=>FIELDS.includes(n.name)&&Number.isSafeInteger(n.id)),'POOL_IMMUTABLE_DECLARATIONS_INVALID');
  const byId=p.deployedBytecode.immutableReferences;need(byId&&Object.keys(byId).length===4,'POOL_IMMUTABLE_METADATA_MISSING');const immutableReferences={};
  for(const decl of declarations){need(Object.hasOwn(byId,String(decl.id)),'IMMUTABLE_ID_MISMATCH');immutableReferences[decl.name]=clone(byId[String(decl.id)]);}
  ranges(immutableReferences,poolRuntimeTemplate);
  const identity={schema:'realdex.local-pool-identity.v1',compiler:info.solcLongVersion,settingsDigest:digest(info.input.settings),sourceHashes,
    factoryRuntimeCodeHash:keccak256(factoryRuntime),routerRuntimeCodeHash:keccak256(routerRuntime),poolCreationCode,poolRuntimeTemplate,immutableReferences,
    buildReproducedHere:false,warning:'Local artifact consistency only. Reproduce with a trusted compiler before trusting this identity.'};
  return {identity,sha256:digest(identity)};
}
export function validatePoolIdentity(identity,expectedDigest){
  shape(identity,['schema','compiler','settingsDigest','sourceHashes','factoryRuntimeCodeHash','routerRuntimeCodeHash','poolCreationCode','poolRuntimeTemplate','immutableReferences','buildReproducedHere','warning']);
  need(typeof expectedDigest==='string'&&/^[0-9a-f]{64}$/.test(expectedDigest)&&digest(identity)===expectedDigest,'IDENTITY_DIGEST_MISMATCH');
  need(identity.schema==='realdex.local-pool-identity.v1'&&identity.compiler==='0.8.24+commit.e11b9ed9'&&identity.buildReproducedHere===false,'IDENTITY_SCHEMA_INVALID');
  hex(identity.factoryRuntimeCodeHash,32);hex(identity.routerRuntimeCodeHash,32);code(identity.poolCreationCode.slice(2),49152-96);code(identity.poolRuntimeTemplate.slice(2));
  need(identity.poolCreationCode.startsWith('0x')&&identity.poolRuntimeTemplate.startsWith('0x'),'IDENTITY_CODE_INVALID');
  ranges(identity.immutableReferences,identity.poolRuntimeTemplate);return clone(identity);
}
export function instantiatePoolIdentity(identity,expectedDigest,{chainId,factory,tokenA,tokenB,feeBps}) {
  const local=validatePoolIdentity(identity,expectedDigest);
  const derived=deriveLocalPoolAddress({chainId:'eip155:'+chainId,factory,tokenA,tokenB,feeBps,poolCreationCode:local.poolCreationCode});
  const values={factory:abiAddress(derived.factory),token0:abiAddress(derived.token0),token1:abiAddress(derived.token1),feeBasisPoints:abiWord(feeBps)};
  const bytes=Buffer.from(local.poolRuntimeTemplate.slice(2),'hex');
  for(const field of FIELDS)for(const {start} of local.immutableReferences[field])Buffer.from(values[field],'hex').copy(bytes,start);
  return {...derived,expectedRuntime:'0x'+bytes.toString('hex'),runtimeHash:keccak256(bytes),identityDigest:expectedDigest};
}
/** Existing network/genesis and EIP-1898 anchoring apply. No wallet or signing capability. */
export async function inspectPoolIdentity(rpc,network,identity,expectedDigest,request,now=Date.now()) {
  shape(request,['factory','tokenA','tokenB','feeBps']);
  const expected=instantiatePoolIdentity(identity,expectedDigest,{...request,chainId:network.chainId});
  const snapshot=await rpc.snapshot(network,now),ref=snapshot.ref;
  const runtime=await rpc.agree(network,'eth_getCode',[expected.factory,ref]);
  need(keccak256(runtime)===identity.factoryRuntimeCodeHash,'FACTORY_RUNTIME_IDENTITY_MISMATCH');
  const getPool=(a,b)=>rpc.agree(network,'eth_call',[{to:expected.factory,data:selector('getPool(address,address,uint256)')+abiAddress(a)+abiAddress(b)+abiWord(request.feeBps)},ref]);
  const [forward,reverse,poolCode]=await Promise.all([getPool(expected.token0,expected.token1),getPool(expected.token1,expected.token0),rpc.agree(network,'eth_getCode',[expected.expectedPool,ref])]);
  need(forward==='0x'+abiAddress(expected.expectedPool)&&reverse===forward,'FACTORY_POOL_MAPPING_MISMATCH');
  need(typeof poolCode==='string'&&poolCode.toLowerCase()===expected.expectedRuntime,'POOL_RUNTIME_IDENTITY_MISMATCH');
  for(const [name,value] of Object.entries({factory:abiAddress(expected.factory),token0:abiAddress(expected.token0),token1:abiAddress(expected.token1),feeBasisPoints:abiWord(request.feeBps)})){
    const observed=await rpc.agree(network,'eth_call',[{to:expected.expectedPool,data:selector(name+'()')},ref]);need(observed==='0x'+value,'POOL_IMMUTABLE_GETTER_MISMATCH');
  }
  const end=await rpc.agree(network,'eth_getBlockByNumber',[snapshot.number,false]);need(end&&end.hash===snapshot.hash&&q(end.number)===q(snapshot.number),'IDENTITY_BLOCK_CHANGED');
  return {schema:'realdex.pool-identity-observation.v1',chainId:network.chainId,genesisHash:network.genesisHash,blockHash:snapshot.hash,
    blockNumber:snapshot.number,factory:expected.factory,pool:expected.expectedPool,token0:expected.token0,token1:expected.token1,feeBps:request.feeBps,
    runtimeHash:expected.runtimeHash,identityDigest:expectedDigest,create2AddressMatched:true,poolRuntimeMatched:true,factoryMappingMatched:true,
    compilerReproducedHere:false,historicalCreationProven:false,tokenTransferBehaviorVerified:false,consensusVerified:false,executable:false};
}
