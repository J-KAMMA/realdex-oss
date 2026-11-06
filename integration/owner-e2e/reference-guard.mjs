/** Fixed INJ12 product bytes plus explicitly scoped validation additions. Not INJ13 compatibility. */
import {execFileSync} from 'node:child_process';
import {need} from './protocol.mjs';
export const REFERENCE_COMMIT='a0bb48445bc4d626806697475fc7965485b1a9ac';
export const REFERENCE_TREE='dcaf00429368fcbe83bb62b5b98bd1ddef627135';
// The only baseline modification is the reviewed E2E05 test scheduler, not wallet product code.
export const SCHEDULER_BLOBS=Object.freeze({
 'wallet/test/run.mjs':'b62c361d8b3961a9b3c8dcb0774420f0aebe2839',
 'dev/wallet-test-runner.mjs':'4154eb7baa70c0c2a94c70f61d4b45a233fe9a02',
 'app/test/wallet-runner.test.mjs':'2f833365c4f38460c59926065dcf4c3765877d0f'
});
function inventory(rows){
 need(Array.isArray(rows)&&rows.length>0&&rows.length<=10000,'E2E_REFERENCE_INVENTORY');const entries=new Map();
 for(const r of rows){need(r&&typeof r.path==='string'&&r.path.length<=400&&/^[A-Za-z0-9_.\/-]+$/.test(r.path)&&!r.path.startsWith('/')&&!r.path.split('/').some(x=>x===''||x==='.'||x==='..')&&['100644','100755'].includes(r.mode)&&/^[a-f0-9]{40}$/.test(r.oid)&&!entries.has(r.path),'E2E_REFERENCE_INVENTORY');entries.set(r.path,r);}
 return entries;
}
const addon=p=>p.startsWith('integration/owner-e2e/')||/^app\/test\/owner-(?:stack|crash|acceptance)-addon\.test\.mjs$/.test(p)||/^docs\/validation\/E2E[0-9]{2}-[A-Z0-9-]+\.md$/.test(p);
export function verifyReferenceInventory(baseRows,currentRows){
 const base=inventory(baseRows),current=inventory(currentRows);let protectedFiles=0,validationFiles=0;
 for(const [p,b] of base){
  const c=current.get(p);need(c,'E2E_REFERENCE_FILE_REMOVED');
  if(p==='wallet/test/run.mjs')need(c.mode==='100644'&&[b.oid,SCHEDULER_BLOBS[p]].includes(c.oid),'E2E_REFERENCE_SCHEDULER_CHANGED');
  else {need(c.oid===b.oid&&c.mode===b.mode,'E2E_REFERENCE_PRODUCT_CHANGED');protectedFiles++;}
 }
 for(const [p,c] of current){if(base.has(p))continue;
  if(Object.hasOwn(SCHEDULER_BLOBS,p))need(c.mode==='100644'&&c.oid===SCHEDULER_BLOBS[p],'E2E_REFERENCE_SCHEDULER_CHANGED');
  else need(addon(p),'E2E_REFERENCE_ADDITION_OUTSIDE_SCOPE');validationFiles++;
 }
 // A replaced entry point must have the exact paired implementation and regression tests.
 if(current.get('wallet/test/run.mjs')?.oid===SCHEDULER_BLOBS['wallet/test/run.mjs'])
  for(const p of ['dev/wallet-test-runner.mjs','app/test/wallet-runner.test.mjs'])need(current.get(p)?.oid===SCHEDULER_BLOBS[p],'E2E_REFERENCE_SCHEDULER_INCOMPLETE');
 return {referenceProduct:'INJ12',protectedFiles,validationFiles,checkpointCompatibilityVerified:false,productSuccessor:false};
}
export function requireReferenceSource(root){
 const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',timeout:15000,maxBuffer:4194304,stdio:['ignore','pipe','pipe']});
 need(git(['rev-parse',REFERENCE_COMMIT+'^{tree}']).trim()===REFERENCE_TREE,'E2E_REFERENCE_BASE_MISMATCH');
 try{git(['merge-base','--is-ancestor',REFERENCE_COMMIT,'HEAD']);}catch{throw Error('E2E_REFERENCE_ANCESTRY');}
 const read=ref=>git(['ls-tree','-rz',ref]).split('\0').filter(Boolean).map(line=>{
  const m=/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/.exec(line);need(m,'E2E_REFERENCE_NONREGULAR');return {mode:m[1],oid:m[2],path:m[3]};
 });
 return {...verifyReferenceInventory(read(REFERENCE_COMMIT),read('HEAD')),referenceCommit:REFERENCE_COMMIT,referenceTree:REFERENCE_TREE};
}
