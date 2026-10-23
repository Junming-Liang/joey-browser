#!/usr/bin/env python3
"""Keep game assets on the existing game limiter, without changing other routes."""
import hashlib
import json
from pathlib import Path
from deploy_preview import replace_route, run, wrist_state

def main():
    path=Path('/opt/joey-web/nginx-location.conf')
    before=path.read_bytes();after=before
    directive=b'    limit_req zone=joey_edge burst=120 nodelay;\n'
    changed=[]
    for prefix in ['/joey/original/','/joey/online-preview/','/joey/custom-preview/']:
        headers=[f'location ^~ {prefix} {{\n',f'location = {prefix}api/network {{\n']
        for header in headers:
            marker=header.encode()
            if marker not in before:continue
            if before.count(marker)!=1:raise RuntimeError('Ambiguous game route')
            block=before.split(marker,1)[1].split(b'\n}',1)[0]
            if b'limit_req ' in block:
                if directive.strip() not in block:raise RuntimeError('Unexpected game request policy')
                continue
            after=after.replace(marker,marker+directive,1);changed.append(header.strip())
    if not changed:
        print(json.dumps({'changed':False}));return
    # No other bytes may change: this also protects all non-game locations.
    restored=after
    for header in changed:restored=restored.replace((header+'\n').encode()+directive,(header+'\n').encode(),1)
    if restored!=before:raise RuntimeError('Unexpected route change')
    wrist=wrist_state()
    backup=path.with_name('nginx-location.before-game-limits-'+hashlib.sha256(before).hexdigest()[:12]+'.conf')
    if not backup.exists():backup.write_bytes(before)
    replace_route(path,after,before)
    try:
        run('/usr/local/nginx/sbin/nginx','-t')
        run('systemctl','reload','nginx.service')
        if wrist_state()!=wrist:raise RuntimeError('Unrelated service changed')
    except Exception:
        replace_route(path,before,after)
        run('/usr/local/nginx/sbin/nginx','-t');run('systemctl','reload','nginx.service')
        raise
    print(json.dumps({'changed':True,'locations':changed,'otherRouteBytesUnchanged':True,'wristUnchanged':True,'backup':str(backup)}))

if __name__=='__main__':main()
