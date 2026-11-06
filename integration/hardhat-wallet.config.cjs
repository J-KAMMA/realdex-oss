require("./offline-solc.cjs").enableOfflineCompiler();
// Isolated in-process EVM only: no fork, external RPC, signer environment or deployment command.
const path=require('node:path');
require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const root=path.resolve(__dirname,'..');
module.exports={
  solidity:{version:'0.8.24',settings:{optimizer:{enabled:true,runs:500}}},
  networks:{hardhat:{chainId:31337}},
  paths:{root,sources:path.join(root,'contracts'),tests:path.join(root,'integration/evm'),
    cache:path.join(root,'integration/.cache'),artifacts:path.join(root,'integration/.artifacts')},
  mocha:{timeout:120000},
};
