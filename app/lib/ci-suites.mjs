import fs from 'node:fs';
import path from 'node:path';
export const CI_SUITES=Object.freeze(['wallet','node','external','app','relay']);
function tests(root,directory){
  const paths=fs.readdirSync(path.join(root,directory)).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>directory+'/'+n);
  if(!paths.length)throw Error('CI_EMPTY_TEST_DISCOVERY');return paths;
}
export function suiteCommand(root,name){
  if(!CI_SUITES.includes(name))throw Error('CI_UNKNOWN_SUITE');
  if(name==='wallet')return ['wallet/test/run.mjs'];
  if(name==='node')return ['node/test/run-tests.mjs','--with-release'];
  const directory={external:'node/external/test',app:'app/test',relay:'relay/test'}[name];
  return ['--test','--test-concurrency=1','--test-reporter=tap',...tests(root,directory)];
}
