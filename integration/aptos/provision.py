#!/usr/bin/env python3
"""Copy one pinned Aptos test binary from an already downloaded archive.
No download, command execution, arbitrary archive extraction, or overwrite.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import zipfile

PIN = json.loads(Path(__file__).with_name('pin.json').read_text())

def provision(archive: Path, output: Path) -> dict:
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size > 64000000:
        raise ValueError('APTOS_ARCHIVE_UNSAFE')
    data = archive.read_bytes()
    if hashlib.sha256(data).hexdigest() != PIN['archiveSha256']:
        raise ValueError('APTOS_ARCHIVE_HASH_MISMATCH')
    nested = 'aptos-cli-9.5.1-x86_64-unknown-linux-gnu.zip'
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if z.namelist() != [nested] or z.getinfo(nested).file_size > 64000000:
            raise ValueError('APTOS_ARCHIVE_CONTENT_INVALID')
        inner = z.read(nested)
    with zipfile.ZipFile(io.BytesIO(inner)) as z:
        if z.namelist() != ['aptos']:
            raise ValueError('APTOS_INNER_CONTENT_INVALID')
        info = z.getinfo('aptos')
        if stat.S_ISLNK(info.external_attr >> 16) or info.file_size != PIN['bytes']:
            raise ValueError('APTOS_BINARY_UNSAFE')
        binary = z.read('aptos')
    if len(binary) != PIN['bytes'] or hashlib.sha256(binary).hexdigest() != PIN['sha256']:
        raise ValueError('APTOS_BINARY_HASH_MISMATCH')
    output = output.absolute()
    if any(p.is_symlink() for p in [output, *output.parents]):
        raise ValueError('APTOS_OUTPUT_SYMLINK')
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    target = output / 'aptos'
    with target.open('xb') as f:
        os.chmod(target, 0o500)
        f.write(binary)
        f.flush()
        os.fsync(f.fileno())
    result = {'verified': True, 'executed': False, 'testOnly': True,
              'version': PIN['version'], 'archiveSha256': PIN['archiveSha256'],
              'sha256': PIN['sha256'], 'bytes': len(binary)}
    (output / 'provision.json').write_text(json.dumps(result, indent=2) + '\n')
    return result

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    try:
        print(json.dumps(provision(args.archive, args.output), indent=2))
    except Exception as e:
        message = str(e) if isinstance(e, ValueError) and str(e).startswith('APTOS_') else 'APTOS_PROVISION_FAILED'
        print(json.dumps({'verified': False, 'error': message}))
        raise SystemExit(2)
