#!/usr/bin/env python3
"""Update only this task's independent original preview; never modify nginx routes."""
import argparse,hashlib,json,os,pwd,time
from pathlib import Path
from deploy_preview import sha,fetch,run,wrist_state,unpack_preview,install_resource_pack,check_compatible_resources,check_original_quality_pack

def main(archive,checksum,resource_pack=None,online_preview=False):
    if sha(archive)!=checksum:raise RuntimeError('Update archive mismatch')
    base=Path('/opt/joey-web')
    name='online-preview' if online_preview else 'original'
    service='joey-online-preview.service' if online_preview else 'joey-original.service'
    prefix='/joey/online-preview/' if online_preview else '/joey/original/'
    port=18892 if online_preview else 18891
    config_path=Path('/etc/joey-web')/(name+'-config.json');unit=Path('/etc/systemd/system')/service
    prior_config=config_path.read_bytes();config=json.loads(prior_config);old=Path(config['filesRoot']);prior_unit=unit.read_text();prior_revision=json.loads((old/'revision.json').read_text())
    if config['port']!=port or old.parent!=base/(name+'-releases'):raise RuntimeError('Unexpected preview service ownership')
    service_pid=run('systemctl','show',service,'-p','MainPID','--value')
    if service_pid=='0':raise RuntimeError('Existing preview is not running')
    units=['joey-web.service','joey-session.service','joey-native.service','nginx.service', 'joey-original.service' if online_preview else 'joey-online-preview.service'];snapshot=lambda:{name:run('systemctl','show',name,'-p','MainPID','--value') for name in units}
    before=snapshot();route_sha=sha(base/'nginx-location.conf');vhosts=Path('/usr/local/nginx/conf/vhost');hashes={p.name:sha(p) for p in vhosts.glob('*.conf')}
    wrist_before=wrist_state()
    old_http={path:fetch(config['origin']+path)[0] for path in ['/','/joey/','/joey/native/']}
    release=base/(name+'-releases')/(time.strftime('%Y%m%d-%H%M%S')+'-'+checksum[:8])
    revision=unpack_preview(archive,checksum,release)
    if revision['resources']!=prior_revision['resources']:raise RuntimeError('Update must preserve original archive sources')
    check_original_quality_pack(base)
    legacy_paths=[]
    prior_sha=prior_revision.get('packedResources',{}).get('pack',{}).get('sha256')
    for previous in revision['legacyPackedResources']:
        legacy_path=base/'original-resource-packs'/previous['pack']['sha256']/'resources.gzip.pack'
        if prior_sha==previous['pack']['sha256'] or legacy_path.exists():
            if legacy_path.is_symlink() or not legacy_path.is_file() or legacy_path.stat().st_size!=previous['pack']['length'] or sha(legacy_path)!=previous['pack']['sha256']:raise RuntimeError('Previous compressed resource pack missing or changed')
            legacy_paths.append((previous,legacy_path))
    # The resource pack is intentionally separate from the bounded code tar.
    # It has one pinned name/size/hash and remains readable by a rollback release.
    packed=revision['packedResources'];pack=packed['pack']
    pack_root=install_resource_pack(base,resource_pack);pack_path=pack_root/'resources.gzip.pack'
    old_work='WorkingDirectory='+str(old);old_exec='ExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 '+str(old)+'/server.mjs'
    if prior_unit.count(old_work)!=1 or prior_unit.count(old_exec)!=1:raise RuntimeError('Unexpected preview unit contents')
    account=pwd.getpwnam('joeyweb')
    def write_config(data):
        temporary=config_path.with_suffix('.update.tmp');temporary.write_bytes(data);temporary.chmod(0o600);os.chown(temporary,account.pw_uid,account.pw_gid);temporary.replace(config_path)
    updated_unit=prior_unit.replace(old_work,'WorkingDirectory='+str(release)).replace(old_exec,'ExecStart=/opt/wrist-node/bin/node --max-old-space-size=64 '+str(release)+'/server.mjs')
    config['filesRoot']=str(release)
    config['packedResourcesRoot']=str(pack_root)
    config.pop('passwordSalt',None);config.pop('passwordHash',None)
    try:
        write_config(json.dumps(config).encode());unit.write_text(updated_unit);run('systemd-analyze','verify',str(unit));run('systemctl','daemon-reload');run('systemctl','restart',service)
        for attempt in range(60):
            try:
                status,headers,body=fetch(config['origin']+prefix+'api/session');session=json.loads(body)
                if status==200 and session.get('version')==revision['version']:break
            except (OSError,ValueError):pass
            time.sleep(.25)
        else:raise RuntimeError('Updated preview did not become ready')
        if headers.get('Cross-Origin-Opener-Policy')!='same-origin' or headers.get('Cross-Origin-Embedder-Policy')!='require-corp':raise RuntimeError('Updated preview isolation missing')
        if session.get('access')!='public' or len(session.get('resources',[]))!=3 or not session.get('program'):raise RuntimeError('Public game metadata unavailable')
        if session.get('packedResources')!=packed:raise RuntimeError('Public compressed resource metadata mismatch')
        check_compatible_resources(config['origin'],session,revision,legacy_paths)
        status,_,body=fetch(config['origin']+packed['manifestURL'])
        if status!=200 or hashlib.sha256(body).hexdigest()!=packed['manifestSHA256']:raise RuntimeError('Public compressed index mismatch')
        status,pack_headers,body=fetch(config['origin']+pack['url'],headers={'Range':'bytes=0-4095'})
        with pack_path.open('rb') as source:expected=source.read(4096)
        if status!=206 or body!=expected or pack_headers.get('Content-Range')!=f"bytes 0-4095/{pack['length']}" or pack_headers.get('Content-Encoding') or pack_headers.get('Cache-Control')!='no-store':raise RuntimeError('Public compressed range mismatch')
        status,wasm_headers,_=fetch(config['origin']+prefix+'joey_original_bg.wasm',method='HEAD',headers={'Accept-Encoding':'gzip'})
        if status!=200 or wasm_headers.get('Content-Encoding')!='gzip':raise RuntimeError('Updated WASM unavailable')
        for item in revision['resources']:
            end=min(item['length']-1,4095)
            status,range_headers,body=fetch(config['origin']+prefix+'resources/'+item['name'],headers={'Range':f'bytes=0-{end}'})
            with (Path(config['resourcesRoot'])/item['name']).open('rb') as source:expected=source.read(end+1)
            if status!=206 or body!=expected or range_headers.get('Content-Range')!=f"bytes 0-{end}/{item['length']}":raise RuntimeError('Public range read failed '+item['name'])
        after=snapshot();after_http={path:fetch(config['origin']+path)[0] for path in old_http}
        if before!=after or hashes!={p.name:sha(p) for p in vhosts.glob('*.conf')} or route_sha!=sha(base/'nginx-location.conf') or wrist_before!=wrist_state() or old_http!=after_http:raise RuntimeError('Existing functions changed during preview update')
        report={'url':config['origin']+prefix,'version':revision['version'],'release':str(release),'previousRelease':str(old),'archiveSHA256':checksum,'wasmSHA256':revision['wasmSHA256'],'before':before,'after':after,'vhosts':hashes,'vhostFilesUnchanged':True,'nginxRouteUnchanged':True,'wristPID':wrist_before[0],'wristStartUnchanged':True,'legacyIngressBefore':old_http,'legacyIngressAfter':after_http,'access':'public','publicMetadataRangesAndWasmPassed':True,'wasmGzipBytes':int(wasm_headers['Content-Length'])}
        report.update(packedResources=packed,legacyPackedResources=revision['legacyPackedResources'],originalPackedResources=revision['originalPackedResources'],qualityProfile=revision['qualityProfile'],compressedResourceRangesPassed=True)
        (base/('online-preview-deployment.json' if online_preview else 'original-preview-deployment.json')).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report),flush=True)
    except Exception:
        write_config(prior_config);unit.write_text(prior_unit);run('systemctl','daemon-reload');run('systemctl','restart',service);raise
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('archive',type=Path);parser.add_argument('sha256');parser.add_argument('--resource-pack',type=Path);parser.add_argument('--online-preview',action='store_true');args=parser.parse_args();main(args.archive,args.sha256,args.resource_pack,args.online_preview)
