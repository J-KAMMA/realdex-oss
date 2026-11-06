/** Explicit one-hop ICS-20 v1 routes. No URL discovery, hooks, or custody authority. */
import {createHash} from 'node:crypto';
import {need,shape,uint,text,freeze,canonical} from '../lib/guard.mjs';
import {validateCosmosNetwork} from '../non-evm/cosmos-network.mjs';
import {fingerprint} from '../non-evm/solana-codec.mjs';
export const IBC_OPERATION='cosmos-ibc-transfer-online';
export const IBC_ASSURANCE='IBC node-reported settlement; desktop does not verify validator consensus or state roots';
export const IBC_TYPES=Object.freeze({transfer:'/ibc.applications.transfer.v1.MsgTransfer',receive:'/ibc.core.channel.v1.MsgRecvPacket',acknowledge:'/ibc.core.channel.v1.MsgAcknowledgement',timeout:'/ibc.core.channel.v1.MsgTimeout'});
export const traceDenom=(channel,base)=>'ibc/'+createHash('sha256').update(`transfer/${channel}/${base}`).digest('hex').toUpperCase();
export function ibcDenom(d){need(typeof d==='string'&&(/^[a-zA-Z][a-zA-Z0-9]{2,63}$/.test(d)||/^ibc\/[A-F0-9]{64}$/.test(d)),'IBC_DENOM_UNSUPPORTED');return d;}
export function validateIbcRoute(r){
 shape(r,['schema','id','name','source','destination','asset','maxTransferAtomic','minTimeoutSeconds','maxTimeoutSeconds']);
 need(r.schema==='realdex.ibc-route.v1'&&typeof r.id==='string'&&/^ibc-[a-z0-9-]{1,40}$/.test(r.id),'IBC_ROUTE_ID');text(r.name,100);
 const side=v=>{shape(v,['network','channel','connection','client']);const network=validateCosmosNetwork(v.network);need(/^channel-(0|[1-9][0-9]{0,8})$/.test(v.channel)&&/^connection-(0|[1-9][0-9]{0,8})$/.test(v.connection)&&/^07-tendermint-(0|[1-9][0-9]{0,8})$/.test(v.client),'IBC_LANE_INVALID');need(/-([1-9][0-9]{0,8})$/.test(network.chainId),'IBC_REVISION_REQUIRED');return {...v,network};};
 const source=side(r.source),destination=side(r.destination);
 need(source.network.chainId!==destination.network.chainId,'IBC_DISTINCT_CHAINS_REQUIRED');
 need(!source.network.endpoints.some(s=>destination.network.endpoints.some(d=>s.rpcUrl===d.rpcUrl||s.restUrl===d.restUrl)),'IBC_SHARED_CHAIN_ENDPOINT');
 shape(r.asset,['baseDenom','originChainId','decimals','symbol']);ibcDenom(r.asset.baseDenom);need(!r.asset.baseDenom.startsWith('ibc/'),'IBC_NATIVE_ORIGIN_REQUIRED');
 const origin=[source,destination].find(s=>s.network.chainId===r.asset.originChainId);need(origin&&origin.network.denom===r.asset.baseDenom&&r.asset.decimals===origin.network.decimals,'IBC_ASSET_ORIGIN_MISMATCH');text(r.asset.symbol,16);
 const cap=uint(r.maxTransferAtomic,(1n<<128n)-1n);need(cap>0n&&cap<=uint(source.network.maxTransferAtomic),'IBC_AMOUNT_CAP');
 need(Number.isInteger(r.minTimeoutSeconds)&&Number.isInteger(r.maxTimeoutSeconds)&&r.minTimeoutSeconds>=30&&r.maxTimeoutSeconds<=3600&&r.maxTimeoutSeconds>=r.minTimeoutSeconds,'IBC_TIMEOUT_POLICY');
 return freeze({...r,source,destination,maxTransferAtomic:String(cap)});
}
export const ibcRouteFingerprint=r=>fingerprint(validateIbcRoute(r));
export function routeAssets(route){const r=validateIbcRoute(route),out=r.asset.originChainId===r.source.network.chainId;return {mode:out?'escrow-to-voucher':'voucher-to-origin',sourceDenom:out?r.asset.baseDenom:traceDenom(r.source.channel,r.asset.baseDenom),destinationDenom:out?traceDenom(r.destination.channel,r.asset.baseDenom):r.asset.baseDenom,packetDenom:out?r.asset.baseDenom:`transfer/${r.source.channel}/${r.asset.baseDenom}`};}
export const routeConfirmation=r=>`ADD IBC ${ibcRouteFingerprint(r)}`;
export function validateIbcRoutes(routes){need(Array.isArray(routes)&&routes.length<=16,'IBC_ROUTE_LIMIT');const rs=routes.map(validateIbcRoute);need(new Set(rs.map(r=>r.id)).size===rs.length,'IBC_DUPLICATE_ROUTE');const networks=new Map();for(const r of rs)for(const s of [r.source,r.destination]){const key=s.network.id,v=canonical(s.network);need(!networks.has(key)||networks.get(key)===v,'IBC_NETWORK_CONFIG_CONFLICT');networks.set(key,v);}return rs;}
