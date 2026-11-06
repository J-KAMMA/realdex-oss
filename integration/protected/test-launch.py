"""Trusted test harness only. Never referenced from production launcher."""
import importlib.util,os,sys,shutil
from pathlib import Path
sys.dont_write_bytecode=True
root=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('cp_launch',root/'wallet/protected/launch.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
try:
    directory,checkpoint,enroll,mode,*args=sys.argv[1:]
    m.need(Path(directory).name.startswith('realdex-up01-vault-') and Path(checkpoint).name.startswith('realdex-up01-witness-'),'TEST_DIRECTORY')
    fds=m.open_pair(directory,checkpoint,enroll=='yes')
    env={k:os.environ[k] for k in ('PATH','HOME','LANG','TMPDIR') if k in os.environ}
    env.update(REALDEX_PROTECTED_FDS=','.join(map(str,fds)),REALDEX_PROTECTED_MODE='explicit-up01',REALDEX_CP_TEST='disposable-only')
    node=shutil.which('node')
    if mode=='probe':
        command=[node,'--input-type=module','-e',args[0],directory,checkpoint,*args[1:]]
    elif mode=='host':
        command=[node,str(Path(__file__).with_name('host.mjs')),directory,checkpoint]
    else: raise ValueError('CP_TEST_MODE')
    os.execve(node,command,env)
except BaseException as e:
    code=str(e) if isinstance(e,ValueError) and str(e).startswith('CP_') else 'CP_TEST_LAUNCH_FAILED'
    if len(sys.argv)>4 and sys.argv[4]=='host':
        import json
        print(json.dumps({'id':1,'ok':False,'error':'E2E_'+code}),flush=True)
    else: print(code,file=sys.stderr)
    raise SystemExit(1)
