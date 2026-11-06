/** Candidate store for the E2E08 disposable launcher, NOT an INJ13 replacement.
 * Reuses the original encrypted file I/O. Changes ONLY the lifetime of the writer lease.
 */
import fs from 'node:fs';import path from 'node:path';
import {PrivateStore} from '../../wallet/lib/storage.mjs';
const MARKER='realdex.experimental.kernel-lease.v1\n';
const claimed=new Set();
const need=(ok,code)=>{if(!ok)throw Error('E2E_KERNEL_'+code);};
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
function privateStat(s,directory=false){need((directory?s.isDirectory():s.isFile()&&s.nlink===1&&s.size<=128)&&s.uid===process.getuid()&&(s.mode&0o077)===0,'UNSAFE_FILE');}
export function parseKernelLock(text,{pid,ino}){
 need(typeof text==='string'&&text.length<=16384,'FDINFO_LIMIT');
 const rows=text.split('\n').filter(x=>x.startsWith('lock:'));
 need(rows.length===1,'LEASE_NOT_HELD');
 const m=/^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+[a-f0-9]+:[a-f0-9]+:(\d+)\s+0\s+EOF\s*$/.exec(rows[0]);
 need(m&&m[1]===String(pid)&&m[2]===String(ino),'LEASE_NOT_HELD');return true;
}
export class KernelLeaseStore {
 constructor(directory,fd=Number(process.env.REALDEX_KERNEL_LEASE_FD)){
  need(process.platform==='linux'&&process.arch==='x64','PLATFORM');
  need(process.env.REALDEX_E2E08_CHILD==='disposable-only','EXPLICIT_TEST_MODE');
  need(Number.isInteger(fd)&&fd>=3&&!claimed.has(fd),'LEASE_DESCRIPTOR');
  this.directory=path.resolve(directory);
  need(path.basename(this.directory).startsWith('realdex-e2e08-vault-')&&fs.realpathSync(this.directory)===this.directory,'DISPOSABLE_DIRECTORY');
  this.directoryStat=fs.lstatSync(this.directory);privateStat(this.directoryStat,true);
  this.file=path.join(this.directory,'vault.json');this.lockFile=path.join(this.directory,'writer.lock');
  this.lock=fd;this.lockStat=fs.fstatSync(fd);this.assertOwned();claimed.add(fd);
 }
 assertOwned(){
  need(this.lock!==null,'STORE_CLOSED');
  const d=fs.lstatSync(this.directory);privateStat(d,true);
  need(!d.isSymbolicLink()&&same(d,this.directoryStat)&&fs.realpathSync(this.directory)===this.directory,'DIRECTORY_CHANGED');
  const held=fs.lstatSync(this.lockFile),opened=fs.fstatSync(this.lock);privateStat(held);privateStat(opened);
  need(!held.isSymbolicLink()&&same(held,this.lockStat)&&same(opened,this.lockStat),'LOCK_CHANGED');
  const b=Buffer.alloc(129),n=fs.readSync(this.lock,b,0,b.length,0);
  need(b.subarray(0,n).toString('utf8')===MARKER,'LOCK_FORMAT');
  // /proc/self/fdinfo reports the lock attached to THIS open file description,
  // not merely another process's lock on the same inode. Never re-acquire here.
  const info=fs.readFileSync('/proc/self/fdinfo/'+this.lock,'utf8');
  parseKernelLock(info,{pid:process.pid,ino:this.lockStat.ino});
 }
 exists(){this.assertOwned();return PrivateStore.prototype.exists.call(this);}
 read(){this.assertOwned();const r=PrivateStore.prototype.read.call(this);this.assertOwned();return r;}
 write(data,options={}){this.assertOwned();PrivateStore.prototype.write.call(this,data,options);this.assertOwned();}
 close(){if(this.lock===null)return;const fd=this.lock;this.lock=null;claimed.delete(fd);fs.closeSync(fd);}
 // writer.lock is PERMANENT. Legacy PrivateStore refuses it even after a crash.
 // No unlink, PID-based stale decision, backup restore or transaction-state mutation.
}
