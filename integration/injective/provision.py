#!/usr/bin/env python3
"""Verify the fixed official archive BEFORE extracting only the two diagnostic runtime files."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import zipfile

PIN = json.loads(Path(__file__).with_name('pin.json').read_text())

def need(value, code):
    if not value:
        raise ValueError(code)

def provision(archive, output):
    need(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'INJ_RUNTIME_PLATFORM')
    archive, output = Path(archive).absolute(), Path(output).absolute()
    need(archive.resolve() == archive and output.parent.resolve() == output.parent, 'INJ_RUNTIME_SYMLINK')
    need(not output.exists() and not output.is_symlink(), 'INJ_RUNTIME_OUTPUT_EXISTS')
    st = archive.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_nlink == 1 and st.st_size == PIN['archiveBytes'], 'INJ_RUNTIME_ARCHIVE_FILE')
    fd = os.open(archive, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        opened = os.fstat(f.fileno())
        need((opened.st_dev, opened.st_ino, opened.st_size) == (st.st_dev, st.st_ino, st.st_size), 'INJ_RUNTIME_INPUT_CHANGED')
        h = hashlib.file_digest(f, 'sha256').hexdigest()
        need(h == PIN['archiveSha256'], 'INJ_RUNTIME_ARCHIVE_HASH')
        f.seek(0)
        with zipfile.ZipFile(f) as z:
            need(len(z.namelist()) == 3 and set(z.namelist()) == {'injectived', 'peggo', 'libwasmvm.x86_64.so'}, 'INJ_RUNTIME_LAYOUT')
            verified = {}
            for name, pin in PIN['files'].items():
                entry = z.getinfo(name)
                need(not stat.S_ISLNK(entry.external_attr >> 16) and entry.file_size == pin['bytes'], 'INJ_RUNTIME_MEMBER')
                data = z.read(name)
                need(hashlib.sha256(data).hexdigest() == pin['sha256'], 'INJ_RUNTIME_BINARY_HASH')
                verified[name] = data
    # No output exists before all selected bytes have been validated.
    output.mkdir(mode=0o700)
    for name, data in verified.items():
        with (output / name).open('xb') as f:
            os.fchmod(f.fileno(), 0o500)
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
    receipt = {'schema': 'realdex.injective-local-provision.v1', 'pin': PIN, 'verified': True, 'executed': False, 'productionApproved': False}
    (output / 'provision.json').write_text(json.dumps(receipt, indent=2) + '\n')
    return receipt

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(provision(args.archive, args.output), indent=2))
    except Exception as error:
        print(json.dumps({'verified': False, 'error': str(error) if isinstance(error, ValueError) else 'INJ_RUNTIME_PROVISION_FAILED'}))
        sys.exit(1)
