#!/usr/bin/env python3
"""Load a hash-pinned TEST-ONLY LiteSVM wheel without network access or pip.
Run with python3 -I. No package from PYTHONPATH or a .pth file is executed.
"""
import argparse, hashlib, io, json, pathlib, runpy, sys, tempfile, zipfile, signal
BASE = pathlib.Path(__file__).resolve().parent

def checked_toolchain(archive, destination):
    pin = json.loads((BASE / 'toolchain-pin.json').read_text())
    file = pathlib.Path(archive)
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 33554432:
        raise ValueError('SOLANA_TEST_ARCHIVE_INVALID')
    blob = file.read_bytes()
    if hashlib.sha256(blob).hexdigest() != pin['archiveSha256']:
        raise ValueError('SOLANA_TEST_ARCHIVE_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(blob)) as z:
        if z.namelist() != [pin['wheel']]:
            raise ValueError('SOLANA_TEST_ARCHIVE_CONTENT_MISMATCH')
        wheel = z.read(pin['wheel'])
    if hashlib.sha256(wheel).hexdigest() != pin['wheelSha256']:
        raise ValueError('SOLANA_TEST_WHEEL_HASH_MISMATCH')
    with zipfile.ZipFile(io.BytesIO(wheel)) as z:
        names = z.namelist()
        if len(names) != len(set(names)):
            raise ValueError('SOLANA_TEST_WHEEL_DUPLICATE')
        package = {name for name in names if name.startswith('solders/') and not name.endswith('/')}
        if package != set(pin['packageFiles']):
            raise ValueError('SOLANA_TEST_PACKAGE_FILESET_MISMATCH')
        for name in sorted(package):
            rel = pathlib.PurePosixPath(name)
            if '..' in rel.parts or rel.is_absolute():
                raise ValueError('SOLANA_TEST_WHEEL_PATH_INVALID')
            data = z.read(name)
            if hashlib.sha256(data).hexdigest() != pin['packageFiles'][name]:
                raise ValueError('SOLANA_TEST_PACKAGE_HASH_MISMATCH')
            output = destination.joinpath(*rel.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(data)
    return pin

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--archive', required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='realdex-litesvm-pinned-') as tmp:
        pin = checked_toolchain(args.archive, pathlib.Path(tmp))
        if args.check:
            print(json.dumps({'verified': True, 'version': pin['version'], 'packageFiles': len(pin['packageFiles']), 'archiveSha256': pin['archiveSha256']}))
            return
        sys.dont_write_bytecode = True
        sys.path.insert(0, tmp)
        def stop(_signal, _frame):
            raise KeyboardInterrupt
        signal.signal(signal.SIGTERM, stop)
        try:
            runpy.run_path(str(BASE / 'litesvm_rpc.py'), run_name='__main__')
        except KeyboardInterrupt:
            pass  # Leave the TemporaryDirectory context and remove the pinned test package.
if __name__ == '__main__':
    main()
