/** Opt-in Hardhat override. Mandatory in the full acceptance runner; never downloads a compiler. */
function enableOfflineCompiler() {
  if(!process.env.REALDEX_SOLC_BINARY && process.env.REALDEX_REQUIRE_OFFLINE_SOLC!=='1')return;
  const {subtask}=require('hardhat/config');
  const {TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD}=require('hardhat/builtin-tasks/task-names');
  const {PIN,verifiedCompiler}=require('./compiler-pin.cjs');
  subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async({solcVersion})=>{
    if(solcVersion!==PIN.version)throw Error('UNPINNED_COMPILER_VERSION');
    return verifiedCompiler(process.env.REALDEX_SOLC_BINARY);
  });
}
module.exports={enableOfflineCompiler};
