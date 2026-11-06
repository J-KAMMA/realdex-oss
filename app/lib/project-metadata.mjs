/** Inspect delivered metadata without executing package scripts or reading credentials. */
import fs from 'node:fs';
import path from 'node:path';
export function projectMetadata(root){
  function json(name){try{return JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));}catch{return null;}}
  const pkg=json('package.json'),release=json('RELEASE.json');
  let nodePin=null;try{nodePin=fs.readFileSync(path.join(root,'.node-version'),'utf8').trim();}catch{}
  const exact=/^\d+\.\d+\.\d+$/;
  const packageNode=pkg?.engines?.node??null,packagePnpm=pkg?.engines?.pnpm??null;
  const manager=typeof pkg?.packageManager==='string'?/^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager):null;
  const releaseValid=release?.schema==='realdex.release-lineage.v1'&&typeof release.version==='string'&&/^\d+\.\d+\.\d+-dev\.\d{8}$/.test(release.version)&&release.productionReady===false;
  const problems=[];
  if(!releaseValid)problems.push('RELEASE_METADATA_INVALID');
  if(!exact.test(packageNode??''))problems.push('PACKAGE_NODE_PIN_INVALID');
  if(!exact.test(nodePin??''))problems.push('NODE_VERSION_FILE_INVALID');
  if(nodePin!==packageNode)problems.push('NODE_PIN_DISAGREEMENT');
  if(!manager||!exact.test(packagePnpm??'')||manager[1]!==packagePnpm)problems.push('PACKAGE_MANAGER_PIN_DISAGREEMENT');
  return {release:releaseValid?release.version:null,packageVersion:pkg?.version??null,
    requiredNode:packageNode,nodeVersionFile:nodePin,packageManager:manager?'pnpm@'+manager[1]:null,
    configurationConsistent:problems.length===0,problems,productionReady:false};
}
