#!/usr/bin/env python3
"""Extract the exact official auxiliary compiler artifact. No network, execution or overwrite."""
import argparse, hashlib, json, os, stat, zipfile
from pathlib import Path
PIN = json.loads((Path(__file__).with_name('experimental-pin.json')).read_text())

def provision(archive: Path, output: Path) -> dict:
    source = archive.read_bytes()
    if hashlib.sha256(source).hexdigest() != PIN['archiveSha256']:
        raise ValueError('EXPERIMENTAL_ARCHIVE_HASH_MISMATCH')
    with zipfile.ZipFile(archive) as z:
        members = z.infolist()
        if len(members) != 1 or members[0].filename != 'soljson.js' or members[0].file_size != PIN['bytes']:
            raise ValueError('EXPERIMENTAL_ARCHIVE_CONTENT_INVALID')
        mode = members[0].external_attr >> 16
        if stat.S_ISLNK(mode):
            raise ValueError('EXPERIMENTAL_ARCHIVE_SYMLINK')
        data = z.read(members[0])
    if hashlib.sha256(data).hexdigest() != PIN['sha256']:
        raise ValueError('EXPERIMENTAL_COMPILER_HASH_MISMATCH')
    blob = b'blob ' + str(len(data)).encode() + b'\x00' + data
    if hashlib.sha1(blob).hexdigest() != PIN['gitBlobSha1']:
        raise ValueError('EXPERIMENTAL_GIT_BLOB_MISMATCH')
    # Parent choice is operator-controlled. Avoid symlinks and never overwrite a file.
    output = output.absolute()
    for parent in [output, *output.parents]:
        if parent.is_symlink():
            raise ValueError('EXPERIMENTAL_OUTPUT_SYMLINK')
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    return {'experimentalOnly': True, 'productionCompilerGateSatisfied': False,
            'version': PIN['version'], 'bytes': len(data), 'sha256': PIN['sha256'], 'output': str(output)}

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--archive', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(provision(a.archive, a.output), ensure_ascii=False, indent=2))
