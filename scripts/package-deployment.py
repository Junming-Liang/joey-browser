#!/usr/bin/env python3
"""Build a self-contained deployment from locally supplied game inputs."""
import argparse, gzip, hashlib, json, os, tarfile, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            digest.update(chunk)
    return digest.hexdigest()

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    output_root = ROOT / '.bridge/joey-web/reverse/output'
    parser.add_argument('--program-root', type=Path, default=output_root / 'original-preview')
    parser.add_argument('--input-root', type=Path, default=ROOT / '.bridge/joey-web/reverse/input')
    parser.add_argument('--light-pack-root', type=Path, default=output_root / 'compression-20261013/light-pack')
    parser.add_argument('--original-pack-root', type=Path, default=output_root / 'compression-20261013/brotli-pack')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    if output.exists() or Path(str(output) + '.sha256').exists():
        raise RuntimeError('Existing output preserved; choose a new package path')
    version = json.loads((ROOT / 'version.json').read_text())
    revision = json.loads((args.program_root / 'revision.json').read_text())
    if revision['wasmSHA256'] != version['wasmSHA256'] or revision['programGzipSHA256'] != version['programGzipSHA256']:
        raise RuntimeError('Unreviewed program identity')
    runtime = {Path(name).name: sha for name, sha in version['runtimeSources'].items()}
    expected = set(runtime) | {'resource-layout.mjs', 'resources.manifest.json', 'joey_original.js', 'joey_original_bg.wasm'}
    if set(revision['files']) != expected:
        raise RuntimeError('Unexpected site file: private or unrelated files cannot be packaged')
    files = {}
    for name, sha in revision['files'].items():
        if Path(name).name != name or checksum(args.program_root / name) != sha:
            raise RuntimeError('Site checksum mismatch: ' + name)
        if name in runtime and sha != runtime[name]:
            raise RuntimeError('Runtime differs from the accepted source: ' + name)
        if name != 'joey_original_bg.wasm':
            files['site/' + name] = args.program_root / name
    program = args.program_root / 'joey_original_bg.wasm.gz'
    if checksum(program) != version['programGzipSHA256']:
        raise RuntimeError('Compressed program mismatch')
    for item in version['licensedOriginalInputs']:
        path = args.input_root / item['name']
        if path.stat().st_size != item['length'] or checksum(path) != item['sha256']:
            raise RuntimeError('Original input mismatch: ' + item['name'])
    exe = args.input_root / 'joey_pc_cn.exe'
    files.update({'site/joey_original_bg.wasm.gz': program,
                  'site/revision.json': args.program_root / 'revision.json',
                  'site/NOTICE.txt': args.program_root / 'NOTICE.txt',
                  'site/setup-deployment.mjs': ROOT / 'games/joey/reverse/setup-deployment.mjs',
                  'game/joey_pc_cn.exe': exe})
    for key, pack_root in [('packedResources', args.light_pack_root), ('originalPackedResources', args.original_pack_root)]:
        descriptor = version[key]
        pack = pack_root / 'resources.gzip.pack'
        if pack.stat().st_size != descriptor['pack']['length'] or checksum(pack) != descriptor['pack']['sha256']:
            raise RuntimeError('Resource pack mismatch: ' + key)
        index = args.program_root / Path(descriptor['manifestURL']).name
        if checksum(index) != descriptor['manifestSHA256']:
            raise RuntimeError('Resource index mismatch: ' + key)
        files['packs/' + descriptor['pack']['sha256'] + '/resources.gzip.pack'] = pack
    for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'GAME-CONTENT-NOTICE.md', 'version.json', 'docs/LOCAL-DEPLOYMENT.md', 'docs/BUILD.md', 'docs/DEPLOY.md', 'docs/RESOURCE-PACKS.md',
                 'games/joey/reverse/brotli-decoder-NOTICE.txt', 'games/joey/reverse/font-atlas-copyright.txt',
                 'games/joey/reverse/font-atlas-Apache-2.0.txt', 'games/joey/reverse/brotli-decoder-provenance.json']:
        files[name] = ROOT / name
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix='.local-deploy-', delete=False) as raw:
            temporary = Path(raw.name)
            with gzip.GzipFile(filename='', fileobj=raw, mode='wb', compresslevel=1, mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode='w|') as package:
                    for name, path in sorted(files.items()):
                        if not path.is_file() or path.is_symlink():
                            raise RuntimeError('Only regular, explicitly listed files are packaged: ' + name)
                        info = package.gettarinfo(str(path), arcname='joey-browser-' + version['tag'] + '-local/' + name)
                        info.uid = info.gid = 0
                        info.uname = info.gname = ''
                        info.mtime = 0
                        info.mode = 0o644
                        with path.open('rb') as stream:
                            package.addfile(info, stream)
        os.link(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    sha = checksum(output)
    with Path(str(output) + '.sha256').open('x') as sums:
        sums.write(sha + '  ' + output.name + '\n')
    print(json.dumps({'archive': str(output), 'archiveBytes': output.stat().st_size, 'sha256': sha,
                      'containsCompleteOriginalInputs': True, 'originalArchivesRestoredLosslessly': True,
                      'scope': 'self-contained deployment; MIT does not relicense original game content'}))

if __name__ == '__main__':
    main()
