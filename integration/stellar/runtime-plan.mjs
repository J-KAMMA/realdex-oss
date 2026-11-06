/** Pure construction of the future real Quickstart runtime command. No execution. */
import {need} from '../../wallet/lib/guard.mjs';
import {validateStellarQuickstartPin,STELLAR_QUICKSTART_PIN} from './toolchain.mjs';
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const NAME=/^realdex-stellar-[a-z0-9][a-z0-9-]{0,47}$/;

export function stellarQuickstartRunPlan({pin=STELLAR_QUICKSTART_PIN,name='realdex-stellar-acceptance',hostPort=8000}={}){
  const checked=validateStellarQuickstartPin(pin);
  need(DIGEST.test(checked.quickstartImageDigest||''),'STELLAR_QUICKSTART_IMAGE_DIGEST_NOT_PINNED');
  need(NAME.test(name),'STELLAR_CONTAINER_NAME_INVALID');
  need(Number.isSafeInteger(hostPort)&&hostPort>=1024&&hostPort<=65535,'STELLAR_HOST_PORT_INVALID');
  const image=checked.quickstartImage+'@'+checked.quickstartImageDigest;
  const runArgs=['run','--rm','--detach','--name',name,'--publish','127.0.0.1:'+hostPort+':8000',image,
    '--local','--protocol-version',String(checked.protocolVersion),'--enable','core,horizon','--core-log-level','WARNING'];
  return Object.freeze({
    schema:'realdex.stellar-quickstart-run-plan.v1',
    image,name,host:'127.0.0.1',hostPort,
    horizonUrl:'http://127.0.0.1:'+hostPort+'/',
    friendbotUrl:'http://127.0.0.1:'+hostPort+'/friendbot',
    runArgs:Object.freeze(runArgs),
    coreVersionArgs:Object.freeze(['exec',name,'stellar-core','version']),
    horizonVersionArgs:Object.freeze(['exec',name,'stellar-horizon','version']),
    stopArgs:Object.freeze(['rm','--force',name]),
    networkPassphrase:checked.networkPassphrase,
    protocolVersion:checked.protocolVersion,
    autoPullAllowed:false,publicNetworkAllowed:false,persistentVolumeAllowed:false
  });
}
