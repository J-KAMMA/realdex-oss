#!/usr/bin/env python3
"""Verify a previously obtained official test-tool archive and copy only the pinned Anvil.
No download, execution, shell, user secrets, arbitrary tar extraction or file overwrite.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import tarfile
import zipfile

PIN = json.loads(Path(__file__).with_name('pin.json').read_text())
def sha(data):
    return hashlib.sha256(data).hexdigest()

def provision(archive: Path, output: Path):
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 160_000_000:
        raise ValueError('TEST_TOOL_ARCHIVE_UNSAFE')
    data = archive.read_bytes()
    digest = sha(data)
    if digest == PIN['archiveSha256']:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            if names != ['foundry_nightly_linux_amd64.tar.gz']:
                raise ValueError('TEST_TOOL_ZIP_CONTENT_INVALID')
            data = z.read(names[0])
    elif digest != PIN['tarSha256']:
        raise ValueError('TEST_TOOL_ARCHIVE_HASH_MISMATCH')
    if sha(data) != PIN['tarSha256']:
        raise ValueError('TEST_TOOL_TAR_HASH_MISMATCH')
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as t:
        members = [m for m in t.getmembers() if m.name == 'anvil']
        if len(members) != 1 or not members[0].isfile() or members[0].size != PIN['bytes']:
            raise ValueError('TEST_TOOL_MEMBER_INVALID')
        with t.extractfile(members[0]) as f:
            binary = f.read(PIN['bytes'] + 1)
    if len(binary) != PIN['bytes'] or sha(binary) != PIN['sha256']:
        raise ValueError('TEST_TOOL_EXECUTABLE_HASH_MISMATCH')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    file = output / 'anvil'
    with file.open('xb') as f:
        os.chmod(file, 0o500)
        f.write(binary)
        f.flush()
        os.fsync(f.fileno())
    result = {'schema':'realdex.anvil-provision.v1','verified':True,'executed':False,
              'archiveSha256':digest,'anvilSha256':PIN['sha256'],'commit':PIN['commit']}
    (output/'provision.json').write_text(json.dumps(result, indent=2)+'\n')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(provision(args.archive, args.output), indent=2))
    except Exception as e:
        # Do not print arbitrary paths/environment values.
        print(json.dumps({'verified':False,'error':str(e) if isinstance(e,ValueError) else 'TEST_TOOL_PROVISION_FAILED'}))
        raise SystemExit(2)
