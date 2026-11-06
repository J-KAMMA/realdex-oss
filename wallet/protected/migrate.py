#!/usr/bin/env python3
"""UP03 protected Vault pair migration. No network, signing or broadcast operations.

The source is frozen after export and cannot be reopened by the protected owner.
There is deliberately no automatic abort after export: complete the import to the
prepared destination and finalize using its signed receipt.
"""
import argparse,getpass,importlib.util,json,os,shutil,sys
from pathlib import Path
spec=importlib.util.spec_from_file_location('cp_launch',Path(__file__).with_name('launch.py'));cp_launch=importlib.util.module_from_spec(spec);spec.loader.exec_module(cp_launch)
open_pair,need=cp_launch.open_pair,cp_launch.need

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['target','export','import','finalize'])
    p.add_argument('--directory',required=True);p.add_argument('--checkpoint',required=True)
    p.add_argument('--enroll',action='store_true')
    p.add_argument('--descriptor');p.add_argument('--package');p.add_argument('--receipt')
    p.add_argument('--acknowledge-experimental',action='store_true',required=True)
    a=p.parse_args();fds=[];read_fd=None
    try:
        need(a.enroll==(a.action=='target'),'MIGRATION_ENROLL_TARGET_ONLY')
        if a.action=='target': need(a.descriptor and not a.package and not a.receipt,'MIGRATION_ARGUMENTS')
        elif a.action=='export': need(a.descriptor and a.package and not a.receipt,'MIGRATION_ARGUMENTS')
        elif a.action=='import': need(a.package and a.receipt and not a.descriptor,'MIGRATION_ARGUMENTS')
        else: need(a.receipt and not a.package and not a.descriptor,'MIGRATION_ARGUMENTS')
        fds=open_pair(a.directory,a.checkpoint,a.enroll)
        node=shutil.which('node');need(node is not None,'NODE_REQUIRED')
        env={k:os.environ[k] for k in ('PATH','HOME','LANG','TMPDIR') if k in os.environ}
        env.update(REALDEX_PROTECTED_FDS=','.join(map(str,fds)),REALDEX_PROTECTED_MODE='explicit-up01')
        args=[node,str(Path(__file__).with_name('migration-cli.mjs')),a.action,a.directory,a.checkpoint]
        if a.action=='target': args+=[str(Path(a.descriptor).resolve())]
        elif a.action=='export': args+=[str(Path(a.descriptor).resolve()),str(Path(a.package).resolve())]
        elif a.action=='import': args+=[str(Path(a.package).resolve()),str(Path(a.receipt).resolve())]
        else: args+=[str(Path(a.receipt).resolve())]
        if a.action in ('export','import'):
            password=getpass.getpass('Vault password: ')
            r,w=os.pipe();os.set_inheritable(r,True);os.write(w,json.dumps(password).encode());os.close(w);password='';read_fd=r;env['REALDEX_MIGRATION_PASSWORD_FD']=str(r)
        os.execve(node,args,env)
    except BaseException as e:
        for f in fds:
            try: os.close(f)
            except OSError: pass
        if read_fd is not None:
            try: os.close(read_fd)
            except OSError: pass
        print(str(e) if isinstance(e,ValueError) and str(e).startswith('CP_') else 'CP_MIGRATION_LAUNCH_FAILED',file=sys.stderr)
        raise SystemExit(1) from None
if __name__=='__main__':main()
