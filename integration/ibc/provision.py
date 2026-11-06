#!/usr/bin/env python3
"""Extract only two hash-pinned ELF files from the archived diagnostic OCI image. No downloads."""
import argparse, hashlib, io, json, os, pathlib, tarfile, zipfile
PIN=json.loads(pathlib.Path(__file__).with_name('pin.json').read_text())
def checked(data,size,digest):
    if len(data)!=size or hashlib.sha256(data).hexdigest()!=digest:
        raise ValueError('IBC_TOOL_HASH_OR_SIZE_MISMATCH')
    return data

def main():
    p=argparse.ArgumentParser();p.add_argument('--archive',type=pathlib.Path,required=True);p.add_argument('--output',type=pathlib.Path,required=True);a=p.parse_args()
    if a.output.exists():raise ValueError('IBC_OUTPUT_ALREADY_EXISTS')
    raw=checked(a.archive.read_bytes(),PIN['archiveBytes'],PIN['archiveSha256'])
    found={}
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        if z.namelist()!=['simd-image.tar.gz']:raise ValueError('IBC_ARCHIVE_LAYOUT')
        with tarfile.open(fileobj=io.BytesIO(z.read('simd-image.tar.gz')),mode='r:gz') as archive:
            manifest=json.load(archive.extractfile('manifest.json'))
            if len(manifest)!=1:raise ValueError('IBC_IMAGE_COUNT')
            for layer in manifest[0]['Layers']:
                if not layer.startswith('blobs/sha256/') or '..' in layer:raise ValueError('IBC_LAYER_PATH')
                with tarfile.open(fileobj=archive.extractfile(layer),mode='r:') as inner:
                    for member in inner:
                        name=member.name.lstrip('./')
                        if name in ('bin/simd','lib/ld-musl-x86_64.so.1'):
                            if not member.isfile() or name in found:raise ValueError('IBC_ELF_MEMBER')
                            found[name]=inner.extractfile(member).read()
    binary=checked(found['bin/simd'],PIN['binaryBytes'],PIN['binarySha256'])
    loader=checked(found['lib/ld-musl-x86_64.so.1'],PIN['loaderBytes'],PIN['loaderSha256'])
    a.output.mkdir(parents=True,mode=0o700);(a.output/'lib').mkdir(mode=0o700)
    for dest,data in [(a.output/'simd',binary),(a.output/'lib/ld-musl-x86_64.so.1',loader)]:
        with dest.open('xb') as f:f.write(data)
        dest.chmod(0o700)
    print(json.dumps({'binary':str((a.output/'simd').resolve()),'loader':str((a.output/'lib/ld-musl-x86_64.so.1').resolve()),'diagnosticOnly':True}))
if __name__=='__main__':main()
