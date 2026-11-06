export type UInt = string | bigint | number;
export type AccessPolicy = {mode?:'local-only';allowedOrigins?:readonly []}|{mode:'explicit-remote';allowedOrigins:readonly string[]};
export type RpcEndpoint = string | {url:string;headers?:Record<'authorization'|'x-api-key',string>|Record<string,string>};
export type ReaderOptions = {endpoints:readonly RpcEndpoint[];access?:AccessPolicy;signal?:AbortSignal;fetchImpl?:typeof fetch;now?:()=>number};
export type Family = 'icp'|'monero'|'utxo-core'|'cometbft'|'evm';
export type PrivacyModel = 'public'|'optional-shielded'|'shielded'|'confidential-contracts'|'permissioned-not-confidential';
export interface Profile {readonly id:string;readonly name:string;readonly family:Family;readonly environment:'mainnet'|'testnet'|'local';readonly networkIdentity:string;readonly nativeSymbol:string;readonly nativeDecimals:number;readonly privacyModel:PrivacyModel;readonly restricted:boolean;readonly genesisHash:string|null;readonly source:string;readonly status:'candidate-unverified';}
export interface Registry {readonly size:number;list():Profile[];get(id:string):Profile;}
export interface Capabilities {readProtocol:string;defaultAccess:'literal-loopback-only';remoteRequiresOriginConsent:true;privacyModel:PrivacyModel;permissioned:boolean;peerDiscoveryForPrivateNetworks:false;viewingKeyAccess:false;spendingKeyAccess:false;shieldedWalletScan:false;privacyProofsVerified:false;poolContractImplemented:false;swapsExecutable:false;bridgesExecutable:false;liveNetworkTested:false;}
export const EXTENDED_FAMILIES:readonly Family[];
export function validateExtendedProfile(raw:unknown):Profile;
export function extendedRegistry(raw:unknown):Registry;
export function extendedCapabilities(profile:Profile):Readonly<Capabilities>;
export function privateEvmProfile(input:{slug:string;chainId:UInt;genesisHash:string;name?:string}):Profile;
export function privateCometProfile(input:{slug:string;chainId:string;checkpointHash:string;name?:string}):Profile;
export function accessPolicy(raw?:AccessPolicy):Readonly<AccessPolicy>;
export function guardedEndpoint(url:string,access?:AccessPolicy):URL;
export function extensionError(error:unknown):string;
export interface Observation {readonly schema:'realdex.extended-observation.v1';readonly networkId:string;readonly protocol:Family;readonly scope:'ledger-canister'|'chain';readonly identity:{network:string;genesisHash:string;checkpointHeight?:string;ledger?:string};readonly anchor:{height:string;hash:string;timestampMs:number|null;parentHash?:string};readonly readerCount:number;readonly confirmationDepth:number;readonly observedAt:number;readonly expiresAt:number;readonly executable:false;readonly notes:readonly string[];readonly assurance:{rpcAgreement:boolean;identityAnchorMatched:true;independentOperatorsVerified:false;consensusProofVerified:false;blockExecutionVerified:false;certifiedLedgerState:false;icpSubnetIdentityVerified:false;sourceFreshnessEstablished:boolean};readonly privacy:{model:PrivacyModel;endpointTopologyIncluded:false;privateBalancesRead:false;viewingKeysRead:false;spendingKeysRead:false;anonymityGuaranteed:false;peerPublicationAllowed:false};}
export function observeExtended(options:ReaderOptions&{profile:Profile;genesisPin?:string;identityAnchor?:{height:UInt;hash:string};ledger?:{canister:string;networkFormat:'hex'|'principal'};policy?:{confirmationDepth?:number;maxHeadGap?:number;maxBlockAgeMs?:number;ttlMs?:number}}):Promise<Observation>;
export type IcpNetwork='icp:mainnet'|`icp:local-${string}`;
export interface IcrcAsset {readonly network:IcpNetwork;readonly kind:'icrc-ledger';readonly canister:string;readonly key:string;readonly executable:false;}
export interface AccountInput {owner:string;subaccount?:string|null;}
export interface IcrcAccount {readonly owner:string;readonly subaccount:string;readonly key:string;}
export function icrcAsset(network:IcpNetwork,ledger:string):IcrcAsset;
export function icrcAccount(account:AccountInput):IcrcAccount;
export function normalizePrincipal(value:string):string;
export function canisterPrincipal(value:string):string;
export function principalBytes(value:string):Uint8Array;
export function principalText(value:Uint8Array):string;
export interface IcrcStandard {name:string;url:string;}
export interface IcrcReader {readonly asset:IcrcAsset;query(method:'icrc1_name'|'icrc1_symbol'|'icrc1_fee'|'icrc1_total_supply'):Promise<string>;query(method:'icrc1_decimals'):Promise<number>;query(method:'icrc1_supported_standards'):Promise<IcrcStandard[]>;query(method:'icrc1_balance_of',options:{account:AccountInput}):Promise<string>;}
export function createIcrcReader(options:Omit<ReaderOptions,'endpoints'>&{network:IcpNetwork;ledger:string;endpoint:string;headers?:Record<string,string>;allowAccountQuery?:boolean}):IcrcReader;
export interface IcrcObservation {readonly schema:'realdex.icrc-observation.v1';readonly asset:IcrcAsset;readonly name:string;readonly symbol:string;readonly decimals:number;readonly transferFeeAtomic:string;readonly reportedStandards:readonly IcrcStandard[];readonly observedAt:number;readonly expiresAt:number;readonly readerCount:number;readonly executable:false;readonly notes:readonly string[];readonly assurance:{rpcAgreement:boolean;metadataStableAcrossReads:true;sameStateSnapshot:false;rootTrustVerified:false;responseSignatureVerified:false;certifiedLedgerState:false;ledgerImplementationVerified:false};readonly disclosure:{accountQueried:false;keysRequested:false;topologyIncluded:false;peerPublicationAllowed:false};}
export function observeIcrcLedger(options:ReaderOptions&{network:IcpNetwork;ledger:string}):Promise<IcrcObservation>;
export interface PoolModelInput {network:IcpNetwork;ledgerIn:string;ledgerOut:string;reserveInAtomic:string;reserveOutAtomic:string;inputBudgetAtomic:string;inputTransferFeeAtomic:string;outputTransferFeeAtomic:string;poolFeeBps:number;slippageBps:number;}
export interface PoolModelQuote {readonly schema:'realdex.icrc-cpmm-model-quote.v1';readonly assetIn:IcrcAsset;readonly assetOut:IcrcAsset;readonly inputBudgetAtomic:string;readonly poolInputAtomic:string;readonly inputTransferFeeAtomic:string;readonly grossPoolDebitOutAtomic:string;readonly outputTransferFeeAtomic:string;readonly netOutAtomic:string;readonly minimumNetOutAtomic:string;readonly reserveAfterInAtomic:string;readonly reserveAfterOutAtomic:string;readonly assumptions:readonly string[];readonly modelOnly:true;readonly requiresNonAtomicRecovery:true;readonly executable:false;}
export function quoteIcrcPool(input:PoolModelInput):PoolModelQuote;
export interface IntentInput {network:IcpNetwork;ledger:string;from:AccountInput;to:AccountInput;amountAtomic:string;feeAtomic:string;memoHex:string;createdAtTimeNs:UInt;}
export interface TransferIntent {readonly schema:'realdex.icrc-transfer-intent.v1';readonly id:string;readonly terms:{asset:IcrcAsset;from:IcrcAccount;to:IcrcAccount;amountAtomic:string;feeAtomic:string;memoHex:string;createdAtTimeNs:string};readonly totalDebitAtomic:string;readonly serializedTransaction:false;readonly executable:false;}
export function transferIntent(input:IntentInput):Promise<TransferIntent>;
export interface SettlementRecord {readonly schema:'realdex.icrc-settlement-model.v1';readonly intentId:string;readonly state:'prepared'|'in-flight'|'uncertain'|'reported-success'|'reported-rejection';readonly submissionCount:0|1;readonly reportedBlock:string|null;readonly manualReconciliationRequired:boolean;readonly settlementVerified:false;readonly executable:false;}
export type SettlementEvent={intentId:string;kind:'begin'|'transport-unknown'|'too-old'|'created-in-future'|'bad-fee'|'insufficient-funds'|'temporary-unavailable'|'generic-error'}|{intentId:string;kind:'ok'|'duplicate';blockIndex:UInt};
export function newSettlementRecord(intent:TransferIntent):SettlementRecord;
export function advanceSettlement(record:SettlementRecord,event:SettlementEvent):SettlementRecord;
export type Visibility='transparent'|'shielded'|'confidential'|'unknown';
export interface RouteEndpoint {networkId:string;assetKey:string;visibility:Visibility;}
export interface RouteClaim {id:string;amountInAtomic:string;minimumOutAtomic:string;additionalCostOutAtomic:string|null;expiresAt:number;steps:readonly {id:string;kind:'swap'|'bridge';from:RouteEndpoint;to:RouteEndpoint;disclosure:'none'|'public-amounts'|'public-addresses'|'public-both'|'unknown'}[];}
export interface RouteRequest {inputAssetKey:string;outputAssetKey:string;amountInAtomic:string;}
export interface RoutePolicy {requireEndToEndPrivacy?:boolean;allowPublicBoundary?:boolean;allowConfidentialHardware?:boolean;}
export interface RouteScreen {readonly routeId:string;readonly allowedForFurtherVerification:boolean;readonly reasons:readonly string[];readonly netMinimumOutAtomic:string|null;readonly declaredPrivacyPreserved:boolean;readonly privacyActuallyVerified:false;readonly quoteActuallyVerified:false;readonly executable:false;}
export function screenRoute(route:RouteClaim,request:RouteRequest,policy?:RoutePolicy,now?:number):RouteScreen;
export function selectPolicyRoute(routes:readonly RouteClaim[],request:RouteRequest,policy?:RoutePolicy,now?:number):Readonly<{selectedForFurtherVerification:string|null;assessments:readonly RouteScreen[];allRoutesRejected:boolean;executable:false}>;
