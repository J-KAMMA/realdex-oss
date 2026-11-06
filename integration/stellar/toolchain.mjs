/**
 * Stellar Core/Horizon local-runtime preflight.
 *
 * This module intentionally cannot make a mutable Docker tag count as runtime
 * evidence. The source pin must first contain a full immutable sha256 image
 * digest. It never pulls an image and never executes a container runtime while
 * that digest is absent or malformed.
 */
import fs from 'node:fs';
import path from 'node:path';
import {need} from '../../wallet/lib/guard.mjs';
import pin from './pin.json' with {type:'json'};

export const STELLAR_QUICKSTART_PIN=Object.freeze(pin);
const FULL_IMAGE_DIGEST=/^sha256:[a-f0-9]{64}$/;
const IMMUTABLE_TRACK=/^stellar\/quickstart:v\d+-b\d+\.\d+-latest$/;

export function validateStellarQuickstartPin(value=STELLAR_QUICKSTART_PIN){
  need(value&&typeof value==='object'&&!Array.isArray(value),'STELLAR_PIN_INVALID');
  need(value.schema==='realdex.stellar-quickstart-pin.v1','STELLAR_PIN_SCHEMA');
  need(IMMUTABLE_TRACK.test(value.quickstartImage),'STELLAR_QUICKSTART_TAG_UNSAFE');
  need(value.testOnly===true&&value.publicNetworkAllowed===false&&value.autoPullAllowed===false,'STELLAR_PIN_POLICY');
  need(value.mode==='local','STELLAR_MODE_UNSAFE');
  need(value.networkPassphrase==='Standalone Network ; February 2017','STELLAR_NETWORK_PASSPHRASE');
  need(Number.isSafeInteger(value.protocolVersion)&&value.protocolVersion>0,'STELLAR_PROTOCOL_VERSION');
  need(/^v\d+\.\d+\.\d+$/.test(value.coreVersion),'STELLAR_CORE_VERSION');
  need(typeof value.coreBuild==='string'&&value.coreBuild.length>0,'STELLAR_CORE_BUILD');
  need(/^[a-f0-9]{8,64}$/.test(value.baseXdrGitVersion),'STELLAR_XDR_PIN');
  if(value.quickstartImageDigest!==null)need(FULL_IMAGE_DIGEST.test(value.quickstartImageDigest),'STELLAR_QUICKSTART_IMAGE_DIGEST_INVALID');
  return value;
}

function safeReason(error){return /^[A-Z][A-Z0-9_]+$/.test(error?.message||'')?error.message:'STELLAR_QUICKSTART_UNAVAILABLE';}

/**
 * Returns preflight status only. No network, Docker pull, container start, or
 * public RPC is performed here. A future commit may fill the immutable digest
 * after independent verification; until then the real runtime gate is blocked.
 */
export function stellarQuickstartStatus(containerRuntime){
  try{
    const checked=validateStellarQuickstartPin();
    need(FULL_IMAGE_DIGEST.test(checked.quickstartImageDigest||''),'STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED');
    need(typeof containerRuntime==='string'&&containerRuntime.length>0,'STELLAR_CONTAINER_RUNTIME_NOT_CONFIGURED');
    const file=path.resolve(containerRuntime),stat=fs.lstatSync(file);
    need(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o022)===0,'STELLAR_CONTAINER_RUNTIME_UNSAFE');
    fs.accessSync(file,fs.constants.X_OK);
    // Still no execution here: this reports only that a real run is now possible.
    // StellarRuntime.test.mjs is what starts the container, verifies its image
    // digest and the Core/Horizon versions, and moves real XLM before any pass.
    return {available:true,executed:false,image:checked.quickstartImage,imageDigest:checked.quickstartImageDigest,containerRuntime:file};
  }catch(error){return {available:false,reason:safeReason(error),executed:false};}
}
