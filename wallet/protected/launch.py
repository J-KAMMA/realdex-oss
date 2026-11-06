#!/usr/bin/env python3
"""UP01: explicitly enrolled Linux checkpoint+lease storage. No existing-Vault migration.
Both owner-only directories must already exist and be EMPTY for --enroll.
Run only this fixed owner entry point; no arbitrary executable, hooks, or lock deletion.
"""
import argparse, ctypes, fcntl, json, os, secrets, shutil, stat, sys
from pathlib import Path

SCHEMA = "realdex.protected-directory.v1"
FILESYSTEMS = {0xEF53, 0x58465342, 0x9123683E, 0x01021994, 0x794C7630}
def need(ok, code):
    if not ok: raise ValueError("CP_" + code)
def safe_directory(name):
    p=Path(name)
    need(p.is_absolute() and '..' not in p.parts and p.resolve()==p and
         not any(x in name for x in '\r\n\x00'), 'DIRECTORY')
    for a in [*reversed(p.parents),p]: need(not a.is_symlink(),'DIRECTORY_LINK')
    fd=os.open(p,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        need(stat.S_ISDIR(s.st_mode) and s.st_uid==os.getuid() and s.st_mode&0o077==0,'DIRECTORY_PERMISSIONS')
        buf=ctypes.create_string_buffer(256);libc=ctypes.CDLL(None,use_errno=True)
        libc.fstatfs.argtypes=[ctypes.c_int,ctypes.c_void_p];libc.fstatfs.restype=ctypes.c_int
        need(libc.fstatfs(fd,ctypes.byref(buf))==0 and ctypes.c_long.from_buffer(buf).value&0xFFFFFFFF in FILESYSTEMS,'FILESYSTEM')
        return p,fd,s
    except BaseException:
        os.close(fd);raise
def regular(s,limit=4096):
    need(stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==os.getuid() and
         s.st_mode&0o077==0 and s.st_size<=limit,'LOCK_FILE')
def open_pair(directory,checkpoint,enroll=False):
    need(sys.platform=='linux' and os.uname().machine=='x86_64','PLATFORM')
    descriptors=[];locks=[]
    try:
        entries=[]
        for x in [directory,checkpoint]:
            p,d,s=safe_directory(x);descriptors.append(d);entries.append((p,d,s))
        a,b=entries
        need(a[0]!=b[0] and a[0] not in b[0].parents and b[0] not in a[0].parents and
             (a[2].st_dev,a[2].st_ino)!=(b[2].st_dev,b[2].st_ino),'SEPARATE_DIRECTORIES')
        if enroll: need(not os.listdir(a[1]) and not os.listdir(b[1]),'ENROLL_EMPTY_REQUIRED')
        for p,d,s in entries:
            flags=os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK
            if enroll: flags|=os.O_CREAT|os.O_EXCL
            f=os.open('writer.lock',flags,0o600,dir_fd=d);locks.append(f);regular(os.fstat(f))
            try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise ValueError('CP_BUSY') from None
            l=os.stat('writer.lock',dir_fd=d,follow_symlinks=False)
            need((l.st_dev,l.st_ino)==(os.fstat(f).st_dev,os.fstat(f).st_ino),'LOCK_CHANGED')
        if enroll:
            pair=secrets.token_hex(32)
            binding={'schema':SCHEMA,'pairId':pair,
                     'vault':{'dev':str(a[2].st_dev),'ino':str(a[2].st_ino)},
                     'checkpoint':{'dev':str(b[2].st_dev),'ino':str(b[2].st_ino)}}
            for i,f in enumerate(locks):
                data=(json.dumps({**binding,'role':['vault','checkpoint'][i]},separators=(',',':'))+'\n').encode()
                need(os.write(f,data)==len(data),'MARKER_WRITE');os.fsync(f);os.fsync(entries[i][1])
            # Initial checkpoint is written ONCE. Its loss can never re-enroll an existing pair.
            record={'schema':'realdex.checkpoint-record.v1','pairId':pair,'phase':'stable',
                    'generation':'0','sha256':None,'bytes':0}
            fd=os.open('checkpoint.json',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=b[1])
            try:
                data=(json.dumps(record,separators=(',',':'))+'\n').encode()
                need(os.write(fd,data)==len(data),'CHECKPOINT_WRITE');os.fsync(fd)
            finally: os.close(fd)
            os.fsync(b[1])
        for i,f in enumerate(locks):
            m=json.loads(os.pread(f,4097,0));need(set(m)=={'schema','pairId','vault','checkpoint','role'},'MARKER')
            need(m['schema']==SCHEMA and m['role']==['vault','checkpoint'][i] and
                 len(m['pairId'])==64 and all(c in '0123456789abcdef' for c in m['pairId']),'MARKER')
            for kind,item in [('vault',a),('checkpoint',b)]:
                need(m[kind]=={'dev':str(item[2].st_dev),'ino':str(item[2].st_ino)},'PAIR_CHANGED')
            if i==0: first=m
            else: need(m['pairId']==first['pairId'],'PAIR_CHANGED')
        for f in locks: os.set_inheritable(f,True)
        return locks
    except BaseException:
        for f in locks: os.close(f)
        raise
    finally:
        for d in descriptors: os.close(d)
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory',required=True);parser.add_argument('--checkpoint',required=True)
    parser.add_argument('--enroll',action='store_true')
    parser.add_argument('--acknowledge-experimental',action='store_true',required=True)
    parser.add_argument('--port',type=int,default=8790)
    args=parser.parse_args();fds=[]
    try:
        need(0<=args.port<=65535,'PORT')
        fds=open_pair(args.directory,args.checkpoint,args.enroll)
        node=shutil.which('node');need(node is not None,'NODE_REQUIRED')
        env={k:os.environ[k] for k in ('PATH','HOME','LANG','TMPDIR') if k in os.environ}
        env.update(REALDEX_PROTECTED_FDS=','.join(map(str,fds)),REALDEX_PROTECTED_MODE='explicit-up01')
        os.execve(node,[node,str(Path(__file__).with_name('owner.mjs')),args.directory,args.checkpoint,str(args.port)],env)
    except BaseException as e:
        for f in fds:
            try: os.close(f)
            except OSError: pass
        print(str(e) if isinstance(e,ValueError) and str(e).startswith('CP_') else 'CP_LAUNCH_FAILED',file=sys.stderr)
        raise SystemExit(1) from None
if __name__=='__main__':main()
