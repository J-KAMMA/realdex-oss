#!/usr/bin/env node
import {ibcToolStatus} from '../integration/ibc/toolchain.mjs';
/** Local acceptance only. Never deploys, loads production keys or promotes a release. */
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {doctor} from './doctor.mjs';import {need,safeError} from '../wallet/lib/guard.mjs';
import {rootScriptPlan} from './lib/root-script-plan.mjs';
import {pinnedPnpmStatus} from './lib/root-package-manager.mjs';
import {runAcceptanceGate} from './lib/acceptance-runner.mjs';
import {ROOT_GATES,ACCOUNT_RUNTIME_GATES,acceptancePassed,sourceSnapshot} from './lib/acceptance.mjs';
import pin from '../integration/compiler-pin.cjs';
import {anvilStatus} from '../integration/anvil/toolchain.mjs';
import {solanaToolStatus} from '../integration/solana/toolchain.mjs';
import {simdStatus} from '../integration/cosmos/toolchain.mjs';
import {aptosStatus} from '../integration/aptos/toolchain.mjs';
import {stellarQuickstartStatus} from '../integration/stellar/toolchain.mjs';
import {bitcoindStatus} from '../integration/bitcoin/toolchain.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha256=buffer=>createHash('sha256').update(buffer).digest('hex');
const controller=new AbortController(),interrupt=()=>controller.abort();
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
try{
  const args=process.argv.slice(2),full=args.includes('--full'),solana=args.includes('--solana'),bitcoin=args.includes('--bitcoin'),cosmos=args.includes('--cosmos'),aptos=args.includes('--aptos'),stellar=args.includes('--stellar'),ibc=args.includes('--ibc'),values=args.filter(x=>!['--full','--solana','--bitcoin','--cosmos','--aptos','--stellar','--ibc'].includes(x));
  need(values.length===2&&values[0]==='--output'&&args.filter(x=>x==='--full').length<=1&&args.filter(x=>x==='--solana').length<=1&&args.filter(x=>x==='--bitcoin').length<=1&&args.filter(x=>x==='--cosmos').length<=1&&args.filter(x=>x==='--aptos').length<=1&&args.filter(x=>x==='--stellar').length<=1&&args.filter(x=>x==='--ibc').length<=1,'VERIFY_REQUIRES_OUTPUT_DIRECTORY');
  const output=path.resolve(values[1]);need(!fs.existsSync(output),'VERIFY_OUTPUT_ALREADY_EXISTS');fs.mkdirSync(output,{recursive:true,mode:0o700});
  const before=sourceSnapshot(root,{exclude:[output]});
  fs.writeFileSync(path.join(output,'source-before.json'),JSON.stringify(before,null,2)+'\n');
  const environment={};
  for(const k of ['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','TZ','REALDEX_SOLC_BINARY','REALDEX_PNPM_CLI','REALDEX_BROWSER_EXECUTABLE','REALDEX_ANVIL_BINARY','REALDEX_SOLANA_TEST_ARCHIVE','REALDEX_TEST_PYTHON','REALDEX_BITCOIND_BINARY','REALDEX_SIMD_BINARY','REALDEX_APTOS_BINARY','REALDEX_STELLAR_CONTAINER_RUNTIME','REALDEX_IBC_SIMD_BINARY','REALDEX_IBC_MUSL_LOADER','REALDEX_PUBLIC_NETWORK_READS'])if(process.env[k])environment[k]=process.env[k];
  // No NODE_OPTIONS, signing keys, public RPC URLs, agent token, or production environment forwarding.
  environment.CI='1';environment.REALDEX_REQUIRE_OFFLINE_SOLC='1';
  const gates=[];
  async function run(name,command,argv,{scope='unit-and-synthetic-http',...options}={}){
    const gate=controller.signal.aborted
      ?{name,scope,status:'blocked',reason:'VERIFY_ABORTED_BEFORE_START',sourceDigest:before.digest}
      :await runAcceptanceGate({name,command,args:argv,cwd:root,output,env:environment,sourceDigest:before.digest,scope,...options,signal:controller.signal});
    gates.push(gate);
    fs.writeFileSync(path.join(output,name+'.gate.json'),JSON.stringify(gate,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(name+': '+gate.status);return gate;
  }
  const blocked=(name,reason,scope='root-project-unexecuted')=>gates.push({name,status:'blocked',reason,scope,sourceDigest:before.digest});
  await run('wallet-tests',process.execPath,['wallet/test/run.mjs'],{requireTap:true,timeout:600000});
  await run('node-tests',process.execPath,['node/test/run-tests.mjs','--with-release'],{requireTap:true,timeout:600000});
  const externalTests=fs.readdirSync(path.join(root,'node/external/test')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'node/external/test/'+n);
  need(externalTests.length>0,'EXTERNAL_TEST_SET_EMPTY');
  await run('external-spot-tests',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...externalTests],{scope:'exact-spot-arithmetic-and-synthetic-loopback-provider-HTTP; not-live-venue; no-orders',requireTap:true});
  const appTests=fs.readdirSync(path.join(root,'app/test')).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'app/test/'+x);
  need(appTests.length>0,'APP_TEST_SET_EMPTY');
  await run('app-tests',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...appTests],{scope:'unit-and-local-child-services',requireTap:true});
  const relayTests=fs.readdirSync(path.join(root,'relay/test')).filter(x=>x.endsWith('.test.mjs')).sort().map(x=>'relay/test/'+x);
  need(relayTests.length>0,'RELAY_TEST_SET_EMPTY');
  await run('relay-tests',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap',...relayTests],{scope:'bounded-relayer-policy-storage-and-failure-tests',requireTap:true});
  const diagnosis=doctor();fs.writeFileSync(path.join(output,'doctor.json'),JSON.stringify(diagnosis,null,2)+'\n');
  const compiler=pin.compilerStatus(environment.REALDEX_SOLC_BINARY);
  fs.writeFileSync(path.join(output,'compiler-status.json'),JSON.stringify(compiler,null,2)+'\n');
  const nativeTool=anvilStatus(environment.REALDEX_ANVIL_BINARY);
  fs.writeFileSync(path.join(output,'anvil-status.json'),JSON.stringify(nativeTool,null,2)+'\n');
  if(full){
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
    let rootPlan;
    try{rootPlan=rootScriptPlan(manifest);gates.push({name:'root-script-declarations',status:'passed',scope:'package-json-declared-root-test-completeness',scripts:rootPlan.map(g=>g.script),sourceDigest:before.digest});}
    catch(error){gates.push({name:'root-script-declarations',status:'failed',reason:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'ROOT_SCRIPT_PLAN_INVALID',sourceDigest:before.digest});}
    const packageManager=pinnedPnpmStatus(environment.REALDEX_PNPM_CLI,manifest.engines?.pnpm,environment);
    fs.writeFileSync(path.join(output,'package-manager.json'),JSON.stringify(packageManager,null,2)+'\n');
    gates.push({name:'root-package-manager',status:packageManager.available?'passed':'blocked',...packageManager,scope:'explicit-pinned-pnpm-version; no-auto-install',sourceDigest:before.digest});
    const runtimeReady=diagnosis.runtimeConfigurationConsistent&&diagnosis.rootNodeVersionMatches&&diagnosis.rootDependenciesResolvable;
    const rootNames=ROOT_GATES.filter(name=>!['root-script-declarations','root-package-manager'].includes(name));
    if(!rootPlan||!packageManager.available||!runtimeReady){
      const reason=!rootPlan?'ROOT_SCRIPT_DECLARATION_INVALID':!packageManager.available?packageManager.reason:'PINNED_RUNTIME_OR_ROOT_DEPENDENCIES_MISSING';
      for(const name of rootNames)blocked(name,reason);
    }else{
      const hardhatReport=async(name,argv,suite,scope)=>{
        const report=path.join(output,name+'.report.json');
        environment.REALDEX_ACCEPTANCE_REPORT=report;environment.REALDEX_ACCEPTANCE_HARDHAT_SUITE=suite;
        try{return await run(name,process.execPath,argv,{scope,timeout:600000,frameworkFormat:'mocha',frameworkReport:report});}
        finally{delete environment.REALDEX_ACCEPTANCE_REPORT;delete environment.REALDEX_ACCEPTANCE_HARDHAT_SUITE;}
      };
      for(const item of rootPlan){
        if(item.requiresCompiler&&!compiler.available){blocked(item.name,compiler.reason,'real-EVM-unexecuted');continue;}
        const argv=[packageManager.cli,'run',item.script];
        if(item.script==='test:contracts')await hardhatReport(item.name,[...argv,'--config','integration/hardhat-acceptance.config.cjs'],'root','real-EVM-original-contract-suite');
        else if(item.script==='test:ui'){
          const report=path.join(output,item.name+'.report.json');
          await run(item.name,process.execPath,[...argv,'--reporter=json','--outputFile='+report],{scope:'React-test-suite',timeout:600000,frameworkFormat:'vitest',frameworkReport:report});
        }else await run(item.name,process.execPath,argv,{scope:item.script==='build'?'full-React-build':item.script==='test:release-plan'?'release-plan-unit-tests':'original-static-and-artifact-check',timeout:600000,requireTap:item.script==='test:release-plan'});
      }
      if(compiler.available)await hardhatReport('real-evm-wallet-integration',['node_modules/hardhat/internal/cli/cli.js','test','--config','integration/hardhat-acceptance.config.cjs'],'wallet','real-EVM-wallet-AMM-agent');
      else blocked('real-evm-wallet-integration',compiler.reason,'real-EVM-unexecuted');
    }
    // P0-01: two independent public readers must observe the deployment the committed
    // profile names. This used to live inside the offline React suite as a test skipped
    // on REALDEX_LIVE, where it could only ever report as pending — and root-ui-tests
    // refuses a run containing any pending test, so that gate could not pass no matter
    // what the code did. It is not excluded to make the count come out right: it is a
    // gate with a name of its own, which runs when the operator has enabled public reads
    // and blocks with a declared reason when they have not. An invisible skip became a
    // visible gate. Read-only: no key is loaded, nothing is signed, nothing is submitted,
    // and the endpoints are the two the test names, not configuration. Emitted outside
    // the root-script branch so it is reported whether or not the root plan is usable.
    if(environment.REALDEX_PUBLIC_NETWORK_READS==='1'){
      const report=path.join(output,'public-testnet-readers.report.json');
      environment.REALDEX_LIVE='1';
      try{await run('public-testnet-readers',process.execPath,['node_modules/vitest/vitest.mjs','run','--config','vitest.live.config.ts','--reporter=json','--outputFile='+report],{scope:'read-only-public-Base-Sepolia; two-independent-readers; no-key; no-signing; no-submission',timeout:300000,frameworkFormat:'vitest',frameworkReport:report});}
      finally{delete environment.REALDEX_LIVE;}
    }else blocked('public-testnet-readers','PUBLIC_NETWORK_READS_NOT_ENABLED','public-two-reader-verification-unexecuted');
    if(nativeTool.available)await run('native-real-evm',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/anvil/NativePayments.test.mjs'],{scope:'real-single-Anvil-native-payments-and-bounded-agent; no-AMM-compile; no-public-chain',requireTap:true,timeout:180000});
    else blocked('native-real-evm',nativeTool.reason,'native-real-EVM-unexecuted');
    // Executes the stable candidate's OWN bytecode, not the experimental wallet artifact.
    // Deployed-code identity plus real owner-authorised execution; never a promotion signal.
    if(nativeTool.available)await run('smart-account-stable-candidate-evm',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/smart-account/StableCandidateAnvil.test.mjs'],{scope:'stable-candidate-bytecode-on-pinned-Anvil; identity-and-execution-only; not-review-or-promotion',requireTap:true,timeout:180000});
    else blocked('smart-account-stable-candidate-evm',nativeTool.reason,'stable-candidate-EVM-unexecuted');
    // No experimental profile is forwarded here. Only the immutable 0.8.24 pin
    // may satisfy this baseline AMM gate, regardless of auxiliary nightly results.
    if(compiler.available&&nativeTool.available)await run('amm-pinned-real-evm',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/amm/Settlement.test.mjs'],{scope:'fixed-0.8.24-real-single-Anvil-AMM',requireTap:true,timeout:180000});
    else blocked('amm-pinned-real-evm',!compiler.available?compiler.reason:nativeTool.reason,'fixed-compiler-AMM-unexecuted');
    if(compiler.available)await run('local-compilation',process.execPath,['integration/compile-local.mjs','--compiler',environment.REALDEX_SOLC_BINARY,'--output',path.join(output,'local-compilation')],{scope:'hash-pinned-native-solc-no-EVM-or-RPC'});
    else blocked('local-compilation',compiler.reason,'local-compiler-unexecuted');
    blocked('smart-account-stable-build','SMART_ACCOUNT_STABLE_COMPILER_REVIEW_PENDING','smart-account-formal-build-and-audit');
    const browser=await run('browser-http',process.platform==='win32'?'python':'python3',['wallet/test/browser-http.py','--output',path.join(output,'browser-http')],{scope:'real-browser-local-wallet-HTTP-CSP',timeout:180000});
    const resultFile=path.join(output,'browser-http','browser-http.json');
    if(fs.existsSync(resultFile)){
      const r=JSON.parse(fs.readFileSync(resultFile,'utf8'));
      browser.browserResultSha256=sha256(fs.readFileSync(resultFile));
      if(browser.exitCode===2&&r.status==='blocked'){browser.status='blocked';browser.reason=r.reason;}
      if(browser.status==='passed'&&!(r.status==='passed'&&r.realHttpIntegration===true&&r.cspEnforced===true)){
        browser.status='failed';browser.reason='BROWSER_EVIDENCE_INCOMPLETE';
      }
    }else if(browser.status==='passed'){browser.status='failed';browser.reason='BROWSER_EVIDENCE_MISSING';}
  }else for(const name of [...ROOT_GATES,'native-real-evm','amm-pinned-real-evm','local-compilation','browser-http'])gates.push({name,status:'not-run',scope:'requires-full-mode',sourceDigest:before.digest});
  const solanaTool=solanaToolStatus(environment.REALDEX_SOLANA_TEST_ARCHIVE);
  fs.writeFileSync(path.join(output,'solana-status.json'),JSON.stringify(solanaTool,null,2)+'\n');
  if(full||solana){
    if(solanaTool.available){
      await run('solana-native-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/solana/NativePayments.test.mjs'],{scope:'real-LiteSVM-execution; synthetic-RPC-metadata; not-validator-or-consensus',requireTap:true,timeout:180000});
      await run('solana-spl-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/solana/SplPayments.test.mjs'],{scope:'real-LiteSVM-classic-Token-Program; synthetic-RPC-metadata; not-validator-or-consensus',requireTap:true,timeout:180000});
    }else for(const name of ['solana-native-runtime','solana-spl-runtime'])blocked(name,solanaTool.reason,'non-EVM-runtime-unexecuted');
  }else for(const name of ['solana-native-runtime','solana-spl-runtime'])gates.push({name,status:'not-run',scope:'requires-solana-or-full-mode',sourceDigest:before.digest});
  const bitcoinTool=bitcoindStatus(environment.REALDEX_BITCOIND_BINARY);
  fs.writeFileSync(path.join(output,'bitcoin-status.json'),JSON.stringify(bitcoinTool,null,2)+'\n');
  if(full||bitcoin){
    if(bitcoinTool.available)await run('bitcoin-core-regtest',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/bitcoin/Payments.test.mjs'],{scope:'real-single-Bitcoin-Core-regtest; two-forwarding-URLs; no-P2P-or-public-network',requireTap:true,timeout:180000});
    else blocked('bitcoin-core-regtest',bitcoinTool.reason,'Bitcoin-Core-regtest-unexecuted');
  }else gates.push({name:'bitcoin-core-regtest',status:'not-run',scope:'requires-bitcoin-or-full-mode',sourceDigest:before.digest});
  const cosmosTool=simdStatus(environment.REALDEX_SIMD_BINARY);
  fs.writeFileSync(path.join(output,'cosmos-status.json'),JSON.stringify(cosmosTool,null,2)+'\n');
  if(full||cosmos){
    if(cosmosTool.available){
      await run('cosmos-simd-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/cosmos/Payments.test.mjs'],{scope:'real-pinned-development-simd; single-validator; two-forwarding-URLs; no-public-chain-or-independent-consensus-proof',requireTap:true,timeout:180000});
      await run('cosmos-authz-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/cosmos/Authz.test.mjs'],{scope:'native-on-chain-SendAuthorization; single-local-validator; no-consensus-proof; not-smart-contract-account',requireTap:true,timeout:240000});
    } else for(const name of ['cosmos-simd-runtime','cosmos-authz-runtime'])blocked(name,cosmosTool.reason,'Cosmos-simd-unexecuted');
  }else for(const name of ['cosmos-simd-runtime','cosmos-authz-runtime'])gates.push({name,status:'not-run',scope:'requires-cosmos-or-full-mode',sourceDigest:before.digest});
  const stellarTool=stellarQuickstartStatus(environment.REALDEX_STELLAR_CONTAINER_RUNTIME);
  fs.writeFileSync(path.join(output,'stellar-status.json'),JSON.stringify(stellarTool,null,2)+'\n');
  if((full||stellar)&&stellarTool.available)await run('stellar-core-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/stellar/StellarRuntime.test.mjs'],{scope:'real-local-Stellar-Core-and-Horizon; pinned-image-digest; loopback-only; real-XLM-payment-and-no-resend-reconciliation; no-public-network',requireTap:true,timeout:900000});
  else if(full||stellar)blocked('stellar-core-runtime',stellarTool.reason,'Stellar-Core-Quickstart-unexecuted');
  else gates.push({name:'stellar-core-runtime',status:'not-run',scope:'requires-stellar-or-full-mode',sourceDigest:before.digest});
  const aptosTool=aptosStatus(environment.REALDEX_APTOS_BINARY);
  fs.writeFileSync(path.join(output,'aptos-status.json'),JSON.stringify(aptosTool,null,2)+'\n');
  if(full||aptos){
    if(aptosTool.available)await run('aptos-local-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/aptos/Payments.test.mjs'],{scope:'real-pinned-Aptos-VM; single-local-validator; two-forwarders; no-independent-consensus-proof',requireTap:true,timeout:360000});
    else blocked('aptos-local-runtime',aptosTool.reason,'Aptos-local-validator-unexecuted');
  }else gates.push({name:'aptos-local-runtime',status:'not-run',scope:'requires-aptos-or-full-mode',sourceDigest:before.digest});
  const ibcTool=ibcToolStatus(environment.REALDEX_IBC_SIMD_BINARY,environment.REALDEX_IBC_MUSL_LOADER);
  fs.writeFileSync(path.join(output,'ibc-status.json'),JSON.stringify(ibcTool,null,2)+'\n');
  if(full||ibc){
    if(ibcTool.available){environment.REALDEX_IBC_LOG_DIRECTORY=path.join(output,'ibc-nodes');await run('ibc-two-chain-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/ibc/Bridge.test.mjs'],{scope:'diagnostic-ibc-go; two distinct single-validator chains; genuine Tendermint client/proof verification; desktop observations not independently authenticated',requireTap:true,timeout:360000});await run('ibc-tracking-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/ibc/Tracking.test.mjs'],{scope:'real-two-chain-IBC; read-only event search and bounded observer; no relay authority or independent desktop consensus proof',requireTap:true,timeout:360000});await run('ibc-relay-runtime',process.execPath,['--test','--test-concurrency=1','--test-reporter=tap','integration/ibc/Relay.test.mjs'],{scope:'bounded dedicated fee signer; real two-chain receive-ACK-timeout; encrypted crash recovery; not public relayer',requireTap:true,timeout:360000});}
    else for(const name of ['ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime'])blocked(name,ibcTool.reason,'IBC-two-chain-unexecuted');
  }else for(const name of ['ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime'])gates.push({name,status:'not-run',scope:'requires-ibc-or-full-mode',sourceDigest:before.digest});
  const after=sourceSnapshot(root,{exclude:[output]});fs.writeFileSync(path.join(output,'source-after.json'),JSON.stringify(after,null,2)+'\n');
  gates.push({name:'source-stability',scope:before.scope,status:before.digest===after.digest?'passed':'failed',before:before.digest,after:after.digest});
  const selected=gates.filter(g=>g.counts);
  gates.push({name:'runtime-configuration',scope:'delivered-release-and-runtime-pins',status:diagnosis.runtimeConfigurationConsistent?'passed':'failed',problems:diagnosis.runtimeConfigurationProblems});
  const localNames=['runtime-configuration','wallet-tests','node-tests','app-tests','relay-tests','external-spot-tests','source-stability'];
  const summary={schema:'realdex.acceptance.v2',release:diagnosis.release,createdAt:new Date().toISOString(),fullRequested:full,solanaRequested:solana||full,bitcoinRequested:bitcoin||full,cosmosRequested:cosmos||full,aptosRequested:aptos||full,stellarRequested:stellar||full,ibcRequested:ibc||full,
    sourceDigest:before.digest,gates,selectedTestCounts:Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,selected.reduce((s,g)=>s+g.counts[k],0)])),
    selectedScopePassed:acceptancePassed(gates.filter(g=>localNames.includes(g.name)),localNames),
    fullLocalAcceptancePassed:full&&acceptancePassed(gates,[...localNames,...ROOT_GATES,...ACCOUNT_RUNTIME_GATES,'smart-account-stable-build','native-real-evm','amm-pinned-real-evm','local-compilation','browser-http','solana-native-runtime','solana-spl-runtime','bitcoin-core-regtest','cosmos-simd-runtime','cosmos-authz-runtime','ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime']),
    solanaNativeRuntimePassed:gates.some(g=>g.name==='solana-native-runtime'&&g.status==='passed'),
    requestedScopePassed:acceptancePassed(gates.filter(g=>[...localNames,...(solana?['solana-native-runtime','solana-spl-runtime']:[]),...(bitcoin?['bitcoin-core-regtest']:[]),...(cosmos?['cosmos-simd-runtime','cosmos-authz-runtime']:[]),...(aptos?['aptos-local-runtime']:[]),...(stellar?['stellar-core-runtime']:[]),...(ibc?['ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime']:[])].includes(g.name)),[...localNames,...(solana?['solana-native-runtime','solana-spl-runtime']:[]),...(bitcoin?['bitcoin-core-regtest']:[]),...(cosmos?['cosmos-simd-runtime','cosmos-authz-runtime']:[]),...(aptos?['aptos-local-runtime']:[]),...(stellar?['stellar-core-runtime']:[]),...(ibc?['ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime']:[])]),
    ibcBoundedRelayerRuntimePassed:gates.some(g=>g.name==='ibc-relay-runtime'&&g.status==='passed'),
    ibcAutomaticTrackingRuntimePassed:gates.some(g=>g.name==='ibc-tracking-runtime'&&g.status==='passed'),
    ibcTwoChainRuntimePassed:gates.some(g=>g.name==='ibc-two-chain-runtime'&&g.status==='passed'),
    stellarCoreRuntimePassed:gates.some(g=>g.name==='stellar-core-runtime'&&g.status==='passed'),
    aptosLocalRuntimePassed:gates.some(g=>g.name==='aptos-local-runtime'&&g.status==='passed'),
    cosmosAuthzRuntimePassed:gates.some(g=>g.name==='cosmos-authz-runtime'&&g.status==='passed'),
    cosmosSimdRuntimePassed:gates.some(g=>g.name==='cosmos-simd-runtime'&&g.status==='passed'),
    bitcoinCoreRegtestPassed:gates.some(g=>g.name==='bitcoin-core-regtest'&&g.status==='passed'),
    solanaSplRuntimePassed:gates.some(g=>g.name==='solana-spl-runtime'&&g.status==='passed'),
    realEvmNativePassed:gates.some(g=>g.name==='native-real-evm'&&g.status==='passed'),
    testCountsByScope:{unitAndLocalServices:Object.fromEntries(['tests','pass','fail','cancelled','skipped','todo'].map(k=>[k,selected.filter(g=>!['native-real-evm','amm-pinned-real-evm','solana-native-runtime','solana-spl-runtime','bitcoin-core-regtest','cosmos-simd-runtime','cosmos-authz-runtime','aptos-local-runtime','ibc-two-chain-runtime','ibc-tracking-runtime','ibc-relay-runtime'].includes(g.name)).reduce((s,g)=>s+g.counts[k],0)])),nativeRealEvm:gates.find(g=>g.name==='native-real-evm')?.counts??null,solanaNativeRuntime:gates.find(g=>g.name==='solana-native-runtime')?.counts??null,solanaSplRuntime:gates.find(g=>g.name==='solana-spl-runtime')?.counts??null,bitcoinCoreRegtest:gates.find(g=>g.name==='bitcoin-core-regtest')?.counts??null,cosmosAuthzRuntime:gates.find(g=>g.name==='cosmos-authz-runtime')?.counts??null,cosmosSimdRuntime:gates.find(g=>g.name==='cosmos-simd-runtime')?.counts??null,aptosLocalRuntime:gates.find(g=>g.name==='aptos-local-runtime')?.counts??null,ibcBoundedRelayerRuntime:gates.find(g=>g.name==='ibc-relay-runtime')?.counts??null,ibcAutomaticTrackingRuntime:gates.find(g=>g.name==='ibc-tracking-runtime')?.counts??null,ibcTwoChainRuntime:gates.find(g=>g.name==='ibc-two-chain-runtime')?.counts??null,pinnedAmmRealEvm:gates.find(g=>g.name==='amm-pinned-real-evm')?.counts??null},
    productionReady:false,publicDeploymentPerformed:false,
    remainingExternalGates:['independent-security-review','supported-live-testnets','Windows-and-OS-key-protection',
      'backup-rollback-and-cross-device-signing-policy','Solana-validator-and-ICP-certified-settlement; remaining-non-EVM-execution','Stellar-Core-integration-and-independent-state-proofs','public-cross-chain-settlement-and-independent-desktop-proof-verification','smart-account-stable-compiler-independent-audit-and-session-key-review','release-artifact-signature-and-update-review']};
  // Newly counted framework tests retain their own scope, separate from source-only suites.
  for(const [field,name]of [['rootContractEvm','root-contract-tests'],['walletAmmEvm','real-evm-wallet-integration'],['rootUi','root-ui-tests']]){
    const counts=gates.find(g=>g.name===name)?.counts??null;
    summary.testCountsByScope[field]=counts;
    if(counts)for(const key of ['tests','pass','fail','cancelled','skipped','todo'])summary.testCountsByScope.unitAndLocalServices[key]-=counts[key];
  }
  fs.writeFileSync(path.join(output,'acceptance.json'),JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary,null,2));
  process.exitCode=full?summary.fullLocalAcceptancePassed?0:2:summary.requestedScopePassed?0:1;
}catch(error){console.error(safeError(error));process.exitCode=1;}
finally{process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);}
