#!/usr/bin/env python3
"""Publish a checked original preview on its own route and bounded loopback service."""
import argparse,gzip,hashlib,json,os,pwd,shutil,socket,ssl,subprocess,tarfile,tempfile,time,urllib.request,urllib.error
from pathlib import Path

PREVIEW_FILES={'index.html','app.mjs','style.css','browser-host.mjs','original-worker.mjs','player-files.mjs','collection-patch.mjs','collection-catalog.mjs','resource-cache.mjs','resource-reader.mjs','server.mjs','range-reader.mjs','pcm-audio-host.mjs','pcm-worklet.js','packed-resource-reader.mjs','resource-byte-filter.mjs','structured-byte-filter.mjs','resources.manifest.json','joey_original.js','joey_original_bg.wasm','resource-layout.mjs','brotli-block-decoder.mjs','brotli-decoder-worker.mjs','brotli-decoder.mjs','brotli-decoder.wasm','legacy-resources.manifest.json','original-resources.manifest.json'}
PREVIEW_MEMBERS=PREVIEW_FILES|{'revision.json','joey_original_bg.wasm.gz','NOTICE.txt'}
EXPECTED_WASM='9b3d37007d31af4db92674061306ba7a57c2d848a5aab964a8736b6fbf13481e'
PACK_SHA='5554c09969b2bc03233198843b977174f4b3468cae19cb6c9f3d0b0da10275dc'
PACK_BYTES=179562757
ORIGINAL_SHA='722216f76a656d878246f6cd4337fde2f9f37895670e54e3a02639c35d6e6ef9'
ORIGINAL_BYTES=227949455
ORIGINAL_MANIFEST_SHA='a08083b1fcb062907d495be83941be755397cd0d78e382fb4d38bb71f95689aa'
DERIVED_SHA={'data.dat':'81417b1d6f426caab5034f5155b7143cf09ba4ac63a8b240783cc9eb941428ce','Voice.dat':'5d0125192966a881ab6fe872505afe5138b2061d169884c5e448ce66ec591d13','Region.dat':'e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db'}
LEGACY_SHA='42d626a804979565e5dabe976975c8f5db88b0c4314b9811e44ba4eec2091f49'
LEGACY_BYTES=270625555
LEGACY_MANIFEST_SHA='4ff202b30b753adf1fa2487ac352ad4f1e1f4540587b0cea4fedaed0164e7e86'
DECODER_BYTES=208441
DECODER_SHA='609f39231686f9feb0fcc68a18d32067423d64f40690c75652c21934ec370909'
RESOURCES=[{'name':'data.dat','length':333357244,'sha256':'a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f'},{'name':'Voice.dat','length':145041724,'sha256':'b23a7158d19f99d0a1a7013a2fbc291ad019768a166ce93cd15d90bca04dcc72'},{'name':'Region.dat','length':1,'sha256':'e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db'}]

def run(*args):return subprocess.check_output(args,text=True,stderr=subprocess.STDOUT).strip()
def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda:source.read(1048576),b''):digest.update(block)
    return digest.hexdigest()
def fetch(url,method='GET',headers=None,data=None):
    request=urllib.request.Request(url,method=method,headers=headers or {},data=data)
    try:response=urllib.request.urlopen(request,context=ssl._create_unverified_context(),timeout=15)
    except urllib.error.HTTPError as error:response=error
    with response:return response.status,dict(response.headers),response.read()

def wrist_state():
    pid=run('systemctl','show','wrist-relay.service','-p','MainPID','--value')
    if not pid.isdecimal() or int(pid)<=0:raise RuntimeError('Wrist relay is not running')
    # /proc/stat supplies the start time without exposing process arguments.
    start=Path('/proc/'+pid+'/stat').read_bytes().rsplit(b') ',1)[1].split()[19]
    return int(pid),start

def replace_route(location,content,expected):
    """Keep the current include intact until a complete replacement is ready."""
    if location.read_bytes()!=expected:raise RuntimeError('Concurrent nginx route change; refusing to overwrite')
    metadata=location.stat();temporary=None
    try:
        with tempfile.NamedTemporaryFile(mode='wb',dir=location.parent,prefix='.nginx-original-',delete=False) as target:
            temporary=Path(target.name)
            target.write(content);target.flush();os.fsync(target.fileno())
        os.chown(temporary,metadata.st_uid,metadata.st_gid)
        shutil.copystat(location,temporary)
        if location.read_bytes()!=expected:raise RuntimeError('Concurrent nginx route change; refusing to overwrite')
        os.replace(temporary,location)
    finally:
        if temporary is not None:temporary.unlink(missing_ok=True)

def unpack_preview(archive,checksum,release):
    """Validate the same bounded code bundle for both first install and update."""
    if sha(archive)!=checksum:raise RuntimeError('Preview archive checksum mismatch')
    with tarfile.open(archive,'r:gz') as package:
        entries=[];names=set();total=0
        for entry in package:
            if entry.name not in PREVIEW_MEMBERS or entry.name in names:raise RuntimeError('Invalid preview member allowlist')
            if not entry.isfile() or entry.size<0 or entry.size>104857600:raise RuntimeError('Unsafe preview member')
            total+=entry.size
            if total>134217728:raise RuntimeError('Preview archive exceeds total size limit')
            entries.append(entry);names.add(entry.name)
        if names!=PREVIEW_MEMBERS:raise RuntimeError('Invalid preview member allowlist')
        release.mkdir(parents=True,exist_ok=False)
        try:
            package.extractall(release,members=entries,filter='data')
            for path in release.iterdir():path.chmod(0o644)
            release.chmod(0o755)
            revision=json.loads((release/'revision.json').read_text())
            if set(revision['files'])!=PREVIEW_FILES:raise RuntimeError('Preview file allowlist mismatch')
            for name,expected in revision['files'].items():
                if sha(release/name)!=expected:raise RuntimeError('Preview file mismatch '+name)
            if revision['wasmSHA256']!=EXPECTED_WASM or revision['files']['joey_original_bg.wasm']!=EXPECTED_WASM:raise RuntimeError('Unreviewed original WASM build')
            if revision['resources']!=RESOURCES:raise RuntimeError('Unreviewed original archive sources')
            if sha(release/'joey_original_bg.wasm.gz')!=revision['programGzipSHA256']:raise RuntimeError('Compressed program hash mismatch')
            digest=hashlib.sha256();size=0;wasm_size=(release/'joey_original_bg.wasm').stat().st_size
            with gzip.open(release/'joey_original_bg.wasm.gz','rb') as compressed:
                for block in iter(lambda:compressed.read(1048576),b''):
                    size+=len(block)
                    if size>wasm_size:raise RuntimeError('Compressed WASM size mismatch')
                    digest.update(block)
            if size!=wasm_size or digest.hexdigest()!=EXPECTED_WASM:raise RuntimeError('Compressed WASM mismatch')
            packed=revision['packedResources'];pack=packed['pack']
            if pack['sha256']!=PACK_SHA or pack['length']!=PACK_BYTES or pack['url']!='/joey/original/resource-packs/'+PACK_SHA or packed['manifestURL']!='/joey/original/resources.manifest.json' or packed['manifestSHA256']!=revision['files']['resources.manifest.json']:raise RuntimeError('Unreviewed resource pack identity')
            manifest=json.loads((release/'resources.manifest.json').read_text())
            archives=[dict(path='/'+item['name'],length=item['length'],sha256=item['sha256']) for item in RESOURCES]
            if manifest['pack']!=pack or manifest['archives']!=[dict(**file,derivedSHA256=DERIVED_SHA[file['path'][1:]]) for file in archives]:raise RuntimeError('Compressed resource source mismatch')
            decoder={'url':'/joey/original/brotli-decoder.wasm','length':DECODER_BYTES,'sha256':DECODER_SHA,'memoryLimitBytes':33554432}
            if manifest.get('format')!='joey-light-pack-v3' or manifest.get('decoder')!=decoder or sha(release/'brotli-decoder.wasm')!=DECODER_SHA or (release/'brotli-decoder.wasm').stat().st_size!=DECODER_BYTES:raise RuntimeError('Unreviewed integer decoder')
            legacy={'manifestURL':'/joey/original/legacy-resources.manifest.json','manifestSHA256':LEGACY_MANIFEST_SHA,'pack':{'path':'/__joey_packed_resources_v1','url':'/joey/original/resource-packs/'+LEGACY_SHA,'length':LEGACY_BYTES,'sha256':LEGACY_SHA}}
            previous=json.loads((release/'legacy-resources.manifest.json').read_text())
            original={'manifestURL':'/joey/original/original-resources.manifest.json','manifestSHA256':ORIGINAL_MANIFEST_SHA,'pack':{'path':'/__joey_packed_resources_v1','url':'/joey/original/resource-packs/'+ORIGINAL_SHA,'length':ORIGINAL_BYTES,'sha256':ORIGINAL_SHA}}
            full=json.loads((release/'original-resources.manifest.json').read_text())
            if revision.get('originalPackedResources')!=original or sha(release/'original-resources.manifest.json')!=ORIGINAL_MANIFEST_SHA or full.get('format')!='joey-lossless-pack-v2' or full.get('pack')!=original['pack'] or full.get('archives')!=archives:raise RuntimeError('Original quality resource identity mismatch')
            if revision.get('legacyPackedResources')!=[original,legacy] or sha(release/'legacy-resources.manifest.json')!=LEGACY_MANIFEST_SHA or previous.get('format')!='joey-lossless-gzip-pack-v1' or previous.get('pack')!=legacy['pack'] or previous.get('archives')!=archives:raise RuntimeError('Previous compressed resource identity mismatch')
            return revision
        except Exception:
            shutil.rmtree(release)
            raise

def install_resource_pack(base,resource_pack=None):
    """Install only the independently pinned pack from its dedicated staging path."""
    pack_base=base/'original-resource-packs';pack_root=pack_base/PACK_SHA;pack_path=pack_root/'resources.gzip.pack'
    if pack_base.is_symlink() or pack_root.is_symlink() or pack_path.is_symlink():raise RuntimeError('Unsafe resource pack path')
    if pack_path.exists():
        if not pack_path.is_file() or pack_path.stat().st_size!=PACK_BYTES or sha(pack_path)!=PACK_SHA:raise RuntimeError('Installed resource pack mismatch')
    else:
        if resource_pack!=pack_base/'.incoming-resources.gzip.pack' or not resource_pack.is_file() or resource_pack.is_symlink():raise RuntimeError('Resource pack staging path mismatch')
        if resource_pack.stat().st_size!=PACK_BYTES or sha(resource_pack)!=PACK_SHA:raise RuntimeError('Uploaded resource pack mismatch')
        pack_root.mkdir(exist_ok=False)
        try:
            pack_root.chmod(0o755);resource_pack.chmod(0o644);resource_pack.replace(pack_path)
        except Exception:
            pack_root.rmdir()
            raise
    return pack_root

def check_compatible_resources(origin,session,revision,legacy_paths=()):
    if session.get('legacyPackedResources')!=revision['legacyPackedResources'] or session.get('originalPackedResources')!=revision['originalPackedResources']:raise RuntimeError('Previous resource metadata mismatch')
    for previous in revision['legacyPackedResources']:
        status,_,body=fetch(origin+previous['manifestURL'])
        if status!=200 or hashlib.sha256(body).hexdigest()!=previous['manifestSHA256']:raise RuntimeError('Previous resource index unavailable')
    status,headers,body=fetch(origin+'/joey/original/brotli-decoder.wasm')
    if status!=200 or headers.get('Content-Type')!='application/wasm' or len(body)!=DECODER_BYTES or hashlib.sha256(body).hexdigest()!=DECODER_SHA:raise RuntimeError('Public integer decoder mismatch')
    for previous,legacy_path in legacy_paths:
        status,headers,body=fetch(origin+previous['pack']['url'],headers={'Range':'bytes=0-4095'})
        with legacy_path.open('rb') as source:expected=source.read(4096)
        if status!=206 or body!=expected or headers.get('Content-Range')!=f"bytes 0-4095/{previous['pack']['length']}" or headers.get('Content-Encoding') or headers.get('Cache-Control')!='no-store':raise RuntimeError('Previous compressed range unavailable')

def check_original_quality_pack(base):
    path=base/'original-resource-packs'/ORIGINAL_SHA/'resources.gzip.pack'
    if path.is_symlink() or not path.is_file() or path.stat().st_size!=ORIGINAL_BYTES or sha(path)!=ORIGINAL_SHA:raise RuntimeError('Required original quality resource pack missing or changed')
    return path

def main(archive,checksum,resource_pack=None):
    base=Path('/opt/joey-web');location=base/'nginx-location.conf'
    config_path=Path('/etc/joey-web/original-config.json');unit=Path('/etc/systemd/system/joey-original.service')
    route_before=location.read_bytes();route_sha=hashlib.sha256(route_before).hexdigest()
    if b'/joey/original/' in route_before or unit.exists() or unit.is_symlink():raise RuntimeError('Original route already exists; refusing to overwrite')
    if config_path.exists() or config_path.is_symlink():raise RuntimeError('Preview config already exists; refusing to overwrite')
    account=pwd.getpwnam('joeyweb')
    with socket.socket() as probe:probe.bind(('127.0.0.1',18891))
    units=['joey-web.service','joey-session.service','joey-native.service','nginx.service']
    snapshot=lambda:{name:run('systemctl','show',name,'-p','MainPID','--value') for name in units}
    before=snapshot()
    wrist_before=wrist_state()
    vhosts=Path('/usr/local/nginx/conf/vhost');hashes={path.name:sha(path) for path in vhosts.glob('*.conf')}
    original=json.loads(Path('/etc/joey-web/config.json').read_text());origin=original['origin']
    old_http={path:fetch(origin+path)[0] for path in ['/','/joey/','/joey/native/']}
    release=base/'original-releases'/(time.strftime('%Y%m%d-%H%M%S')+'-'+checksum[:8])
    revision=unpack_preview(archive,checksum,release)
    original_quality_path=check_original_quality_pack(base)
    resources=Path('/var/lib/joey-web/game')
    for item in revision['resources']:
        path=resources/item['name']
        if path.stat().st_size!=item['length'] or sha(path)!=item['sha256']:raise RuntimeError('Server archive mismatch '+item['name'])
    pack_root=install_resource_pack(base,resource_pack);pack_path=pack_root/'resources.gzip.pack';packed=revision['packedResources'];pack=packed['pack']
    config={'origin':origin,'port':18891,'filesRoot':str(release),'resourcesRoot':str(resources),'packedResourcesRoot':str(pack_root)}
    node='/opt/wrist-node/bin/node'
    unit_content=f'''[Unit]
Description=Joey original program browser preview
After=network.target

[Service]
Type=simple
User=joeyweb
Group=joeyweb
WorkingDirectory={release}
Environment=JOEY_ORIGINAL_CONFIG={config_path}
ExecStart={node} --max-old-space-size=64 {release}/server.mjs
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
    route=b'''
# Original executable runs in the browser; this service serves public game bytes.
location = /joey/original { return 302 /joey/original/; }
location ^~ /joey/original/ {
    proxy_pass http://127.0.0.1:18891;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 120s;
    proxy_send_timeout 30s;
    client_max_body_size 2k;
    gzip off;
}
'''
    changed=False;installed_route=route_before+route
    config_created=False;unit_created=False;daemon_reloaded=False;enable_attempted=False
    try:
        with config_path.open('x') as target:
            config_created=True;config_path.chmod(0o600);target.write(json.dumps(config))
        os.chown(config_path,account.pw_uid,account.pw_gid)
        with unit.open('x') as target:
            unit_created=True;target.write(unit_content)
        run('systemd-analyze','verify',str(unit))
        daemon_reloaded=True;run('systemctl','daemon-reload')
        enable_attempted=True;run('systemctl','enable','--now','joey-original.service')
        for attempt in range(40):
            try:
                status,_,body=fetch('http://127.0.0.1:18891/joey/original/api/session')
                if status==200 and json.loads(body)['version']==revision['version']:break
            except OSError:pass
            time.sleep(.25)
        else:raise RuntimeError('Original gateway did not become ready')
        if location.read_bytes()!=route_before:raise RuntimeError('Route changed concurrently; refusing to append')
        backup=base/('nginx-location.before-original-'+checksum[:8]+'.conf');shutil.copy2(location,backup)
        replace_route(location,installed_route,route_before);changed=True
        run('/usr/local/nginx/sbin/nginx','-t');run('systemctl','reload','nginx.service')
        for attempt in range(40):
            try:
                status,headers,body=fetch(origin+'/joey/original/api/session')
                session=json.loads(body)
                if status==200 and session.get('version')==revision['version']:break
            except (OSError,ValueError):pass
            time.sleep(.25)
        else:raise RuntimeError('Public original route did not become ready')
        if headers.get('Cross-Origin-Opener-Policy')!='same-origin' or headers.get('Cross-Origin-Embedder-Policy')!='require-corp':raise RuntimeError('Public shared-memory headers missing')
        if session.get('access')!='public' or len(session.get('resources',[]))!=3 or not session.get('program'):raise RuntimeError('Public game metadata unavailable')
        if session.get('packedResources')!=packed:raise RuntimeError('Public compressed resource metadata mismatch')
        check_compatible_resources(origin,session,revision,[(revision['originalPackedResources'],original_quality_path)])
        status,_,body=fetch(origin+packed['manifestURL'])
        if status!=200 or hashlib.sha256(body).hexdigest()!=packed['manifestSHA256']:raise RuntimeError('Public compressed index mismatch')
        status,pack_headers,body=fetch(origin+pack['url'],headers={'Range':'bytes=0-4095'})
        with pack_path.open('rb') as source:expected=source.read(4096)
        if status!=206 or body!=expected or pack_headers.get('Content-Range')!=f"bytes 0-4095/{pack['length']}" or pack_headers.get('Content-Encoding') or pack_headers.get('Cache-Control')!='no-store':raise RuntimeError('Public compressed range mismatch')
        for item in revision['resources']:
            end=min(item['length']-1,4095)
            status,range_headers,body=fetch(origin+'/joey/original/resources/'+item['name'],headers={'Range':f'bytes=0-{end}'})
            with (resources/item['name']).open('rb') as source:expected=source.read(end+1)
            if status!=206 or body!=expected or range_headers.get('Content-Range')!=f"bytes 0-{end}/{item['length']}":raise RuntimeError('Public range read failed '+item['name'])
        status,wasm_headers,_=fetch(origin+'/joey/original/joey_original_bg.wasm',method='HEAD',headers={'Accept-Encoding':'gzip'})
        if status!=200 or wasm_headers.get('Content-Encoding')!='gzip' or wasm_headers.get('Content-Type')!='application/wasm':raise RuntimeError('Public compressed WASM failed')
        after=snapshot();after_hashes={path.name:sha(path) for path in vhosts.glob('*.conf')}
        wrist_after=wrist_state()
        after_http={path:fetch(origin+path)[0] for path in old_http}
        if before!=after or hashes!=after_hashes or wrist_before!=wrist_after or old_http!=after_http:raise RuntimeError('Existing service or ingress regression')
        report={'url':origin+'/joey/original/','version':revision['version'],'release':str(release),'archiveSHA256':checksum,'priorRouteSHA256':route_sha,'before':before,'after':after,'vhosts':hashes,'vhostFilesUnchanged':True,'wristPID':wrist_before[0],'wristStartUnchanged':True,'legacyIngressBefore':old_http,'legacyIngressAfter':after_http,'access':'public','publicMetadataRangesAndWasmPassed':True,'wasmGzipBytes':int(wasm_headers['Content-Length']),'packedResources':packed,'compressedResourceRangesPassed':True}
        (base/'original-preview-deployment.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
    except Exception:
        if changed:
            if location.read_bytes()!=installed_route:raise RuntimeError('Concurrent nginx route change; manual review needed')
            replace_route(location,route_before,installed_route);run('/usr/local/nginx/sbin/nginx','-t');run('systemctl','reload','nginx.service')
        if enable_attempted:run('systemctl','disable','--now','joey-original.service')
        if unit_created:unit.unlink(missing_ok=True)
        if config_created:config_path.unlink(missing_ok=True)
        if daemon_reloaded:run('systemctl','daemon-reload')
        shutil.rmtree(release)
        raise
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('archive',type=Path);parser.add_argument('sha256');parser.add_argument('--resource-pack',type=Path);args=parser.parse_args();main(args.archive,args.sha256,args.resource_pack)
