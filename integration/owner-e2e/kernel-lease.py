#!/usr/bin/env python3
"""Linux-only experimental launcher. A persistent inode + kernel flock, never lock deletion.
Only NEW disposable E2E08 directories can be enrolled; no migration/recovery of user Vaults.
The owner process inherits the lease across exec; no lease-holding supervisor survives it.
"""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import shutil
import stat
import sys

MARKER = b'realdex.experimental.kernel-lease.v1\n'
# Explicit local Linux filesystem types. This is not NFS/SMB or power-loss certification.
LOCAL_FS = {0xEF53, 0x58465342, 0x9123683E, 0x01021994, 0x794C7630}

def need(ok, code):
    if not ok:
        raise ValueError('E2E_KERNEL_' + code)

def private(s, directory=False):
    need((stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode) and s.st_nlink == 1)
         and s.st_uid == os.getuid() and s.st_mode & 0o077 == 0, 'UNSAFE_FILE')

def prepare(directory):
    need(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'PLATFORM')
    p = Path(directory)
    need(p.is_absolute() and '..' not in p.parts and p.name.startswith('realdex-e2e08-vault-')
         and not any(c in directory for c in '\r\n\x00') and p.resolve() == p, 'DISPOSABLE_DIRECTORY')
    # Existing real directory only. No symlink ancestors or implicit home-directory default.
    for a in [*reversed(p.parents), p]:
        need(not a.is_symlink(), 'DIRECTORY_LINK')
    d = os.open(p, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        ds = os.fstat(d); private(ds, True)
        need((ds.st_dev, ds.st_ino) == (p.lstat().st_dev, p.lstat().st_ino), 'DIRECTORY_CHANGED')
        buf = ctypes.create_string_buffer(256)
        libc = ctypes.CDLL(None, use_errno=True)
        libc.fstatfs.argtypes = [ctypes.c_int, ctypes.c_void_p]
        libc.fstatfs.restype = ctypes.c_int
        need(libc.fstatfs(d, ctypes.byref(buf)) == 0, 'FILESYSTEM_UNKNOWN')
        magic = ctypes.c_long.from_buffer(buf).value & 0xFFFFFFFF
        need(magic in LOCAL_FS, 'FILESYSTEM_UNSUPPORTED')
        existing = os.listdir(d)
        if 'writer.lock' not in existing:
            need(not existing, 'NEW_DIRECTORY_REQUIRED')
            try:
                fd = os.open('writer.lock', os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=d)
                created = True
            except FileExistsError:
                created = False
        else:
            created = False
        if fd is None:
            fd = os.open('writer.lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=d)
        ls = os.fstat(fd); private(ls)
        need(ls.st_size <= 128, 'LOCK_FORMAT')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('E2E_KERNEL_BUSY') from None
        current = os.stat('writer.lock', dir_fd=d, follow_symlinks=False)
        private(current)
        need((current.st_dev, current.st_ino) == (ls.st_dev, ls.st_ino), 'LOCK_CHANGED')
        if created:
            need(os.write(fd, MARKER) == len(MARKER), 'MARKER_WRITE')
            os.fsync(fd); os.fsync(d)
        need(os.pread(fd, 129, 0) == MARKER, 'LOCK_FORMAT')
        # A crash during first marker initialization fails closed; it is never guessed/repaired.
        os.set_inheritable(fd, True)
        return fd
    except BaseException:
        if fd is not None:
            os.close(fd)
        raise
    finally:
        os.close(d)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args()
    fd = None
    try:
        need(os.environ.get('REALDEX_E2E08_CHILD') == 'disposable-only', 'EXPLICIT_TEST_MODE')
        fd = prepare(args.directory)
        node = shutil.which('node')
        need(node is not None, 'NODE_MISSING')
        # Do not carry NODE_OPTIONS, NODE_PATH, proxy credentials, or runtime secrets.
        env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'TMPDIR') if k in os.environ}
        env.update(REALDEX_E2E08_CHILD='disposable-only', REALDEX_KERNEL_LEASE_FD=str(fd))
        host = Path(__file__).with_name('kernel-host.mjs')
        os.execve(node, [node, str(host), args.directory], env)
    except BaseException as error:
        if fd is not None:
            os.close(fd)
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('E2E_KERNEL_') else 'E2E_KERNEL_LAUNCH_FAILED'
        print(json.dumps({'id': 1, 'ok': False, 'error': code}), flush=True)
        raise SystemExit(1) from None

if __name__ == '__main__':
    main()
