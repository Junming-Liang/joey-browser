"""Rollback failure injection: temporary files only; no real services or HTTP."""
import contextlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import deploy_online_preview as deploy


class OnlinePreviewRollbackTest(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.location = self.root / 'nginx-location.conf'
        self.before = b'# accepted single-player and unrelated routes\n'
        self.installed = self.before + b'# preview route\n'
        self.location.write_bytes(self.installed)
        self.unit = self.root / 'joey-online-preview.service'
        self.unit_content = '[Service]\nExecStart=/owned/release/server.mjs\n'
        self.unit.write_text(self.unit_content)
        self.config = self.root / 'online-preview-config.json'
        self.config_content = '{"filesRoot":"/owned/release"}'
        self.config.write_text(self.config_content)
        self.release = self.root / 'release'
        self.release.mkdir()
        (self.release / 'server.mjs').write_text('// owned code\n')
        self.failures = set()
        self.pid = '0'
        self.state = 'inactive'
        self.calls = []
        self.stack.enter_context(mock.patch.object(deploy, 'run', side_effect=self.run_command))

    def run_command(self, *args):
        self.calls.append(args)
        if args in self.failures:
            raise RuntimeError('injected ' + ' '.join(args))
        if args[:3] == ('systemctl', 'show', deploy.UNIT):
            return self.pid if args[4] == 'MainPID' else self.state
        return ''

    def rollback(self, **flags):
        defaults = dict(route_changed=True, service_attempted=True, unit_created=True, config_created=True)
        defaults.update(flags)
        return deploy.rollback_install(
            self.location, self.before, self.installed, self.unit, self.unit_content,
            self.config, self.config_content, self.release, **defaults)

    def assert_stopped_attempted(self):
        self.assertIn(('systemctl', 'stop', deploy.UNIT), self.calls)
        self.assertIn(('systemctl', 'disable', deploy.UNIT), self.calls)

    def test_success_restores_route_and_removes_only_owned_resources(self):
        self.assertEqual(self.rollback(), [])
        self.assertEqual(self.location.read_bytes(), self.before)
        self.assert_stopped_attempted()
        self.assertFalse(self.unit.exists())
        self.assertFalse(self.config.exists())
        self.assertFalse(self.release.exists())

    def test_concurrent_route_change_is_preserved_but_preview_still_stops(self):
        concurrent = self.installed + b'# another task added a route\n'
        self.location.write_bytes(concurrent)
        errors = self.rollback()
        self.assertTrue(any('restore route' in error and 'Concurrent' in error for error in errors))
        self.assertEqual(self.location.read_bytes(), concurrent)
        self.assert_stopped_attempted()
        self.assertNotIn(('systemctl', 'reload', 'nginx.service'), self.calls)
        self.assertFalse(self.release.exists())

    def test_nginx_validation_failure_does_not_skip_service_cleanup(self):
        self.failures.add(('/usr/local/nginx/sbin/nginx', '-t'))
        errors = self.rollback()
        self.assertTrue(any('validate restored nginx route' in error for error in errors))
        self.assertEqual(self.location.read_bytes(), self.before)
        self.assertNotIn(('systemctl', 'reload', 'nginx.service'), self.calls)
        self.assert_stopped_attempted()
        self.assertFalse(self.release.exists())

    def test_nginx_reload_and_disable_failures_are_both_reported(self):
        self.failures.update({('systemctl', 'reload', 'nginx.service'), ('systemctl', 'disable', deploy.UNIT)})
        errors = self.rollback()
        self.assertTrue(any('reload restored nginx route' in error for error in errors))
        self.assertTrue(any('disable preview service' in error for error in errors))
        self.assert_stopped_attempted()
        self.assertFalse(self.release.exists())

    def test_stop_failure_preserves_live_service_inputs_and_release(self):
        self.failures.add(('systemctl', 'stop', deploy.UNIT))
        self.pid = '12345'
        self.state = 'active'
        errors = self.rollback()
        self.assertTrue(any('stop preview service' in error for error in errors))
        self.assertTrue(any('termination was not confirmed' in error for error in errors))
        self.assert_stopped_attempted()
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.config.exists())
        self.assertTrue(self.release.exists())

    def test_zero_pid_during_restart_is_not_treated_as_stopped(self):
        self.state = 'activating'
        errors = self.rollback()
        self.assertTrue(any('confirm preview stopped' in error for error in errors))
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.config.exists())
        self.assertTrue(self.release.exists())

    def test_failed_state_query_preserves_release(self):
        self.failures.add(('systemctl', 'show', deploy.UNIT, '-p', 'MainPID', '--value'))
        errors = self.rollback()
        self.assertTrue(any('confirm preview stopped' in error for error in errors))
        self.assertTrue(self.release.exists())

    def test_changed_unit_is_not_deleted_and_its_release_is_retained(self):
        changed = self.unit_content + '# concurrent update\n'
        self.unit.write_text(changed)
        errors = self.rollback()
        self.assertTrue(any('concurrent file change' in error for error in errors))
        self.assertEqual(self.unit.read_text(), changed)
        self.assertTrue(self.config.exists())
        self.assertTrue(self.release.exists())

    def test_changed_config_is_not_deleted_and_its_release_is_retained(self):
        changed = '{"filesRoot":"/other/release"}'
        self.config.write_text(changed)
        errors = self.rollback()
        self.assertTrue(any('concurrent file change' in error for error in errors))
        self.assertEqual(self.config.read_text(), changed)
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.release.exists())

    def test_symlink_replacement_preserves_unrelated_target(self):
        target = self.root / 'unrelated-config.json'
        target.write_text(self.config_content)
        self.config.unlink()
        self.config.symlink_to(target)
        errors = self.rollback()
        self.assertTrue(any('concurrent file change' in error for error in errors))
        self.assertTrue(self.config.is_symlink())
        self.assertEqual(target.read_text(), self.config_content)
        self.assertTrue(self.release.exists())

    def test_failure_before_service_attempt_has_no_service_side_effects(self):
        self.assertEqual(self.rollback(route_changed=False, service_attempted=False), [])
        self.assertEqual(self.location.read_bytes(), self.installed)
        self.assertNotIn(('systemctl', 'stop', deploy.UNIT), self.calls)
        self.assertNotIn(('systemctl', 'disable', deploy.UNIT), self.calls)
        self.assertFalse(self.release.exists())

    def test_unowned_unit_and_config_are_not_removed(self):
        self.assertEqual(self.rollback(route_changed=False, service_attempted=False, unit_created=False, config_created=False), [])
        self.assertTrue(self.unit.exists())
        self.assertTrue(self.config.exists())
        self.assertFalse(self.release.exists())

    def install(self, *, wrong_version=False, route_change=False, session_changed=False, public_responses=None):
        def mapped_path(value):
            return self.root / 'host' / Path(value).relative_to('/')

        base = mapped_path('/opt/joey-web')
        unit_dir = mapped_path('/etc/systemd/system')
        config_dir = mapped_path('/etc/joey-web')
        vhosts = mapped_path('/usr/local/nginx/conf/vhost')
        for directory in [base, unit_dir, config_dir, vhosts]:
            directory.mkdir(parents=True, exist_ok=True)
        location = base / 'nginx-location.conf'
        location.write_bytes(self.before)
        original = dict(origin='https://game.invalid', resourcesRoot='/immutable/game', packedResourcesRoot='/immutable/pack')
        (config_dir / 'original-config.json').write_text(json.dumps(original))
        self.host_base, self.host_unit_dir, self.host_config_dir = base, unit_dir, config_dir
        self.host_location, self.host_original = location, original
        self.metadata_attempts = 0
        self.metadata_timeouts = []
        self.now = 0

        def unpack(archive, checksum, release):
            release.mkdir()
            (release / 'server.mjs').write_text('// owned preview')
            return dict(version='preview', wasmSHA256='synthetic')

        def fetch(url):
            if url.startswith('http://127.0.0.1:18892'):
                return 200, {}, b'{"version":"preview"}'
            if deploy.PREFIX in url:
                if route_change:
                    location.write_bytes(location.read_bytes() + b'# external concurrent route\n')
                headers = {'Cross-Origin-Opener-Policy': 'same-origin',
                           'Cross-Origin-Embedder-Policy': 'require-corp',
                           'Content-Security-Policy': "connect-src 'self' wss://game.invalid"}
                body = {'version': 'wrong-version' if wrong_version else 'preview', 'network': {'enabled': True}}
                if public_responses:
                    status, body = public_responses[min(self.metadata_attempts - 1, len(public_responses) - 1)]
                    return status, headers, body if isinstance(body, bytes) else json.dumps(body).encode()
                return 200, headers, json.dumps(body).encode()
            return 200, {}, b'{"version":"accepted-single-player"}'

        def fetch_metadata(url, timeout):
            self.metadata_attempts += 1
            self.metadata_timeouts.append(timeout)
            return fetch(url)

        def sleep(seconds):
            self.now += seconds

        session_queries = 0

        def run(*args):
            nonlocal session_queries
            result = self.run_command(*args)
            if args[:3] == ('systemctl', 'show', 'joey-session.service'):
                session_queries += 1
                return '2' if session_changed and session_queries > 1 else '1'
            return result

        with mock.patch.object(deploy, 'Path', side_effect=mapped_path), \
             mock.patch.object(deploy.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=1000, pw_gid=1000)), \
             mock.patch.object(deploy.os, 'chown'), \
             mock.patch.object(deploy.socket, 'socket'), \
             mock.patch.object(deploy, 'run', side_effect=run), \
             mock.patch.object(deploy, 'unpack_preview', side_effect=unpack), \
             mock.patch.object(deploy, 'fetch', side_effect=fetch), \
             mock.patch.object(deploy, 'fetch_metadata', side_effect=fetch_metadata), \
             mock.patch.object(deploy.time, 'monotonic', side_effect=lambda: self.now), \
             mock.patch.object(deploy.time, 'sleep', side_effect=sleep), \
             mock.patch.object(deploy, 'wrist_state', return_value=(123, b'unchanged')), \
             mock.patch('builtins.print'):
            deploy.main(self.root / 'synthetic.tgz', 'a' * 64)

    def test_main_preserves_original_failure_and_cleans_after_route_conflict(self):
        with self.assertRaisesRegex(RuntimeError, 'rollback incomplete') as caught:
            self.install(wrong_version=True, route_change=True)
        self.assertIn('metadata failed', str(caught.exception.__cause__))
        self.assertIn(b'# external concurrent route', self.host_location.read_bytes())
        self.assert_stopped_attempted()
        self.assertFalse((self.host_unit_dir / deploy.UNIT).exists())
        self.assertFalse((self.host_config_dir / 'online-preview-config.json').exists())
        self.assertEqual(list((self.host_base / 'online-preview-releases').iterdir()), [])
        self.assertEqual(json.loads((self.host_config_dir / 'original-config.json').read_text()), self.host_original)

    def test_success_checks_session_service_and_records_installation(self):
        self.install()
        session_query = ('systemctl', 'show', 'joey-session.service', '-p', 'MainPID', '--value')
        self.assertEqual(self.calls.count(session_query), 2)
        self.assertTrue((self.host_base / 'online-preview-deployment.json').exists())
        self.assertNotIn(('systemctl', 'stop', deploy.UNIT), self.calls)

    def test_changed_session_service_prevents_success_and_rolls_back(self):
        with self.assertRaisesRegex(RuntimeError, 'Unrelated service changed'):
            self.install(session_changed=True)
        self.assert_stopped_attempted()
        self.assertEqual(self.host_location.read_bytes(), self.before)
        self.assertFalse((self.host_base / 'online-preview-deployment.json').exists())

    def test_healthy_metadata_cannot_hide_concurrent_route_change(self):
        with self.assertRaisesRegex(RuntimeError, 'rollback incomplete') as caught:
            self.install(route_change=True)
        self.assertIn('refusing to report successful installation', str(caught.exception.__cause__))
        self.assertIn(b'# external concurrent route', self.host_location.read_bytes())
        self.assert_stopped_attempted()
        self.assertFalse((self.host_base / 'online-preview-deployment.json').exists())
        self.assertEqual(list((self.host_base / 'online-preview-releases').iterdir()), [])

    def test_public_404_after_reload_retries_until_exact_version_is_ready(self):
        self.install(public_responses=[(404, b'<html>old nginx route</html>'),
                                      (200, {'version': 'preview', 'network': {'enabled': True}})])
        self.assertEqual(self.metadata_attempts, 2)
        self.assertEqual(self.now, .25)
        self.assertTrue((self.host_base / 'online-preview-deployment.json').exists())
        self.assertNotIn(('systemctl', 'stop', deploy.UNIT), self.calls)

    def test_public_old_version_after_reload_retries_until_exact_version_is_ready(self):
        self.install(public_responses=[(200, {'version': 'old', 'network': {'enabled': True}}),
                                      (200, {'version': 'preview', 'network': {'enabled': True}})])
        self.assertEqual(self.metadata_attempts, 2)
        self.assertEqual(self.now, .25)
        self.assertTrue((self.host_base / 'online-preview-deployment.json').exists())

    def test_permanent_wrong_version_is_bounded_and_rolls_back_with_safe_details(self):
        with self.assertRaisesRegex(RuntimeError, 'metadata failed') as caught:
            self.install(wrong_version=True)
        self.assertIn('"status": 200', str(caught.exception))
        self.assertIn('"version": "wrong-version"', str(caught.exception))
        self.assertEqual(self.metadata_attempts, 40)
        self.assertLessEqual(self.now, 10)
        self.assertTrue(all(0 < timeout <= 2 for timeout in self.metadata_timeouts))
        self.assert_stopped_attempted()
        self.assertEqual(self.host_location.read_bytes(), self.before)
        self.assertFalse((self.host_base / 'online-preview-deployment.json').exists())
        self.assertEqual(list((self.host_base / 'online-preview-releases').iterdir()), [])

    def test_exact_version_with_truthy_non_boolean_network_flag_never_passes(self):
        with self.assertRaisesRegex(RuntimeError, 'metadata failed'):
            self.install(public_responses=[(200, {'version': 'preview', 'network': {'enabled': 'true'}})])
        self.assert_stopped_attempted()
        self.assertFalse((self.host_base / 'online-preview-deployment.json').exists())


if __name__ == '__main__':
    unittest.main()
