#!/usr/bin/env python3
"""Provision the five EXISTING pinned diagnostic runtimes, without changing pins.

Offline: --archives DIRECTORY containing bitcoin.zip, cosmos.zip, aptos.zip,
ibc.zip and solana.zip. Network: --download explicitly requests public upstream
Actions artifacts through nightly.link. No token, user repository or secrets are
sent. Download availability is not identity: both archive and binary hashes are
checked before any runtime can be used. No unpinned fallback or execution.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPECS = {
    'bitcoin': ('bitcoin-core/HWI', 9584237798, 115135497),
    'cosmos': ('cosmos/cosmos-sdk', 9934164663, 79879276),
    'aptos': ('aptos-labs/aptos-cli-releases', 9588053995, 46861083),
    'ibc': ('cosmos/ibc-go', 9953158387, 46064515),
    'solana': ('kevinheavey/solders', 9190506809, 11794793),
}


def require(condition: bool, code: str) -> None:
    if not condition:
        raise ValueError(code)


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pin_for(kind: str) -> dict:
    require(kind in SPECS, 'RUNTIME_KIND')
    name = 'toolchain-pin.json' if kind == 'solana' else 'pin.json'
    return json.loads((ROOT / 'integration' / kind / name).read_text())


def checked(data: bytes, size: int, digest: str) -> bytes:
    require(len(data) == size and sha(data) == digest, 'RUNTIME_HASH_OR_SIZE')
    return data


def no_symlinks(p: Path) -> Path:
    p = p.absolute()
    require(not any(c in str(p) for c in '\r\n\x00'), 'RUNTIME_PATH')
    require('..' not in p.parts, 'RUNTIME_PATH')
    for part in [*reversed(p.parents), p]:
        try:
            require(not part.is_symlink(), 'RUNTIME_SYMLINK')
        except OSError as error:
            raise ValueError('RUNTIME_PATH') from error
    return p


def read_archive(p: Path, size: int, digest: str) -> bytes:
    p = no_symlinks(p)
    s = p.lstat()
    require(stat.S_ISREG(s.st_mode) and s.st_nlink == 1 and s.st_size == size,
            'RUNTIME_ARCHIVE_FILE')
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as f:
        opened = os.fstat(f.fileno())
        require((opened.st_dev, opened.st_ino, opened.st_size) ==
                (s.st_dev, s.st_ino, size), 'RUNTIME_ARCHIVE_CHANGED')
        return checked(f.read(size + 1), size, digest)


def write_new(p: Path, data: bytes, mode: int = 0o400) -> None:
    with p.open('xb') as f:
        os.fchmod(f.fileno(), mode)
        f.write(data)
        f.flush()
        os.fsync(f.fileno())


def zip_member(raw: bytes, member: str, names: set[str], max_bytes: int) -> bytes:
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        require(len(z.namelist()) == len(names) and set(z.namelist()) == names,
                'RUNTIME_ZIP_LAYOUT')
        item = z.getinfo(member)
        require(not stat.S_ISLNK(item.external_attr >> 16) and
                0 < item.file_size <= max_bytes, 'RUNTIME_ZIP_MEMBER')
        return z.read(member)


def extract_binary(kind: str, raw: bytes, pin: dict) -> bytes:
    """Only used AFTER outer hash validation. Never extract archive paths."""
    if kind == 'cosmos':
        binary = zip_member(raw, 'simd-linux-amd64', {
            'simd-linux-amd64', 'simd-linux-amd64.tar.gz',
            'simd-linux-amd64.tar.gz.sha256'}, pin['bytes'])
    elif kind == 'bitcoin':
        nested = zip_member(raw, 'bitcoind.tar.gz', {'bitcoind.tar.gz'}, 140000000)
        with tarfile.open(fileobj=io.BytesIO(nested), mode='r:gz') as t:
            members = t.getmembers()
            require(len(members) == 1 and members[0].name ==
                    'test/work/bitcoin/build/bin/bitcoind' and
                    members[0].isfile() and members[0].size == pin['bytes'],
                    'RUNTIME_TAR_LAYOUT')
            binary = t.extractfile(members[0]).read(pin['bytes'] + 1)
    else:
        raise ValueError('RUNTIME_EXTRACTION_KIND')
    return checked(binary, pin['bytes'], pin['sha256'])


def safe_download_url(url: str) -> str:
    u = urllib.parse.urlsplit(url)
    host = u.hostname or ''
    require(u.scheme == 'https' and not u.username and not u.password and
            u.port in (None, 443) and not u.fragment and
            (host in ('nightly.link', 'api.github.com', 'github.com') or
             host.endswith('.blob.core.windows.net') or
             host.endswith('.githubusercontent.com') or
             host.endswith('.actions.githubusercontent.com')),
            'RUNTIME_DOWNLOAD_HOST')
    return url


class HttpsRedirect(urllib.request.HTTPRedirectHandler):
    max_redirections = 4
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_download_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(kind: str, directory: Path) -> Path:
    repo, artifact_id, size = SPECS[kind]
    pin = pin_for(kind)
    url = safe_download_url(f'https://nightly.link/{repo}/actions/artifacts/{artifact_id}.zip')
    # No credentials and no mutable latest/version URL. Never log signed redirects.
    opener = urllib.request.build_opener(HttpsRedirect())
    target = directory / (kind + '.zip')
    h = hashlib.sha256()
    total = 0
    deadline = time.monotonic() + 300
    try:
        with opener.open(url, timeout=60) as response, target.open('xb') as f:
            os.fchmod(f.fileno(), 0o400)
            require(response.status == 200, 'RUNTIME_DOWNLOAD_STATUS')
            require(response.headers.get('Content-Length') in (None, str(size)), 'RUNTIME_DOWNLOAD_LENGTH')
            read = getattr(response, 'read1', response.read)
            while chunk := read(1048576):
                require(time.monotonic() <= deadline, 'RUNTIME_DOWNLOAD_TIMEOUT')
                total += len(chunk)
                require(total <= size, 'RUNTIME_DOWNLOAD_OVERSIZED')
                h.update(chunk)
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        require(total == size and h.hexdigest() == pin['archiveSha256'],
                'RUNTIME_DOWNLOAD_INTEGRITY')
        return target
    except Exception as error:
        # Keep incomplete evidence, fail closed; do not expose URLs/tokens in errors.
        raise ValueError('RUNTIME_DOWNLOAD_FAILED_' + kind.upper()) from error


def provision_one(kind: str, archive: Path, output: Path) -> tuple[dict, dict]:
    pin = pin_for(kind)
    repo, artifact_id, size = SPECS[kind]
    raw = read_archive(archive, size, pin['archiveSha256'])
    destination = output / kind
    env: dict[str, str] = {}
    if kind in ('bitcoin', 'cosmos'):
        binary = extract_binary(kind, raw, pin)
        destination.mkdir(mode=0o700)
        target = destination / ('bitcoind' if kind == 'bitcoin' else 'simd')
        write_new(target, binary, 0o500)
        env['REALDEX_BITCOIND_BINARY' if kind == 'bitcoin' else 'REALDEX_SIMD_BINARY'] = str(target)
    elif kind in ('aptos', 'ibc'):
        result = subprocess.run([sys.executable, '-I', str(ROOT / 'integration' / kind / 'provision.py'),
                                 '--archive', str(archive), '--output', str(destination)],
                                capture_output=True, timeout=120, check=False)
        require(result.returncode == 0, 'RUNTIME_EXISTING_PROVISIONER_FAILED')
        if kind == 'aptos':
            target = destination / 'aptos'
            read_archive(target, pin['bytes'], pin['sha256'])
            env['REALDEX_APTOS_BINARY'] = str(target)
        else:
            for name, size_key, hash_key in [('simd', 'binaryBytes', 'binarySha256'),
                                            ('lib/ld-musl-x86_64.so.1', 'loaderBytes', 'loaderSha256')]:
                read_archive(destination / name, pin[size_key], pin[hash_key])
            env['REALDEX_IBC_SIMD_BINARY'] = str(destination / 'simd')
            env['REALDEX_IBC_MUSL_LOADER'] = str(destination / 'lib/ld-musl-x86_64.so.1')
    else:
        destination.mkdir(mode=0o700)
        target = destination / 'toolchain.zip'
        write_new(target, raw)
        result = subprocess.run([sys.executable, '-I', str(ROOT / 'integration/solana/pinned_runtime.py'),
                                 '--archive', str(target), '--check'],
                                capture_output=True, timeout=120, check=False)
        require(result.returncode == 0, 'RUNTIME_SOLANA_PACKAGE_FAILED')
        env['REALDEX_SOLANA_TEST_ARCHIVE'] = str(target)
    receipt = {'kind': kind, 'upstreamRepository': repo, 'artifactId': artifact_id,
               'archiveBytes': len(raw), 'archiveSha256': sha(raw),
               'pin': pin, 'verified': True, 'executed': False, 'testOnly': True}
    return receipt, env


def provision(output: Path, archives: Path | None = None, network: bool = False) -> dict:
    require(sys.platform == 'linux' and os.uname().machine == 'x86_64', 'RUNTIME_PLATFORM')
    require((archives is not None) != network, 'RUNTIME_EXPLICIT_INPUT')
    output = no_symlinks(output)
    require(not output.exists(), 'RUNTIME_OUTPUT_EXISTS')
    require(output.parent.is_dir(), 'RUNTIME_OUTPUT_PARENT')
    output.mkdir(mode=0o700)
    if network:
        archive_dir = output / 'archives'
        archive_dir.mkdir(mode=0o700)
        with ThreadPoolExecutor(max_workers=3) as pool:
            list(pool.map(lambda k: download(k, archive_dir), SPECS))
    else:
        archive_dir = no_symlinks(archives)
    receipts, environment = [], {}
    for kind in SPECS:
        receipt, values = provision_one(kind, archive_dir / (kind + '.zip'), output)
        receipts.append(receipt)
        environment.update(values)
    result = {'schema': 'realdex.runtime-provision.v1', 'verified': True,
              'executed': False, 'productionApproved': False, 'tools': receipts,
              'transport': 'explicit-public-artifact-proxy' if network else 'offline-archives'}
    write_new(output / 'provision.json', (json.dumps(result, indent=2) + '\n').encode())
    write_new(output / 'environment.json', (json.dumps(environment, indent=2) + '\n').encode())
    write_new(output / 'github.env', ''.join(f'{k}={v}\n' for k, v in environment.items()).encode())
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--archives', type=Path)
    source.add_argument('--download', action='store_true')
    args = parser.parse_args()
    try:
        result = provision(args.output, args.archives, args.download)
        print(json.dumps(result, indent=2))
    except Exception as error:
        code = str(error) if isinstance(error, ValueError) and str(error).startswith('RUNTIME_') else 'RUNTIME_PROVISION_FAILED'
        print(json.dumps({'verified': False, 'error': code}))
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
