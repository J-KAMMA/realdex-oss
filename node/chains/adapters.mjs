import {check,object,text,uint,hexUint,toHex,safeNumber,hashHex,hash58,hash64,hash32,base58Bytes,millis,isoMillis,canonical} from './core.mjs';
import {createTransport,SUI_HEAD_QUERY,SUI_BLOCK_QUERY} from './transport.mjs';
import {validateProfile} from './registry.mjs';
const height=x=>String(uint(x)), identity=(network,genesisHash=null,extra=null)=>({network,genesisHash,extra});
const block=(h,hash,time,reportedFinality,extra=null)=>({height:height(h),hash,timestampMs:time,reportedFinality,extra});
const hexWord=x=>{check(typeof x==='string'&&/^0x[0-9a-fA-F]{1,64}$/.test(x),'HEX_UINT_INVALID');return BigInt(x);};
const hashFelt=x=>{const n=hexWord(x);check(n<(1n<<251n)+17n*(1n<<192n)+1n,'FELT_INVALID');return '0x'+n.toString(16);};
const tezosHash=x=>{text(x,60);check(/^B[1-9A-HJ-NP-Za-km-z]{50}$/.test(x),'HASH_INVALID');base58Bytes(x,38);return x;};
function unwrapTon(x){object(x);check(x.ok===true&&x.result,'TON_REMOTE_ERROR');return object(x.result);}
function tonId(x){object(x);check(x.workchain===-1&&x.shard==='-9223372036854775808','TON_MASTERCHAIN_REQUIRED');return {workchain:-1,shard:x.shard,seqno:safeNumber(x.seqno),root_hash:hash64(x.root_hash),file_hash:hash64(x.file_hash)};}
function parseEvm(b){object(b,'BLOCK_MISSING');return block(hexUint(b.number),hashHex(b.hash),millis(hexUint(b.timestamp),'seconds'),'confirmation-depth-not-consensus');}
function parseCosmos(b){object(b,'BLOCK_MISSING');const h=object(b.block?.header,'BLOCK_INVALID');return block(h.height,hashHex(b.block_id?.hash,false),isoMillis(h.time),'rpc-reported-committed',{network:text(h.chain_id)});}
function parseAptos(b){object(b,'BLOCK_MISSING');return block(b.block_height,hashHex(b.block_hash),millis(b.block_timestamp,'us'),'rpc-reported-committed');}
function parseSui(b){object(b,'BLOCK_MISSING');return block(b.sequenceNumber,hash58(b.digest),isoMillis(b.timestamp),'rpc-reported-checkpoint');}
function parseNear(b){object(b,'BLOCK_MISSING');const h=object(b.header,'BLOCK_INVALID');return block(h.height,hash58(h.hash),millis(h.timestamp_nanosec??h.timestamp,'ns'),'rpc-reported-final');}
function parseBitcoin(b){object(b);check(typeof b.confirmations==='number'&&Number.isSafeInteger(b.confirmations)&&b.confirmations>=1,'BITCOIN_ORPHAN_BLOCK');return block(b.height,hashHex(b.hash,false),millis(b.time,'seconds'),'proof-of-work-depth-not-verified');}
function parseStellar(b){object(b,'BLOCK_MISSING');return block(b.sequence,hashHex(b.hash,false),isoMillis(b.closed_at),'rpc-reported-closed-ledger');}
function parseXrpl(r){check(r.validated===true,'XRPL_VALIDATED_LEDGER_REQUIRED');const b=object(r.ledger,'BLOCK_MISSING');check(b.closed===true,'XRPL_LEDGER_NOT_CLOSED');
 const h=uint(b.ledger_index);if(r.ledger_index!==undefined)check(h===uint(r.ledger_index),'HEIGHT_MISMATCH');
 const hash=hashHex(b.ledger_hash,false);if(r.ledger_hash!==undefined)check(hash===hashHex(r.ledger_hash,false),'HASH_MISMATCH');
 return block(h,hash,millis(uint(b.close_time)+946684800n,'seconds'),'rpc-reported-validated-ledger');}
function parseTron(b){object(b,'BLOCK_MISSING');const h=object(b.block_header?.raw_data,'BLOCK_INVALID');
 // Proto3 omits an all-zero genesis height; non-genesis must carry it.
 const n=h.number===undefined?0n:uint(h.number),id=hashHex(b.blockID,false);check(BigInt('0x'+id.slice(0,16))===n,'TRON_BLOCK_ID_HEIGHT_MISMATCH');
 return block(n,id,h.timestamp===undefined&&n===0n?null:millis(h.timestamp),'rpc-reported-solidified');}
function parseStarknet(b){object(b,'BLOCK_MISSING');check(['ACCEPTED_ON_L1','ACCEPTED_ON_L2'].includes(b.status),'STARKNET_ACCEPTED_BLOCK_REQUIRED');return block(b.block_number,hashFelt(b.block_hash),millis(b.timestamp,'seconds'),b.status==='ACCEPTED_ON_L1'?'rpc-reported-l1-accepted':'rpc-reported-l2-accepted');}
/** Native read adapters. All results are claims by RPCs, not light-client proofs.
 * Height addressing and finality vocabularies are deliberately family-specific. */
export function createChainReader(profile,endpoint,options={}) {
 const p=validateProfile(profile),io=createTransport(p.family,endpoint,options);let impl;
 switch(p.family){
 case 'evm': impl={
  async identity(){const [id,b]=await Promise.all([io.rpc('eth_chainId'),io.rpc('eth_getBlockByNumber',['0x0',false])]);object(b,'GENESIS_MISSING');check(hexUint(b.number)===0n,'GENESIS_INVALID');return identity(String(hexUint(id)),hashHex(b.hash));},
  async tip(){return parseEvm(await io.rpc('eth_getBlockByNumber',['latest',false]));},
  async at(h){return parseEvm(await io.rpc('eth_getBlockByNumber',[toHex(h),false]));}
 };break;
 case 'solana': impl={
  async identity(){return identity(null,hash58(await io.rpc('getGenesisHash')));},
  async tip(){return {height:height(await io.rpc('getSlot',[{commitment:'finalized'}]))};},
  async at(h){const b=await io.rpc('getBlock',[safeNumber(h),{commitment:'finalized',transactionDetails:'none',rewards:false,maxSupportedTransactionVersion:0}]);
   object(b,'SOLANA_SKIPPED_OR_PRUNED_SLOT');return block(h,hash58(b.blockhash),b.blockTime===null?null:millis(b.blockTime,'seconds'),'rpc-reported-finalized');}
 };break;
 case 'cosmos': impl={
  async identity(){const r=object(await io.rpc('status'));check(r.sync_info?.catching_up===false,'RPC_SYNCING');return identity(text(r.node_info?.network));},
  async tip(){const r=object(await io.rpc('status'));check(r.sync_info?.catching_up===false,'RPC_SYNCING');return {height:height(r.sync_info.latest_block_height)};},
  async at(h){return parseCosmos(await io.rpc('block',{height:height(h)}));}
 };break;
 case 'aptos': impl={
  async identity(){const r=object(await io.get(''));return identity(height(r.chain_id));},
  async tip(){const r=object(await io.get(''));return {height:height(r.block_height)};},
  async at(h){return parseAptos(await io.get('/blocks/by_height/'+height(h),{with_transactions:'false'}));}
 };break;
 case 'sui': impl={
  async identity(){const r=await io.graphql(SUI_HEAD_QUERY),id=text(r.chainIdentifier);
   if(/^[0-9a-f]{8}$/.test(id))return identity(id);
   const bytes=base58Bytes(id),short=Array.from(bytes.slice(0,4),v=>v.toString(16).padStart(2,'0')).join('');return identity(short,id);},
  async tip(){return parseSui((await io.graphql(SUI_HEAD_QUERY)).checkpoint);},
  async at(h){return parseSui((await io.graphql(SUI_BLOCK_QUERY,{height:safeNumber(h)})).checkpoint);}
 };break;
 case 'near': impl={
  async identity(){const s=object(await io.rpc('status',[]));check(s.sync_info?.syncing===false,'RPC_SYNCING');return identity(text(s.chain_id));},
  async tip(){return parseNear(await io.rpc('block',{finality:'final'}));},
  async at(h){return parseNear(await io.rpc('block',{block_id:safeNumber(h)}));}
 };break;
 case 'bitcoin': impl={
  async identity(){const [i,g]=await Promise.all([io.rpc('getblockchaininfo'),io.rpc('getblockhash',[0])]);check(i.initialblockdownload===false,'RPC_SYNCING');return identity(text(i.chain),hashHex(g,false));},
  async tip(){const i=object(await io.rpc('getblockchaininfo'));check(i.initialblockdownload===false,'RPC_SYNCING');return {height:height(i.blocks)};},
  async at(h){const hash=hashHex(await io.rpc('getblockhash',[safeNumber(h)]),false),b=parseBitcoin(await io.rpc('getblockheader',[hash,true]));check(b.hash===hash,'HASH_MISMATCH');return b;}
 };break;
 case 'stellar': impl={
  async identity(){const r=object(await io.get(''));return identity(text(r.network_passphrase));},
  async tip(){return {height:height((await io.get('')).history_latest_ledger)};},
  async at(h){return parseStellar(await io.get('/ledgers/'+height(h)));}
 };break;
 case 'xrpl': impl={
  async identity(){const r=object(await io.rpc('server_info',[{}]));const i=object(r.info);check(['full','validating','proposing'].includes(i.server_state),'RPC_SYNCING');return identity(height(i.network_id));},
  async tip(){return parseXrpl(await io.rpc('ledger',[{ledger_index:'validated',transactions:false,expand:false}]));},
  async at(h){return parseXrpl(await io.rpc('ledger',[{ledger_index:safeNumber(h),transactions:false,expand:false}]));}
 };break;
 case 'substrate': {
  const read=async hash=>{hashHex(hash);const b=object(await io.rpc('chain_getHeader',[hash]),'BLOCK_MISSING');return block(hexWord(b.number),hashHex(hash),null,'rpc-reported-finalized-ancestor',{stateRoot:hashHex(b.stateRoot),extrinsicsRoot:hashHex(b.extrinsicsRoot)});};
  impl={async identity(){return identity(null,hashHex(await io.rpc('chain_getBlockHash',[0])));},
   async tip(){return read(await io.rpc('chain_getFinalizedHead'));},
   async at(h){return read(await io.rpc('chain_getBlockHash',[safeNumber(h)]));}};break;
 }
 case 'algorand': impl={
  async identity(){const r=object(await io.get('/versions'));return identity(text(r.genesis_id),hash64(r.genesis_hash_b64));},
  async tip(){const s=object(await io.get('/v2/status'));check(uint(s['catchup-time']??0)===0n,'RPC_SYNCING');return {height:height(s['last-round'])};},
  async at(h){const [r,x]=await Promise.all([io.get('/v2/blocks/'+height(h),{format:'json'}),io.get('/v2/blocks/'+height(h)+'/hash')]);const b=object(r.block,'BLOCK_MISSING');
   return block(b.rnd,hash32(x.blockHash),millis(b.ts,'seconds'),'rpc-reported-certified',{network:text(b.gen),genesisHash:hash64(b.gh)});}
 };break;
 case 'starknet': impl={
  async identity(){const hex=hexWord(await io.rpc('starknet_chainId')).toString(16);check(hex.length%2===0&&hex.length<=64,'CHAIN_ID_INVALID');
   const s=String.fromCharCode(...hex.match(/../g).map(x=>parseInt(x,16)));check(/^[A-Z0-9_]+$/.test(s),'CHAIN_ID_INVALID');return identity(s);},
  async tip(){return parseStarknet(await io.rpc('starknet_getBlockWithTxHashes',['latest']));},
  async at(h){return parseStarknet(await io.rpc('starknet_getBlockWithTxHashes',[{block_number:safeNumber(h)}]));}
 };break;
 case 'tezos': {
  const read=async at=>{const base='/chains/main/blocks/'+at;const [header,hash]=await Promise.all([io.get(base+'/header'),io.get(base+'/hash')]);
   return block(header.level,tezosHash(hash),isoMillis(header.timestamp),'rpc-head-depth-not-consensus');};
  impl={async identity(){const id=await io.get('/chains/main/chain_id');check(typeof id==='string'&&/^Net[1-9A-HJ-NP-Za-km-z]{12}$/.test(id),'CHAIN_ID_INVALID');return identity(id);},
   async tip(){return read('head');},async at(h){return read(height(h));}};break;
 }
 case 'tron': impl={
  async identity(){const b=parseTron(await io.post('/walletsolidity/getblockbynum',{num:0}));check(b.height==='0','GENESIS_INVALID');return identity(null,b.hash);},
  async tip(){return parseTron(await io.get('/walletsolidity/getnowblock'));},
  async at(h){return parseTron(await io.post('/walletsolidity/getblockbynum',{num:safeNumber(h)}));}
 };break;
 case 'ton':{
  const header=async id=>{const wanted=tonId(id),r=unwrapTon(await io.get('/getBlockHeader',wanted)),got=tonId(r.id);check(canonical(wanted)===canonical(got),'TON_BLOCK_ID_MISMATCH');
   check(Number.isSafeInteger(r.global_id),'CHAIN_ID_INVALID');return block(got.seqno,got.root_hash+':'+got.file_hash,millis(r.gen_utime,'seconds'),'rpc-reported-masterchain',{globalId:String(r.global_id)});};
  impl={async identity(){const r=unwrapTon(await io.get('/getMasterchainInfo'));const init=object(r.init);check(init.workchain===-1,'TON_MASTERCHAIN_REQUIRED');return identity(null,hash64(init.root_hash),{fileHash:hash64(init.file_hash)});},
   async tip(){return header(unwrapTon(await io.get('/getMasterchainInfo')).last);},
   async at(h){const id=unwrapTon(await io.get('/lookupBlock',{workchain:-1,shard:'-9223372036854775808',seqno:safeNumber(h)}));return header(id);}};break;
 }
 default:throw new Error('FAMILY_UNSUPPORTED');
 }
 return Object.freeze({family:p.family,origin:io.origin,identity:impl.identity,tip:impl.tip,at:async h=>{
  const requested=height(h),b=await impl.at(requested);check(b.height===requested,'HEIGHT_MISMATCH');return b;
 }});
}
