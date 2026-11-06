#!/usr/bin/env node
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runWalletTests} from '../../dev/wallet-test-runner.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
try{process.exitCode=runWalletTests(here,process.argv.slice(2));}
catch(e){console.error(e instanceof Error?e.message:'WALLET_TEST_RUNNER_FAILED');process.exitCode=1;}
