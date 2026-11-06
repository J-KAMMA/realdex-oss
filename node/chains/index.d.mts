export type ChainFamily = 'evm'|'solana'|'cosmos'|'aptos'|'sui'|'near'|'bitcoin'|'stellar'|'xrpl'|'substrate'|'algorand'|'starknet'|'tezos'|'tron'|'ton';
export interface ChainProfile {
 readonly id:string;readonly name:string;readonly family:ChainFamily;readonly environment:'mainnet'|'testnet'|'local'|'unknown';
 readonly rpcIdentity:string|null;readonly genesisHash:string|null;readonly nativeSymbol:string|null;readonly nativeDecimals:number|null;
 readonly source:string|null;readonly toolchain:'solidity-compatibility-unverified'|'special-review'|'native-adapter-required';
 readonly status:'candidate-unverified'|'deprecated';
}
export interface Capabilities {
 readonly family:ChainFamily;readonly discovery:'candidate-metadata';readonly readAdapter:'implemented-fixture-tested';
 readonly identityPinRequired:boolean;readonly identityPinConfigured:boolean;readonly genericEvmRead:boolean;
 readonly existingVerifiedLabCompatible:boolean;readonly evmDeploymentPlan:boolean;readonly nativePoolContract:string;
 readonly liveNetworkTested:false;readonly poolDeploymentVerified:false;readonly swapsExecutable:false;readonly bridgesExecutable:false;readonly walletSigning:false;
}
export interface Registry {readonly size:number;list():ChainProfile[];get(id:string):ChainProfile;}
export interface Catalogue {readonly schema:'realdex.chain-candidates.v1';readonly profiles:readonly ChainProfile[];}
export interface Identity {readonly network:string|null;readonly genesisHash:string|null;readonly extra:Record<string,string>|null;}
export interface BlockObservation {readonly height:string;readonly hash:string;readonly timestampMs:number|null;readonly reportedFinality:string;readonly extra:Record<string,string>|null;}
export interface ChainReader {readonly family:ChainFamily;readonly origin:string;identity():Promise<Identity>;tip():Promise<{height:string}>;at(height:string|number|bigint):Promise<BlockObservation>;}
export interface TransportOptions {fetchImpl?:typeof fetch;signal?:AbortSignal;timeoutMs?:number;maxBytes?:number;headers?:Record<string,string>;}
export interface ReadPolicy {maxHeadGap?:number;ttlMs?:number;maxAgeMs?:number;confirmationDepth?:number;totalTimeoutMs?:number;}
export interface ChainProbeRequest {profile:ChainProfile;endpoints:(string|{url:string;headers?:Record<string,string>})[];genesisPin?:string;policy?:ReadPolicy;}
export interface ProbeOptions extends ChainProbeRequest {fetchImpl?:typeof fetch;signal?:AbortSignal;now?:()=>number;}
export interface Observation {
 readonly schema:'realdex.multichain-observation.v1';readonly chainId:string;readonly family:ChainFamily;readonly identity:Identity;readonly anchor:BlockObservation;
 readonly rpcOrigins:readonly string[];readonly heads:readonly string[];readonly confirmationDepth:number;readonly observedAt:number;readonly expiresAt:number;
 readonly assurance:{readonly rpcAgreement:true;readonly genesisPinned:boolean;readonly freshnessEstablished:boolean;readonly independentOperatorsVerified:false;readonly blockExecutionVerified:false;readonly consensusProofVerified:false;};
 readonly executable:false;readonly walletSigning:false;readonly notes:readonly string[];
}
export const FAMILIES:readonly ChainFamily[];
export function validateProfile(raw:unknown):ChainProfile;
export function makeRegistry(raw:unknown):Registry;
export function capabilities(profile:ChainProfile):Capabilities;
export function customEvmProfile(chainId:string|bigint|number,options?:{name?:string;environment?:ChainProfile['environment']}):ChainProfile;
export function importEvmCatalogue(entries:unknown[],options?:{source?:string}):Catalogue & {readonly rejected:readonly {index:number;code:string}[];readonly automaticRpcSelection:false;readonly executable:false};
export function createChainReader(profile:ChainProfile,endpoint:string,options?:TransportOptions):ChainReader;
export function observeChain(options:ProbeOptions):Promise<Observation>;
export function observeMany(jobs:ChainProbeRequest[],options?:{concurrency?:number;signal?:AbortSignal;fetchImpl?:typeof fetch;now?:()=>number}):Promise<readonly ({ok:true;result:Observation}|{ok:false;chainId:string|null;code:string})[]>;
export function normalizeAsset(profile:ChainProfile,asset:{kind:string;reference?:string;tokenId?:string|number|bigint}):{readonly chainId:string;readonly kind:string;readonly reference:string|null;readonly tokenId:string|null;readonly key:string;readonly executable:false};
