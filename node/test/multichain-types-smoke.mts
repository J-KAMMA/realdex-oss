import {customEvmProfile,capabilities,observeChain,normalizeAsset,makeRegistry,type Observation} from '../chains/index.mjs';
const p=customEvmProfile('84532',{environment:'testnet'});
const c=capabilities(p);const cannotSend:false=c.swapsExecutable;
// @ts-expect-error read-only capability must not typecheck as executable
const canSend:true=c.swapsExecutable;
const asset=normalizeAsset(p,{kind:'erc20',reference:'0x'+'1'.repeat(40)});
const registry=makeRegistry({schema:'realdex.chain-candidates.v1',profiles:[p]});
async function example():Promise<Observation>{
 return observeChain({profile:registry.get(p.id),endpoints:['https://one.example','https://two.example']});
}
void cannotSend;void canSend;void asset;void example;
