"""Offline archive/install regressions; every service and HTTP operation is mocked."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_preview as deploy
import update_preview as update


def digest(data):
    return hashlib.sha256(data).hexdigest()


class PreviewDeploymentTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.wasm = b'\0asm synthetic reviewed program'
        self.pack = b'synthetic pack' * 512
        self.original_pack = b'original fidelity pack' * 512
        self.resources = {'data.dat': b'data' * 1100, 'Voice.dat': b'voice' * 900, 'Region.dat': b'\0'}
        pins = {'EXPECTED_WASM': digest(self.wasm), 'PACK_SHA': digest(self.pack), 'PACK_BYTES': len(self.pack), 'ORIGINAL_SHA':digest(self.original_pack), 'ORIGINAL_BYTES':len(self.original_pack),
                'RESOURCES': [dict(name=name, length=len(data), sha256=digest(data)) for name, data in self.resources.items()]}
        self.stack.enter_context(mock.patch.multiple(deploy, **pins))
        pack = dict(path='/__joey_packed_resources_v1', url='/joey/original/resource-packs/' + digest(self.pack),
                    length=len(self.pack), sha256=digest(self.pack))
        self.decoder = b'synthetic integer decoder'
        self.stack.enter_context(mock.patch.multiple(deploy, DECODER_SHA=digest(self.decoder), DECODER_BYTES=len(self.decoder)))
        manifest = dict(format='joey-light-pack-v3', decoder=dict(url='/joey/original/brotli-decoder.wasm', length=len(self.decoder), sha256=digest(self.decoder), memoryLimitBytes=33554432), pack=pack, archives=[dict(path='/' + item['name'], length=item['length'], sha256=item['sha256'])
                                           for item in deploy.RESOURCES])
        self.files = {name: ('synthetic ' + name).encode() for name in deploy.PREVIEW_FILES}
        self.files['joey_original_bg.wasm'] = self.wasm
        self.files['brotli-decoder.wasm'] = self.decoder
        legacy_pack = dict(path=pack['path'], url='/joey/original/resource-packs/'+deploy.LEGACY_SHA, length=deploy.LEGACY_BYTES, sha256=deploy.LEGACY_SHA)
        self.files['legacy-resources.manifest.json'] = json.dumps(dict(format='joey-lossless-gzip-pack-v1', pack=legacy_pack, archives=manifest['archives'])).encode()
        self.stack.enter_context(mock.patch.object(deploy, 'LEGACY_MANIFEST_SHA', digest(self.files['legacy-resources.manifest.json'])))
        legacy = dict(manifestURL='/joey/original/legacy-resources.manifest.json', manifestSHA256=deploy.LEGACY_MANIFEST_SHA, pack=legacy_pack)
        original_pack = dict(path=pack['path'], url='/joey/original/resource-packs/'+deploy.ORIGINAL_SHA, length=deploy.ORIGINAL_BYTES, sha256=deploy.ORIGINAL_SHA)
        self.files['original-resources.manifest.json'] = json.dumps(dict(format='joey-lossless-pack-v2', pack=original_pack, archives=manifest['archives'])).encode()
        self.stack.enter_context(mock.patch.object(deploy, 'ORIGINAL_MANIFEST_SHA', digest(self.files['original-resources.manifest.json'])))
        original = dict(manifestURL='/joey/original/original-resources.manifest.json', manifestSHA256=deploy.ORIGINAL_MANIFEST_SHA, pack=original_pack)
        derived = {item['name']:item['sha256'] for item in deploy.RESOURCES}
        self.stack.enter_context(mock.patch.object(deploy, 'DERIVED_SHA', derived))
        for file in manifest['archives']: file['derivedSHA256'] = derived[file['path'][1:]]
        self.files['resources.manifest.json'] = json.dumps(manifest).encode()
        self.files['joey_original_bg.wasm.gz'] = gzip.compress(self.wasm, mtime=0)
        self.files['NOTICE.txt'] = b'Synthetic fixture'
        self.revision = dict(version='test-release', wasmSHA256=digest(self.wasm), resources=deploy.RESOURCES,
                             files={name: digest(self.files[name]) for name in deploy.PREVIEW_FILES},
                             programGzipSHA256=digest(self.files['joey_original_bg.wasm.gz']),
                             packedResources=dict(manifestURL='/joey/original/resources.manifest.json',
                                                  manifestSHA256=digest(self.files['resources.manifest.json']), pack=pack))
        self.revision['originalPackedResources'] = original
        self.revision['legacyPackedResources'] = [original,legacy]
        self.revision['qualityProfile'] = {'name':'light-rgb6-pcm13'}
        self.files['revision.json'] = json.dumps(self.revision).encode()
        self.archive = self.root / 'preview.tgz'

    def write_archive(self, files=None, extra=None):
        with tarfile.open(self.archive, 'w:gz') as package:
            for name, content in (self.files if files is None else files).items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                package.addfile(entry, io.BytesIO(content))
            if extra:
                package.addfile(extra, io.BytesIO(b''))
        return deploy.sha(self.archive)

    def test_valid_archive_preserves_fixed_members_and_modes(self):
        release = self.root / 'release'
        self.assertEqual(deploy.unpack_preview(self.archive, self.write_archive(), release), self.revision)
        self.assertEqual({path.relative_to(release).as_posix() for path in release.rglob('*') if path.is_file()}, deploy.PREVIEW_MEMBERS)
        self.assertEqual(release.stat().st_mode & 0o777, 0o755)
        self.assertTrue(all(path.stat().st_mode & 0o777 == (0o755 if path.is_dir() else 0o644) for path in release.rglob('*')))

    def test_bad_checksum_rejected_without_extracting(self):
        self.write_archive()
        release = self.root / 'release'
        with self.assertRaisesRegex(RuntimeError, 'checksum'):
            deploy.unpack_preview(self.archive, '0' * 64, release)
        self.assertFalse(release.exists())

    def test_member_boundary_rejects_traversal_duplicates_symlinks_missing_and_oversize(self):
        for name, kind in [('../escape', tarfile.REGTYPE), ('app.mjs', tarfile.REGTYPE),
                           ('app.mjs', tarfile.SYMTYPE), ('oversize', None), ('missing', None)]:
            with self.subTest(name=name, kind=kind):
                files = self.files.copy()
                entry = tarfile.TarInfo(name)
                if name == 'oversize':
                    entry.name = 'joey_original_bg.wasm'
                    entry.size = 104857601
                    self.archive.write_bytes(gzip.compress(entry.tobuf() + b'\0' * 1024))
                    checksum = deploy.sha(self.archive)
                elif name == 'missing':
                    files.pop('app.mjs')
                    checksum = self.write_archive(files)
                else:
                    entry.type = kind
                    if kind == tarfile.SYMTYPE:
                        files.pop('app.mjs')
                        entry.linkname = '/tmp/escape'
                    checksum = self.write_archive(files, extra=entry)
                release = self.root / 'release'
                with self.assertRaises(RuntimeError):
                    deploy.unpack_preview(self.archive, checksum, release)
                self.assertFalse(release.exists())
        self.assertFalse((self.root / 'escape').exists())

    def test_payload_provenance_and_gzip_rejected_and_partial_release_removed(self):
        for fault in ['file', 'wasm-pin', 'resources', 'gzip-hash', 'gzip-expansion', 'pack', 'manifest', 'decoder', 'legacy']:
            with self.subTest(fault=fault):
                files = self.files.copy()
                revision = copy.deepcopy(self.revision)
                if fault == 'file':
                    files['app.mjs'] += b'tampered'
                elif fault == 'wasm-pin':
                    files['joey_original_bg.wasm'] = b'an unreviewed program'
                    revision['files']['joey_original_bg.wasm'] = digest(files['joey_original_bg.wasm'])
                    revision['wasmSHA256'] = revision['files']['joey_original_bg.wasm']
                elif fault == 'resources':
                    revision['resources'][0]['length'] += 1
                elif fault == 'gzip-hash':
                    revision['programGzipSHA256'] = '0' * 64
                elif fault == 'gzip-expansion':
                    files['joey_original_bg.wasm.gz'] = gzip.compress(self.wasm * 2)
                    revision['programGzipSHA256'] = digest(files['joey_original_bg.wasm.gz'])
                elif fault == 'pack':
                    revision['packedResources']['pack']['sha256'] = '0' * 64
                elif fault == 'decoder':
                    files['brotli-decoder.wasm'] = b'changed decoder'
                    revision['files']['brotli-decoder.wasm'] = digest(files['brotli-decoder.wasm'])
                elif fault == 'legacy':
                    revision['legacyPackedResources'][0]['manifestSHA256'] = '0' * 64
                else:
                    manifest = json.loads(files['resources.manifest.json'])
                    manifest['archives'][0]['sha256'] = '0' * 64
                    files['resources.manifest.json'] = json.dumps(manifest).encode()
                    revision['files']['resources.manifest.json'] = digest(files['resources.manifest.json'])
                    revision['packedResources']['manifestSHA256'] = digest(files['resources.manifest.json'])
                files['revision.json'] = json.dumps(revision).encode()
                release = self.root / 'release'
                with self.assertRaises(RuntimeError):
                    deploy.unpack_preview(self.archive, self.write_archive(files), release)
                self.assertFalse(release.exists())

    def stage_pack(self, base):
        source = base / 'original-resource-packs/.incoming-resources.gzip.pack'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(self.pack)
        return source

    def test_pack_staging_install_reuse_and_corruption(self):
        base = self.root / 'base'
        source = self.stage_pack(base)
        with self.assertRaisesRegex(RuntimeError, 'staging path'):
            deploy.install_resource_pack(base, self.root / 'other.pack')
        pack_root = deploy.install_resource_pack(base, source)
        self.assertFalse(source.exists())
        target = pack_root / 'resources.gzip.pack'
        self.assertEqual(target.read_bytes(), self.pack)
        self.assertEqual(target.stat().st_mode & 0o777, 0o644)
        self.assertEqual(deploy.install_resource_pack(base), pack_root)
        target.write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, 'Installed resource pack mismatch'):
            deploy.install_resource_pack(base)
        target.unlink()
        target.symlink_to(self.root / 'missing')
        with self.assertRaisesRegex(RuntimeError, 'Unsafe resource pack path'):
            deploy.install_resource_pack(base)

    def test_uploaded_pack_mismatch_and_symlink_do_not_mutate_staging(self):
        base = self.root / 'base'
        source = self.stage_pack(base)
        source.write_bytes(b'bad pack')
        with self.assertRaisesRegex(RuntimeError, 'Uploaded resource pack mismatch'):
            deploy.install_resource_pack(base, source)
        self.assertEqual(source.read_bytes(), b'bad pack')
        source.unlink()
        target = self.root / 'pack-target'
        target.write_bytes(self.pack)
        source.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError, 'staging path'):
            deploy.install_resource_pack(base, source)
        self.assertTrue(source.is_symlink())
        self.assertFalse((source.parent / deploy.PACK_SHA).exists())

    def mock_machine(self):
        def local_path(path):
            path = Path(path)
            if path.is_absolute() and not path.is_relative_to(self.root):
                return self.root / path.relative_to('/')
            return path
        self.local_path = local_path
        self.base = local_path('/opt/joey-web')
        self.base.mkdir(parents=True)
        (self.base / 'nginx-location.conf').write_bytes(b'# existing native and streaming routes\n')
        for directory in ['/etc/joey-web', '/etc/systemd/system', '/var/lib/joey-web/game',
                          '/usr/local/nginx/conf/vhost', '/proc/12345']:
            local_path(directory).mkdir(parents=True)
        local_path('/etc/joey-web/config.json').write_text('{"origin":"https://synthetic.invalid"}')
        local_path('/usr/local/nginx/conf/vhost/site.conf').write_text('# unrelated virtual host')
        local_path('/proc/12345/stat').write_bytes(b'12345 (name with ) parentheses) S ' + b'0 ' * 18 + b'999 0')
        for name, data in self.resources.items():
            (local_path('/var/lib/joey-web/game') / name).write_bytes(data)
        original_root = self.base / 'original-resource-packs' / deploy.ORIGINAL_SHA
        original_root.mkdir(parents=True)
        (original_root / 'resources.gzip.pack').write_bytes(self.original_pack)
        self.config_path = local_path('/etc/joey-web/original-config.json')
        self.unit = local_path('/etc/systemd/system/joey-original.service')
        self.run = mock.Mock(side_effect=lambda *args: '12345' if args[:3] == ('systemctl', 'show', 'wrist-relay.service') else '456')
        self.http = mock.Mock(side_effect=self.fake_http)
        for module in [deploy, update]:
            self.stack.enter_context(mock.patch.object(module, 'Path', side_effect=local_path))
            self.stack.enter_context(mock.patch.object(module, 'run', self.run))
            self.stack.enter_context(mock.patch.object(module, 'fetch', self.http))
        self.stack.enter_context(mock.patch.object(deploy.socket, 'socket'))
        self.stack.enter_context(mock.patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)))
        self.stack.enter_context(mock.patch.object(deploy.os, 'chown'))
        self.stack.enter_context(mock.patch.object(deploy.time, 'sleep'))
        self.stack.enter_context(mock.patch('builtins.print'))

    def fake_http(self, url, method='GET', headers=None):
        path = urlsplit(url).path
        if path in ['/', '/joey/', '/joey/native/']:
            return 200, {}, b'unchanged'
        config = json.loads(self.config_path.read_text())
        release = Path(config['filesRoot'])
        if path.endswith('/api/session'):
            session = dict(version=self.revision['version'], access='public', resources=deploy.RESOURCES,
                           program={'url': '/joey/original/joey_original_bg.wasm'}, packedResources=self.revision['packedResources'], legacyPackedResources=self.revision['legacyPackedResources'],originalPackedResources=self.revision['originalPackedResources'])
            return 200, {'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp'}, json.dumps(session).encode()
        if path.endswith('/resources.manifest.json'):
            return 200, {}, (release / 'resources.manifest.json').read_bytes()
        if path.endswith('/original-resources.manifest.json'):
            return 200, {}, (release / 'original-resources.manifest.json').read_bytes()
        if path.endswith('/legacy-resources.manifest.json'):
            return 200, {}, (release / 'legacy-resources.manifest.json').read_bytes()
        if path.endswith('/brotli-decoder.wasm'):
            return 200, {'Content-Type':'application/wasm'}, (release / 'brotli-decoder.wasm').read_bytes()
        if '/resource-packs/' in path:
            data = self.original_pack if path.endswith(deploy.ORIGINAL_SHA) else (Path(config['packedResourcesRoot']) / 'resources.gzip.pack').read_bytes()
            return 206, {'Content-Range': f'bytes 0-4095/{len(data)}', 'Cache-Control': 'no-store'}, data[:4096]
        if '/resources/' in path:
            data = self.resources[path.rsplit('/', 1)[1]]
            end = min(len(data), 4096) - 1
            return 206, {'Content-Range': f'bytes 0-{end}/{len(data)}'}, data[:end + 1]
        if path.endswith('/joey_original_bg.wasm') and method == 'HEAD':
            return 200, {'Content-Encoding': 'gzip', 'Content-Type': 'application/wasm',
                         'Content-Length': str((release / 'joey_original_bg.wasm.gz').stat().st_size)}, b''
        raise AssertionError('Unexpected synthetic HTTP request: ' + url)

    def test_first_install_writes_packed_root_and_checks_public_pack_without_other_service_restart(self):
        self.mock_machine()
        source = self.stage_pack(self.base)
        checksum = self.write_archive()
        deploy.main(self.archive, checksum, source)
        config = json.loads(self.config_path.read_text())
        self.assertEqual(config['packedResourcesRoot'], str(self.base / 'original-resource-packs' / deploy.PACK_SHA))
        self.assertTrue((Path(config['packedResourcesRoot']) / 'resources.gzip.pack').is_file())
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)
        self.assertIn('/joey/original/', (self.base / 'nginx-location.conf').read_text())
        report = json.loads((self.base / 'original-preview-deployment.json').read_text())
        self.assertEqual(report['wristPID'], 12345)
        self.assertTrue(report['compressedResourceRangesPassed'])
        self.assertTrue(report['vhostFilesUnchanged'])
        for call in self.run.call_args_list:
            if call.args[:2] in [('systemctl', 'restart'), ('systemctl', 'disable'), ('systemctl', 'enable')]:
                self.assertEqual(call.args[-1], 'joey-original.service')

    def test_first_install_failed_pack_range_rolls_back_route_config_and_unit(self):
        self.mock_machine()
        source = self.stage_pack(self.base)
        prior_route = (self.base / 'nginx-location.conf').read_bytes()
        def corrupt_pack_range(url, **kwargs):
            status, headers, body = self.fake_http(url, **kwargs)
            return (status, headers, b'wrong bytes') if url.endswith('/resource-packs/' + deploy.PACK_SHA) else (status, headers, body)
        self.http.side_effect = corrupt_pack_range
        with self.assertRaisesRegex(RuntimeError, 'Public compressed range mismatch'):
            deploy.main(self.archive, self.write_archive(), source)
        self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), prior_route)
        self.assertFalse(self.config_path.exists())
        self.assertFalse(self.unit.exists())
        self.assertTrue((self.base / 'original-resource-packs' / deploy.PACK_SHA / 'resources.gzip.pack').is_file())
        self.assertIn(mock.call('systemctl', 'disable', '--now', 'joey-original.service'), self.run.call_args_list)

    def assert_install_creation_failure_can_retry(self, failure):
        self.mock_machine()
        source = self.stage_pack(self.base)
        checksum = self.write_archive()
        prior_route = (self.base / 'nginx-location.conf').read_bytes()
        original_open = Path.open
        failure_target = self.config_path if failure == 'config-write' else self.unit

        @contextlib.contextmanager
        def partially_written(path, *args, **kwargs):
            with original_open(path, *args, **kwargs) as stream:
                def write(data):
                    stream.write(data[:8])
                    stream.flush()
                    raise OSError('injected ' + failure)
                yield SimpleNamespace(write=write)

        def open_file(path, *args, **kwargs):
            mode = args[0] if args else kwargs.get('mode', 'r')
            if failure != 'chown' and path == failure_target and mode in ('x', 'w'):
                return partially_written(path, *args, **kwargs)
            return original_open(path, *args, **kwargs)

        with mock.patch.object(deploy.time, 'strftime', return_value='retry-same-second'):
            with contextlib.ExitStack() as faults:
                faults.enter_context(mock.patch.object(Path, 'open', open_file))
                if failure == 'chown':
                    faults.enter_context(mock.patch.object(deploy.os, 'chown', side_effect=OSError('injected chown')))
                with self.assertRaisesRegex(OSError, 'injected ' + failure):
                    deploy.main(self.archive, checksum, source)
            self.assertFalse(self.config_path.exists())
            self.assertFalse(self.unit.exists())
            self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), prior_route)
            self.assertEqual(list((self.base / 'original-releases').iterdir()), [])
            self.assertTrue(all(call.args[:2] == ('systemctl', 'show') for call in self.run.call_args_list))
            # A retry can reuse the verified pack and the exact same release name.
            deploy.main(self.archive, checksum)
        self.assertTrue(self.config_path.is_file())
        self.assertTrue(self.unit.is_file())

    def test_first_install_config_write_failure_cleans_partial_file_and_allows_retry(self):
        self.assert_install_creation_failure_can_retry('config-write')

    def test_first_install_chown_failure_cleans_config_and_allows_retry(self):
        self.assert_install_creation_failure_can_retry('chown')

    def test_first_install_unit_write_failure_cleans_both_files_and_allows_retry(self):
        self.assert_install_creation_failure_can_retry('unit-write')

    def test_first_install_preserves_preexisting_config_unit_and_route(self):
        self.mock_machine()
        checksum = self.write_archive()
        route = (self.base / 'nginx-location.conf').read_bytes()
        for target in [self.config_path, self.unit]:
            with self.subTest(target=target.name):
                target.write_text('existing file must survive')
                with self.assertRaisesRegex(RuntimeError, 'already exists'):
                    deploy.main(self.archive, checksum, self.stage_pack(self.base))
                self.assertEqual(target.read_text(), 'existing file must survive')
                self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), route)
                target.unlink()

    def test_first_install_preserves_concurrently_created_unit(self):
        self.mock_machine()
        source = self.stage_pack(self.base)
        checksum = self.write_archive()
        route = (self.base / 'nginx-location.conf').read_bytes()
        original_open = Path.open
        def create_concurrently(path, mode='r', *args, **kwargs):
            if path == self.unit and mode == 'x':
                path.write_text('concurrent unit must survive')
            return original_open(path, mode, *args, **kwargs)
        with mock.patch.object(Path, 'open', create_concurrently):
            with self.assertRaises(FileExistsError):
                deploy.main(self.archive, checksum, source)
        self.assertEqual(self.unit.read_text(), 'concurrent unit must survive')
        self.assertFalse(self.config_path.exists())
        self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), route)
        self.assertTrue(all(call.args[:2] == ('systemctl', 'show') for call in self.run.call_args_list))

    @contextlib.contextmanager
    def partial_route_write(self):
        original_temporary = tempfile.NamedTemporaryFile
        @contextlib.contextmanager
        def partial_temporary(*args, **kwargs):
            with original_temporary(*args, **kwargs) as target:
                def write(content):
                    target.write(content[:8])
                    target.flush()
                    raise OSError('injected partial route write')
                yield SimpleNamespace(name=target.name, write=write)
        with mock.patch.object(tempfile, 'NamedTemporaryFile', partial_temporary):
            yield

    def test_first_install_partial_route_write_preserves_old_include_and_cleans_install(self):
        self.mock_machine()
        source = self.stage_pack(self.base)
        location = self.base / 'nginx-location.conf'
        location.chmod(0o640)
        prior = location.read_bytes()
        metadata = location.stat()
        with self.partial_route_write():
            with self.assertRaisesRegex(OSError, 'injected partial route write'):
                deploy.main(self.archive, self.write_archive(), source)
        self.assertEqual(location.read_bytes(), prior)
        for field in ['st_ino', 'st_mode', 'st_uid', 'st_gid', 'st_mtime_ns']:
            self.assertEqual(getattr(location.stat(), field), getattr(metadata, field))
        self.assertFalse(list(self.base.glob('.nginx-original-*')))
        self.assertFalse(self.config_path.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(any(call.args == ('systemctl', 'reload', 'nginx.service') for call in self.run.call_args_list))

    def test_route_forward_and_rollback_preserve_metadata_and_use_atomic_replace(self):
        location = self.root / 'nginx-location.conf'
        prior = b'# complete old routes\n'
        installed = prior + b'location /joey/original/ {}\n'
        location.write_bytes(prior)
        location.chmod(0o640)
        metadata = location.stat()
        with mock.patch.object(deploy.os, 'replace', wraps=deploy.os.replace) as replace:
            deploy.replace_route(location, installed, prior)
            self.assertEqual(location.read_bytes(), installed)
            deploy.replace_route(location, prior, installed)
        self.assertEqual(location.read_bytes(), prior)
        self.assertEqual(replace.call_count, 2)
        for call in replace.call_args_list:
            self.assertEqual(call.args[0].parent, location.parent)
            self.assertEqual(call.args[1], location)
        for field in ['st_mode', 'st_uid', 'st_gid', 'st_mtime_ns']:
            self.assertEqual(getattr(location.stat(), field), getattr(metadata, field))
        self.assertFalse(list(self.root.glob('.nginx-original-*')))

    def test_route_write_and_replace_failures_preserve_complete_current_file_in_both_directions(self):
        location = self.root / 'nginx-location.conf'
        prior = b'# complete old routes\n'
        installed = prior + b'location /joey/original/ {}\n'
        for current, replacement in [(prior, installed), (installed, prior)]:
            for fault in ['write', 'replace']:
                with self.subTest(current=current, fault=fault):
                    location.write_bytes(current)
                    metadata = location.stat()
                    inject = self.partial_route_write() if fault == 'write' else mock.patch.object(deploy.os, 'replace', side_effect=OSError('injected replace'))
                    with inject:
                        with self.assertRaisesRegex(OSError, 'injected'):
                            deploy.replace_route(location, replacement, current)
                    self.assertEqual(location.read_bytes(), current)
                    self.assertEqual(location.stat().st_ino, metadata.st_ino)
                    self.assertEqual(location.stat().st_mtime_ns, metadata.st_mtime_ns)
                    self.assertFalse(list(self.root.glob('.nginx-original-*')))

    def test_route_concurrent_change_during_staging_is_preserved(self):
        location = self.root / 'nginx-location.conf'
        prior = b'# complete old routes\n'
        concurrent = b'# concurrently added unrelated route\n'
        location.write_bytes(prior)
        copy_metadata = deploy.shutil.copystat
        def change_during_staging(source, target):
            copy_metadata(source, target)
            location.write_bytes(concurrent)
        with mock.patch.object(deploy.shutil, 'copystat', change_during_staging):
            with self.assertRaisesRegex(RuntimeError, 'Concurrent nginx route change'):
                deploy.replace_route(location, prior + b'new route', prior)
        self.assertEqual(location.read_bytes(), concurrent)
        self.assertFalse(list(self.root.glob('.nginx-original-*')))

    def test_update_reuses_pack_and_preserves_routes(self):
        self.mock_machine()
        old = self.base / 'original-releases/prior-release'
        old.mkdir(parents=True)
        (old / 'revision.json').write_text(json.dumps(self.revision))
        config = dict(origin='https://synthetic.invalid', port=18891, filesRoot=str(old),
                      resourcesRoot=str(self.local_path('/var/lib/joey-web/game')))
        self.config_path.write_text(json.dumps(config))
        self.unit.write_text(f'WorkingDirectory={old}\nExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 {old}/server.mjs\n')
        pack_root = deploy.install_resource_pack(self.base, self.stage_pack(self.base))
        route = (self.base / 'nginx-location.conf').read_bytes()
        update.main(self.archive, self.write_archive())
        updated = json.loads(self.config_path.read_text())
        self.assertNotEqual(updated['filesRoot'], str(old))
        self.assertEqual(updated['packedResourcesRoot'], str(pack_root))
        self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), route)
        self.assertIn('WorkingDirectory=' + updated['filesRoot'], self.unit.read_text())
        self.assertIn(mock.call('systemctl', 'restart', 'joey-original.service'), self.run.call_args_list)
        self.assertFalse(any(call.args[:2] == ('systemctl', 'reload') for call in self.run.call_args_list))

    def test_update_regression_restores_previous_unit_and_config(self):
        self.mock_machine()
        old = self.base / 'original-releases/prior-release'
        old.mkdir(parents=True)
        (old / 'revision.json').write_text(json.dumps(self.revision))
        config = dict(origin='https://synthetic.invalid', port=18891, filesRoot=str(old),
                      resourcesRoot=str(self.local_path('/var/lib/joey-web/game')))
        prior_config = json.dumps(config).encode()
        prior_unit = f'WorkingDirectory={old}\nExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 {old}/server.mjs\n'
        self.config_path.write_bytes(prior_config)
        self.unit.write_text(prior_unit)
        route = (self.base / 'nginx-location.conf').read_bytes()
        source = self.stage_pack(self.base)
        with mock.patch.object(update, 'wrist_state', side_effect=[(12345, b'999'), (12345, b'1000')]):
            with self.assertRaisesRegex(RuntimeError, 'Existing functions changed'):
                update.main(self.archive, self.write_archive(), source)
        self.assertEqual(self.config_path.read_bytes(), prior_config)
        self.assertEqual(self.unit.read_text(), prior_unit)
        self.assertEqual((self.base / 'nginx-location.conf').read_bytes(), route)
        self.assertEqual(self.run.call_args_list.count(mock.call('systemctl', 'restart', 'joey-original.service')), 2)

    def test_update_from_legacy_rejects_missing_old_pack_before_switching_service(self):
        self.mock_machine()
        old = self.base / 'original-releases/prior-release'
        old.mkdir(parents=True)
        prior = copy.deepcopy(self.revision)
        prior['packedResources'] = prior['legacyPackedResources'][1]
        (old / 'revision.json').write_text(json.dumps(prior))
        config = json.dumps(dict(origin='https://synthetic.invalid', port=18891, filesRoot=str(old),
                                 resourcesRoot=str(self.local_path('/var/lib/joey-web/game')))).encode()
        unit = f'WorkingDirectory={old}\nExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 {old}/server.mjs\n'
        self.config_path.write_bytes(config)
        self.unit.write_text(unit)
        with self.assertRaisesRegex(RuntimeError, 'Previous compressed resource pack missing'):
            update.main(self.archive, self.write_archive(), self.stage_pack(self.base))
        self.assertEqual(self.config_path.read_bytes(), config)
        self.assertEqual(self.unit.read_text(), unit)
        self.assertFalse(any(call.args[:2] == ('systemctl', 'restart') for call in self.run.call_args_list))

    def test_original_quality_pack_is_required_even_for_fresh_light_deployment(self):
        self.mock_machine()
        path = self.base / 'original-resource-packs' / deploy.ORIGINAL_SHA / 'resources.gzip.pack'
        path.unlink()
        with self.assertRaisesRegex(RuntimeError, 'Required original quality resource pack missing'):
            deploy.main(self.archive, self.write_archive(), self.stage_pack(self.base))
        self.assertFalse(self.config_path.exists())
        self.assertFalse(self.unit.exists())
        self.assertFalse(any(call.args[:2] == ('systemctl', 'enable') for call in self.run.call_args_list))

    def test_original_quality_corruption_rejected_independently_of_current_light_pack(self):
        self.mock_machine()
        path = self.base / 'original-resource-packs' / deploy.ORIGINAL_SHA / 'resources.gzip.pack'
        self.assertEqual(deploy.check_original_quality_pack(self.base), path)
        path.write_bytes(b'wrong bytes')
        with self.assertRaisesRegex(RuntimeError, 'Required original quality resource pack missing or changed'):
            deploy.check_original_quality_pack(self.base)

    def test_public_compatibility_checks_reject_old_index_and_decoder_regressions(self):
        session = {'legacyPackedResources': self.revision['legacyPackedResources'],'originalPackedResources':self.revision['originalPackedResources']}
        responses = [(200, {}, self.files['original-resources.manifest.json']),(200, {}, self.files['legacy-resources.manifest.json']),
                     (200, {'Content-Type':'application/wasm'}, self.decoder)]
        with mock.patch.object(deploy, 'fetch', side_effect=responses):
            deploy.check_compatible_resources('https://synthetic.invalid', session, self.revision)
        for fault in ['metadata', 'legacy-index', 'decoder-bytes', 'decoder-mime']:
            with self.subTest(fault=fault):
                candidate = copy.deepcopy(session)
                values = responses.copy()
                if fault == 'metadata': candidate['legacyPackedResources'] = []
                if fault == 'legacy-index': values[0] = (200, {}, b'changed index')
                if fault == 'decoder-bytes': values[2] = (200, {'Content-Type':'application/wasm'}, b'changed decoder')
                if fault == 'decoder-mime': values[2] = (200, {'Content-Type':'text/html'}, self.decoder)
                with mock.patch.object(deploy, 'fetch', side_effect=values):
                    with self.assertRaises(RuntimeError):
                        deploy.check_compatible_resources('https://synthetic.invalid', candidate, self.revision)

    def test_wrist_pid_discovery_uses_service_and_starttime(self):
        self.mock_machine()
        self.assertEqual(deploy.wrist_state(), (12345, b'999'))
        self.run.assert_called_with('systemctl', 'show', 'wrist-relay.service', '-p', 'MainPID', '--value')
        for value in ['0', '', '-1', 'not-a-pid']:
            self.run.side_effect = None
            self.run.return_value = value
            with self.assertRaisesRegex(RuntimeError, 'not running'):
                deploy.wrist_state()


if __name__ == '__main__':
    unittest.main()
