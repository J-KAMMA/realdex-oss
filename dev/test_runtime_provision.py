"""Synthetic extraction/transport fault tests; no network or third-party runtime execution."""
import importlib.util
from pathlib import Path
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zipfile

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('runtime_provision', Path(__file__).with_name('runtime-provision.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def zipped(entries):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
        for key, value in entries:
            z.writestr(key, value)
    return output.getvalue()


def cosmos_fixture(binary=b'fake ELF, never executed'):
    raw = zipped([('simd-linux-amd64', binary), ('simd-linux-amd64.tar.gz', b'ignored'),
                  ('simd-linux-amd64.tar.gz.sha256', b'ignored')])
    pin = {'bytes': len(binary), 'sha256': m.sha(binary), 'archiveSha256': m.sha(raw)}
    return binary, raw, pin


class ProvisionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_exact_hash(self):
        self.assertEqual(m.checked(b'ok', 2, m.sha(b'ok')), b'ok')

    def test_wrong_hash(self):
        with self.assertRaisesRegex(ValueError, 'HASH_OR_SIZE'):
            m.checked(b'ok', 2, 'f' * 64)

    def test_wrong_size(self):
        with self.assertRaises(ValueError):
            m.checked(b'ok', 1, m.sha(b'ok'))

    def test_real_regular_file_read(self):
        p = self.root / 'input'; p.write_bytes(b'abc')
        self.assertEqual(m.read_archive(p, 3, m.sha(b'abc')), b'abc')

    def test_corrupt_file_rejected(self):
        p = self.root / 'input'; p.write_bytes(b'abc')
        with self.assertRaises(ValueError): m.read_archive(p, 3, m.sha(b'bad'))

    def test_symlink_file_rejected(self):
        p = self.root / 'input'; p.write_bytes(b'abc')
        q = self.root / 'link'; q.symlink_to(p)
        with self.assertRaisesRegex(ValueError, 'SYMLINK'): m.read_archive(q, 3, m.sha(b'abc'))

    def test_parent_symlink_rejected(self):
        p = self.root / 'input'; p.mkdir(); (p/'data').write_bytes(b'abc')
        q = self.root / 'link'; q.symlink_to(p)
        with self.assertRaisesRegex(ValueError, 'SYMLINK'): m.read_archive(q/'data', 3, m.sha(b'abc'))

    def test_hardlink_rejected(self):
        p = self.root/'data'; p.write_bytes(b'abc'); os.link(p, self.root/'alias')
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_FILE'): m.read_archive(p, 3, m.sha(b'abc'))

    def test_fifo_rejected_without_blocking(self):
        p = self.root/'fifo'; os.mkfifo(p)
        with self.assertRaisesRegex(ValueError, 'ARCHIVE_FILE'): m.read_archive(p, 0, m.sha(b''))

    def test_directory_rejected(self):
        with self.assertRaises(ValueError): m.read_archive(self.root, 0, m.sha(b''))

    def test_private_exclusive_output(self):
        p = self.root/'out'; m.write_new(p, b'abc', 0o500)
        self.assertEqual(stat.S_IMODE(p.stat().st_mode), 0o500)
        with self.assertRaises(FileExistsError): m.write_new(p, b'def')
        self.assertEqual(p.read_bytes(), b'abc')

    def test_only_existing_kind_accepted(self):
        with self.assertRaisesRegex(ValueError, 'KIND'): m.pin_for('new-unpinned-runtime')

    def test_cosmos_reads_only_selected_binary(self):
        binary, raw, pin = cosmos_fixture()
        self.assertEqual(m.extract_binary('cosmos', raw, pin), binary)

    def test_binary_hash_is_independent_of_archive_hash(self):
        _, raw, pin = cosmos_fixture(); pin['sha256']='f'*64
        with self.assertRaisesRegex(ValueError, 'HASH_OR_SIZE'): m.extract_binary('cosmos', raw, pin)

    def test_unknown_member_rejected(self):
        raw = zipped([('good',b'abc'),('../escape',b'bad')])
        with self.assertRaisesRegex(ValueError, 'ZIP_LAYOUT'): m.zip_member(raw,'good',{'good'},3)
        self.assertFalse((self.root.parent/'escape').exists())

    def test_duplicate_member_rejected(self):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            raw = zipped([('good',b'abc'),('good',b'bad')])
        with self.assertRaisesRegex(ValueError,'ZIP_LAYOUT'):m.zip_member(raw,'good',{'good'},3)

    def test_oversized_zip_member_rejected(self):
        with self.assertRaisesRegex(ValueError,'ZIP_MEMBER'):m.zip_member(zipped([('a',b'xxxx')]),'a',{'a'},3)

    def test_zip_symlink_rejected(self):
        item=zipfile.ZipInfo('a'); item.create_system=3; item.external_attr=(stat.S_IFLNK|0o777)<<16
        with self.assertRaisesRegex(ValueError,'ZIP_MEMBER'):m.zip_member(zipped([(item,b'dest')]),'a',{'a'},10)

    def bitcoin_tar(self, name, type=tarfile.REGTYPE):
        b=io.BytesIO();binary=b'fake core, never executed'
        with tarfile.open(fileobj=b,mode='w:gz') as t:
            info=tarfile.TarInfo(name);info.type=type;info.size=len(binary) if type==tarfile.REGTYPE else 0
            t.addfile(info,io.BytesIO(binary) if type==tarfile.REGTYPE else None)
        return zipped([('bitcoind.tar.gz',b.getvalue())]),{'bytes':len(binary),'sha256':m.sha(binary)},binary

    def test_bitcoin_exact_member(self):
        raw,pin,binary=self.bitcoin_tar('test/work/bitcoin/build/bin/bitcoind')
        self.assertEqual(m.extract_binary('bitcoin',raw,pin),binary)

    def test_bitcoin_path_traversal(self):
        raw,pin,_=self.bitcoin_tar('../bitcoind')
        with self.assertRaisesRegex(ValueError,'TAR_LAYOUT'):m.extract_binary('bitcoin',raw,pin)

    def test_bitcoin_nonregular(self):
        raw,pin,_=self.bitcoin_tar('test/work/bitcoin/build/bin/bitcoind',tarfile.SYMTYPE)
        with self.assertRaisesRegex(ValueError,'TAR_LAYOUT'):m.extract_binary('bitcoin',raw,pin)

    def test_provision_verifies_outer_before_extracting(self):
        p=self.root/'cosmos.zip';p.write_bytes(b'corrupt')
        _,_,pin=cosmos_fixture()
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,7)}),patch.object(m,'pin_for',return_value=pin),patch.object(m,'extract_binary') as extract:
            with self.assertRaisesRegex(ValueError,'HASH_OR_SIZE'):m.provision_one('cosmos',p,self.root)
            extract.assert_not_called()

    def test_provision_validates_output_and_never_executes_binary(self):
        binary,raw,pin=cosmos_fixture();p=self.root/'cosmos.zip';p.write_bytes(raw)
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,len(raw))}),patch.object(m,'pin_for',return_value=pin),patch.object(m.subprocess,'run') as run:
            receipt,env=m.provision_one('cosmos',p,self.root)
            self.assertFalse(receipt['executed']);self.assertEqual(Path(env['REALDEX_SIMD_BINARY']).read_bytes(),binary)
            run.assert_not_called()

    def test_existing_provisioner_failure_rejected(self):
        raw=b'not executed';p=self.root/'aptos.zip';p.write_bytes(raw)
        pin={'archiveSha256':m.sha(raw)}
        with patch.dict(m.SPECS,{'aptos':('aptos-labs/aptos-cli-releases',1,len(raw))}),patch.object(m,'pin_for',return_value=pin),patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],1)):
            with self.assertRaisesRegex(ValueError,'PROVISIONER_FAILED'):m.provision_one('aptos',p,self.root)

    def test_no_mode_is_rejected(self):
        with self.assertRaisesRegex(ValueError,'EXPLICIT_INPUT'):m.provision(self.root/'out')

    def test_two_modes_are_rejected(self):
        with self.assertRaisesRegex(ValueError,'EXPLICIT_INPUT'):m.provision(self.root/'out',self.root,True)

    def test_output_is_never_reused(self):
        with self.assertRaisesRegex(ValueError,'OUTPUT_EXISTS'):m.provision(self.root,self.root)

    def test_missing_parent_rejected(self):
        with self.assertRaisesRegex(ValueError,'OUTPUT_PARENT'):m.provision(self.root/'missing'/'out',self.root)

    def test_failure_never_writes_environment(self):
        out=self.root/'out'
        with self.assertRaises(Exception):m.provision(out,self.root)
        self.assertFalse((out/'environment.json').exists());self.assertFalse((out/'github.env').exists())

    def test_newline_path_rejected(self):
        with self.assertRaisesRegex(ValueError,'PATH'):m.no_symlinks(self.root/'a\nb')

    def test_parent_escape_rejected(self):
        with self.assertRaisesRegex(ValueError,'PATH'):m.no_symlinks(self.root/'..'/'b')

    def test_expected_https_redirects_accepted(self):
        for host in ['nightly.link','api.github.com','github.com','productionresultssa1.blob.core.windows.net','objects.githubusercontent.com']:
            url=f'https://{host}/public-artifact?sig=not-a-real-secret'
            self.assertEqual(m.safe_download_url(url),url)

    def test_redirect_hosts_rejected(self):
        for url in ['http://nightly.link/a','https://nightly.link.evil/a','https://127.0.0.1/a','file:///etc/passwd','https://user:secret@nightly.link/a','https://nightly.link:444/a']:
            with self.subTest(url=url),self.assertRaises(ValueError):m.safe_download_url(url)

    def test_download_rejects_bad_integrity_without_exposing_url(self):
        class Response(io.BytesIO):
            status=200
            headers={'Content-Length':'3'}
        class Opener:
            def open(self,url,timeout):return Response(b'bad')
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,3)}),patch.object(m,'pin_for',return_value={'archiveSha256':m.sha(b'ok!')}),patch.object(m.urllib.request,'build_opener',return_value=Opener()):
            with self.assertRaisesRegex(ValueError,'^RUNTIME_DOWNLOAD_FAILED_COSMOS$'):m.download('cosmos',self.root)

    def test_download_success_still_nonexecutable(self):
        class Response(io.BytesIO):
            status=200
            headers={}
        class Opener:
            def open(self,url,timeout):return Response(b'ok!')
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,3)}),patch.object(m,'pin_for',return_value={'archiveSha256':m.sha(b'ok!')}),patch.object(m.urllib.request,'build_opener',return_value=Opener()):
            p=m.download('cosmos',self.root);self.assertEqual(p.read_bytes(),b'ok!');self.assertEqual(stat.S_IMODE(p.stat().st_mode),0o400)

    def test_download_oversize_rejected(self):
        class Response(io.BytesIO):
            status=200
            headers={}
        class Opener:
            def open(self,url,timeout):return Response(b'oversized')
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,3)}),patch.object(m,'pin_for',return_value={'archiveSha256':m.sha(b'bad')}),patch.object(m.urllib.request,'build_opener',return_value=Opener()):
            with self.assertRaises(ValueError):m.download('cosmos',self.root)

    def test_download_deadline_rejected(self):
        class Response(io.BytesIO):
            status=200
            headers={}
        class Opener:
            def open(self,url,timeout):return Response(b'ok!')
        with patch.dict(m.SPECS,{'cosmos':('cosmos/cosmos-sdk',1,3)}),patch.object(m,'pin_for',return_value={'archiveSha256':m.sha(b'ok!')}),patch.object(m.urllib.request,'build_opener',return_value=Opener()),patch.object(m.time,'monotonic',side_effect=[0,301]):
            with self.assertRaises(ValueError):m.download('cosmos',self.root)

    def test_cli_requires_explicit_mode(self):
        r=subprocess.run([sys.executable,'-I',str(Path(m.__file__)),'--output',str(self.root/'out')],capture_output=True)
        self.assertEqual(r.returncode,2);self.assertFalse((self.root/'out').exists())


if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(ProvisionTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    print(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'skipped':len(result.skipped)}))
    raise SystemExit(0 if result.wasSuccessful() else 1)
