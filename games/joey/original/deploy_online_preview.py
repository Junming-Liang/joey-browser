#!/usr/bin/env python3
"""Install the online preview beside the accepted single-player service."""
import argparse
import http.client
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import ssl
import time
import urllib.error
import urllib.request
from deploy_preview import fetch, replace_route, run, sha, unpack_preview, wrist_state

PREFIX = '/joey/online-preview/'
UNIT = 'joey-online-preview.service'
PORT = 18892
CONFIG_NAME = 'online-preview-config.json'
RELEASE_NAME = 'online-preview-releases'
REPORT_NAME = 'online-preview-deployment.json'
PREVIEW_FLAG = 'preview'


def fetch_metadata(url, timeout):
    # A separate short request deadline avoids the general fetch's 15 seconds.
    request = urllib.request.Request(url, headers={'Connection': 'close', 'Cache-Control': 'no-cache'})
    try:
        response = urllib.request.urlopen(request, context=ssl._create_unverified_context(), timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, dict(response.headers), response.read(65537)


def wait_for_public_session(url, version):
    # A signal-based nginx reload returns before the new workers are ready.
    deadline = time.monotonic() + 10
    last = {'status': None, 'version': None, 'networkEnabled': None}
    for attempt in range(40):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        last = {'status': None, 'version': None, 'networkEnabled': None}
        try:
            status, headers, body = fetch_metadata(url, min(2, remaining))
            last['status'] = status
            if len(body) > 65536:
                raise ValueError('Metadata exceeds size limit')
            session = json.loads(body)
            if not isinstance(session, dict):
                raise ValueError('Metadata is not an object')
            observed = session.get('version')
            last['version'] = observed[:128] if isinstance(observed, str) else None
            network = session.get('network')
            enabled = network.get('enabled') if isinstance(network, dict) else None
            last['networkEnabled'] = enabled if isinstance(enabled, bool) else None
            if status == 200 and observed == version and enabled is True and time.monotonic() <= deadline:
                return headers
        except (OSError, ValueError, http.client.HTTPException) as error:
            # Never include a response body, URL, credentials or exception text.
            last['error'] = type(error).__name__
        remaining = deadline - time.monotonic()
        if remaining <= 0 or attempt == 39:
            break
        time.sleep(min(.25, remaining))
    raise RuntimeError('Online preview metadata failed: ' + json.dumps(last, sort_keys=True))


def rollback_install(location, before_route, installed_route, unit, unit_content,
                     config_path, config_content, release, *, route_changed,
                     service_attempted, unit_created, config_created):
    """Clean each owned resource independently; preserve changed or live inputs."""
    errors = []

    def attempt(label, operation):
        try:
            operation()
            return True
        except Exception as error:
            errors.append(f'{label}: {error}')
            return False

    if route_changed:
        restored = attempt('restore route', lambda: replace_route(location, before_route, installed_route))
        if restored and attempt('validate restored nginx route', lambda: run('/usr/local/nginx/sbin/nginx', '-t')):
            attempt('reload restored nginx route', lambda: run('systemctl', 'reload', 'nginx.service'))

    stopped = not service_attempted
    if service_attempted:
        # A route conflict must never prevent stopping our separate preview.
        attempt('stop preview service', lambda: run('systemctl', 'stop', UNIT))
        attempt('disable preview service', lambda: run('systemctl', 'disable', UNIT))

        def confirm_stopped():
            pid = run('systemctl', 'show', UNIT, '-p', 'MainPID', '--value')
            state = run('systemctl', 'show', UNIT, '-p', 'ActiveState', '--value')
            if pid != '0' or state not in ['inactive', 'failed']:
                raise RuntimeError('preview process is still active or restarting')

        stopped = attempt('confirm preview stopped', confirm_stopped)

    def check_owned(path, expected):
        if not path.exists() and not path.is_symlink():
            return
        if path.is_symlink() or path.read_bytes() != expected:
            raise RuntimeError('concurrent file change; preserving ' + str(path))

    def remove_owned(path, expected):
        check_owned(path, expected)
        path.unlink(missing_ok=True)

    if stopped:
        # A changed unit may still refer to our config and release. Preserve the
        # complete set instead of making that concurrent update unusable.
        unit_owned = not unit_created or attempt('check owned preview unit', lambda: check_owned(unit, unit_content.encode()))
        config_owned = not config_created or attempt('check owned preview config', lambda: check_owned(config_path, config_content.encode()))
        if unit_owned and config_owned:
            unit_removed = not unit_created or attempt('remove owned preview unit', lambda: remove_owned(unit, unit_content.encode()))
            config_removed = not config_created or attempt('remove owned preview config', lambda: remove_owned(config_path, config_content.encode()))
            if unit_created:
                attempt('reload systemd after cleanup', lambda: run('systemctl', 'daemon-reload'))
            if unit_removed and config_removed:
                attempt('remove owned preview release', lambda: shutil.rmtree(release) if release.exists() else None)
            else:
                errors.append('preview release retained because a unit or config could still reference it')
        else:
            errors.append('preview unit, config and release retained because concurrent configuration could still reference them')
    else:
        errors.append('preview unit, config and release retained because process termination was not confirmed')
    return errors


def main(archive, checksum):
    base = Path('/opt/joey-web')
    location = base / 'nginx-location.conf'
    unit = Path('/etc/systemd/system') / UNIT
    config_path = Path('/etc/joey-web') / CONFIG_NAME
    before_route = location.read_bytes()
    if PREFIX.encode() in before_route or unit.exists() or config_path.exists():
        raise RuntimeError('Online preview already exists; refusing to overwrite')
    with socket.socket() as check:
        check.bind(('127.0.0.1', PORT))
    original = json.loads(Path('/etc/joey-web/original-config.json').read_text())
    origin = original['origin']
    units = ['joey-web.service', 'joey-session.service', 'joey-native.service', 'joey-original.service', 'nginx.service']
    snapshot = lambda: {name: run('systemctl', 'show', name, '-p', 'MainPID', '--value') for name in units}
    before = snapshot()
    wrist_before = wrist_state()
    ingress = ['/', '/joey/', '/joey/native/', '/joey/original/api/session']
    old_http = {path: fetch(origin + path)[0] for path in ingress}
    stable_version = json.loads(fetch(origin + ingress[-1])[2])['version']
    vhosts = Path('/usr/local/nginx/conf/vhost')
    vhost_hashes = {path.name: sha(path) for path in vhosts.glob('*.conf')}
    account = pwd.getpwnam('joeyweb')
    config = {key: original[key] for key in ['origin', 'resourcesRoot', 'packedResourcesRoot']}
    releases = base / RELEASE_NAME
    releases.mkdir(exist_ok=True, mode=0o755)
    release = releases / (time.strftime('%Y%m%d-%H%M%S') + '-' + checksum[:8])
    revision = unpack_preview(archive, checksum, release)
    config.update(filesRoot=str(release), port=PORT, network=True)
    config[PREVIEW_FLAG] = True
    config_content = json.dumps(config)
    unit_content = f'''[Unit]
Description=Joey online duel isolated preview
After=network.target

[Service]
Type=simple
User=joeyweb
Group=joeyweb
WorkingDirectory={release}
Environment=JOEY_ORIGINAL_CONFIG={config_path}
ExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 {release}/server.mjs
Restart=on-failure
RestartSec=5
PrivateTmp=yes
PrivateDevices=yes
ProtectHome=yes
ProtectSystem=strict
NoNewPrivileges=yes
CapabilityBoundingSet=
RestrictSUIDSGID=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_UNIX
UMask=0077
Nice=19
MemoryHigh=128M
MemoryMax=192M
CPUQuota=20%
CPUWeight=1
IOWeight=1
TasksMax=32

[Install]
WantedBy=multi-user.target
'''
    route = f'''
# Browser-local original duel; isolated room relay preview.
location = {PREFIX.rstrip("/")} {{ return 302 {PREFIX}; }}
location = {PREFIX}api/network {{
    limit_req zone=joey_edge burst=120 nodelay;
    proxy_pass http://127.0.0.1:{PORT};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;
    proxy_send_timeout 30s;
    proxy_buffering off;
}}
location ^~ {PREFIX} {{
    limit_req zone=joey_edge burst=120 nodelay;
    proxy_pass http://127.0.0.1:{PORT};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 30s;
    client_max_body_size 8k;
    gzip off;
}}
'''.encode()
    installed_route = before_route + route
    config_created = unit_created = service_attempted = route_changed = False
    try:
        with config_path.open('x') as target:
            config_created = True
            config_path.chmod(0o600)
            target.write(config_content)
        os.chown(config_path, account.pw_uid, account.pw_gid)
        with unit.open('x') as target:
            unit_created = True
            target.write(unit_content)
        run('systemd-analyze', 'verify', str(unit))
        run('systemctl', 'daemon-reload')
        service_attempted = True
        run('systemctl', 'enable', '--now', UNIT)
        for attempt in range(40):
            try:
                status, _, body = fetch(f'http://127.0.0.1:{PORT}{PREFIX}api/session')
                if status == 200 and json.loads(body)['version'] == revision['version']:
                    break
            except (OSError, ValueError):
                pass
            time.sleep(.25)
        else:
            raise RuntimeError('Online preview failed to start')
        shutil.copy2(location, base / ('nginx-location.before-online-' + checksum[:8] + '.conf'))
        replace_route(location, installed_route, before_route)
        route_changed = True
        run('/usr/local/nginx/sbin/nginx', '-t')
        run('systemctl', 'reload', 'nginx.service')
        headers = wait_for_public_session(origin + PREFIX + 'api/session', revision['version'])
        if headers.get('Cross-Origin-Opener-Policy') != 'same-origin' or headers.get('Cross-Origin-Embedder-Policy') != 'require-corp':
            raise RuntimeError('Online preview browser isolation missing')
        socket_origin = origin.replace('https://', 'wss://', 1).replace('http://', 'ws://', 1)
        if socket_origin not in headers.get('Content-Security-Policy', ''):
            raise RuntimeError('Online preview socket policy missing')
        if snapshot() != before or wrist_state() != wrist_before or vhost_hashes != {path.name: sha(path) for path in vhosts.glob('*.conf')}:
            raise RuntimeError('Unrelated service changed during preview install')
        if old_http != {path: fetch(origin + path)[0] for path in ingress} or json.loads(fetch(origin + ingress[-1])[2])['version'] != stable_version:
            raise RuntimeError('Existing ingress or single-player version changed')
        if location.read_bytes() != installed_route:
            raise RuntimeError('Concurrent nginx route change; refusing to report successful installation')
        report = dict(url=origin + PREFIX, version=revision['version'], release=str(release),
                      archiveSHA256=checksum, wasmSHA256=revision['wasmSHA256'],
                      stableVersion=stable_version, originalServiceUnchanged=True,
                      unrelatedServicesUnchanged=True, nginxRouteAppended=True,
                      status='isolated online preview; public WSS and real duel verification required')
        (base / REPORT_NAME).write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report))
    except Exception as error:
        cleanup_errors = rollback_install(
            location, before_route, installed_route, unit, unit_content,
            config_path, config_content, release, route_changed=route_changed,
            service_attempted=service_attempted, unit_created=unit_created,
            config_created=config_created)
        if cleanup_errors:
            raise RuntimeError('Online preview installation failed; rollback incomplete: ' + '; '.join(cleanup_errors)) from error
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('sha256')
    args = parser.parse_args()
    main(args.archive, args.sha256)
