#!/usr/bin/env python3
"""Bundle only the original browser preview, its compiled program and provenance."""
import datetime,gzip,hashlib,json,shutil,tarfile,sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
SOURCE=Path(__file__).resolve().parent
OUTPUT=ROOT/'.bridge/joey-web/reverse/output/original-preview'
WASM=ROOT/'.bridge/joey-web/research/original-wasm-fast'
RESOURCES=ROOT/'.bridge/joey-web/reverse/input'
EXPECTED_WASM='9b3d37007d31af4db92674061306ba7a57c2d848a5aab964a8736b6fbf13481e'
ARCHIVES=[('data.dat',333357244,'a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f'),('Voice.dat',145041724,'b23a7158d19f99d0a1a7013a2fbc291ad019768a166ce93cd15d90bca04dcc72'),('Region.dat',1,'e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db')]
PACK_SHA='5554c09969b2bc03233198843b977174f4b3468cae19cb6c9f3d0b0da10275dc'
PACK_BYTES=179562757
ORIGINAL_MANIFEST_SHA='a08083b1fcb062907d495be83941be755397cd0d78e382fb4d38bb71f95689aa'
DERIVED_SHA=['81417b1d6f426caab5034f5155b7143cf09ba4ac63a8b240783cc9eb941428ce','5d0125192966a881ab6fe872505afe5138b2061d169884c5e448ce66ec591d13','e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db']
LEGACY_MANIFEST_SHA='4ff202b30b753adf1fa2487ac352ad4f1e1f4540587b0cea4fedaed0164e7e86'
DECODER_SHA='609f39231686f9feb0fcc68a18d32067423d64f40690c75652c21934ec370909'
def checksum(path):
    digest=hashlib.sha256()
    with path.open('rb') as file:
        for block in iter(lambda:file.read(1048576),b''):digest.update(block)
    return digest.hexdigest()
def main():
    toolchain=json.loads((WASM/'build-provenance.json').read_text())
    if toolchain['wasmSHA256']!=EXPECTED_WASM or toolchain['rustc']['commit-hash']!='db8f076d2619ce2585b0380dda06e8da25a40da4':raise RuntimeError('Unreviewed original toolchain')
    OUTPUT.mkdir(parents=True,exist_ok=True)
    names=['index.html','app.mjs','style.css','browser-host.mjs','original-worker.mjs','player-files.mjs','collection-patch.mjs','collection-catalog.mjs','resource-cache.mjs','resource-reader.mjs','server.mjs']
    for name in names:shutil.copyfile(SOURCE/name,OUTPUT/name)
    for name in ['range-reader.mjs','pcm-audio-host.mjs','pcm-worklet.js','packed-resource-reader.mjs','resource-byte-filter.mjs','structured-byte-filter.mjs','brotli-block-decoder.mjs','brotli-decoder-worker.mjs','brotli-decoder.mjs','brotli-decoder.wasm']:shutil.copyfile(SOURCE.parent/'reverse'/name,OUTPUT/name);names.append(name)
    if checksum(OUTPUT/'brotli-decoder.wasm')!=DECODER_SHA or checksum(OUTPUT/'brotli-decoder.mjs')!='19cf5d13fa62df4ebdf3fcefddeefa54b41fd7cca83be2b553dd5a1e9c81b2d0':raise RuntimeError('Unreviewed integer decoder')
    legacy_bytes=(SOURCE/'legacy-resources.manifest.json').read_bytes()
    if hashlib.sha256(legacy_bytes).hexdigest()!=LEGACY_MANIFEST_SHA:raise RuntimeError('Previous manifest changed')
    (OUTPUT/'legacy-resources.manifest.json').write_bytes(legacy_bytes);names.append('legacy-resources.manifest.json')
    legacy=json.loads(legacy_bytes)
    original_bytes=(SOURCE/'original-resources.manifest.json').read_bytes()
    if hashlib.sha256(original_bytes).hexdigest()!=ORIGINAL_MANIFEST_SHA:raise RuntimeError('Original quality manifest changed')
    (OUTPUT/'original-resources.manifest.json').write_bytes(original_bytes);names.append('original-resources.manifest.json');original=json.loads(original_bytes)
    pack_root=OUTPUT.parent/'compression-20261013/light-pack'
    if (pack_root/'resources.gzip.pack').stat().st_size!=PACK_BYTES or checksum(pack_root/'resources.gzip.pack')!=PACK_SHA:raise RuntimeError('Unreviewed compressed resources')
    packed=json.loads((pack_root/'manifest.json').read_text())
    if packed['pack']['length']!=PACK_BYTES or packed['pack']['sha256']!=PACK_SHA or packed['format']!='joey-light-pack-v3' or packed['archives']!=[dict(path='/'+name,length=length,sha256=sha,derivedSHA256=derived) for (name,length,sha),derived in zip(ARCHIVES,DERIVED_SHA)]:raise RuntimeError('Compressed resource source mismatch')
    packed['pack']['url']='/joey/original/resource-packs/'+PACK_SHA
    packed['decoder']={'url':'/joey/original/brotli-decoder.wasm','length':208441,'sha256':DECODER_SHA,'memoryLimitBytes':33554432}
    (OUTPUT/'resources.manifest.json').write_text(json.dumps(packed,separators=(',',':'))+'\n');names.append('resources.manifest.json')
    for name in ['joey_original.js','joey_original_bg.wasm']:shutil.copyfile(WASM/name,OUTPUT/name);names.append(name)
    if checksum(OUTPUT/'joey_original_bg.wasm')!=EXPECTED_WASM:raise RuntimeError('Unreviewed original WASM build')
    for name,length,sha in ARCHIVES:
        if (RESOURCES/name).stat().st_size!=length or checksum(RESOURCES/name)!=sha:raise RuntimeError('Original archive mismatch: '+name)
    # Use the original archive directory to avoid separate CRT body/tail requests.
    sys.path.insert(0,str(SOURCE.parent/'reverse'))
    from poc_data import archive_index
    layouts={}
    for name,length,sha in ARCHIVES[:2]:
        with (RESOURCES/name).open('rb') as file:
            header=file.read(12)
            count=int.from_bytes(header[8:12],'little')
            if count>100000:raise RuntimeError('Archive directory limit')
            rows=sorted(archive_index(header+file.read(count*268),length),key=lambda row:row['offset'])
        entries=[[0,rows[0]['offset'],0]]
        for row in rows:
            if not row['size']:continue
            if entries[-1][0]+entries[-1][1]!=row['offset']:raise RuntimeError('Archive directory gap')
            streaming=int('\\stream\\' in row['name'])
            if not streaming and row['size']+4095>8388608:raise RuntimeError('Unbounded asset')
            entries.append([row['offset'],row['size'],streaming])
        if entries[-1][0]+entries[-1][1]!=length:raise RuntimeError('Archive directory end')
        layouts['/'+name]={'length':length,'sha256':sha,'entries':entries}
    preload=json.loads((SOURCE/'preload-assets.json').read_text())
    if preload['originalEXESHA256']!='2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77':raise RuntimeError('Preload executable mismatch')
    total=0;transfer_estimate=0
    for path,plan in preload['archives'].items():
        layout=layouts[path]
        if plan['sha256']!=layout['sha256'] or len(plan['assetStarts'])!=len(set(plan['assetStarts'])):raise RuntimeError('Preload source mismatch')
        entries={entry[0]:entry for entry in layout['entries']}
        spans=[]
        for start in plan['assetStarts']:
            entry=entries[start]
            if entry[2]:raise RuntimeError('Preload must not fetch whole music')
            end=min(layout['length'],start+entry[1]+4095)-1
            total+=end-start+1;spans.append((start,end))
        for start,end in plan.get('streamSpans',[]):
            entry=next(entry for entry in layout['entries'] if entry[0]<=start<entry[0]+entry[1])
            if not entry[2] or (start-entry[0])%262144 or end!=min(layout['length'],min(entry[0]+entry[1],start+262144)+4095)-1:raise RuntimeError('Invalid initial music page')
            total+=end-start+1;spans.append((start,end))
        with (RESOURCES/path[1:]).open('rb') as source:
            for start,end in spans:
                source.seek(start);transfer_estimate+=len(gzip.compress(source.read(end-start+1),compresslevel=1,mtime=0))
    if total!=preload['totalBytes'] or total>67108864:raise RuntimeError('Preload budget mismatch')
    (OUTPUT/'resource-layout.mjs').write_text('export const archiveLayouts='+json.dumps(layouts,separators=(',',':'))+';\nexport const preloadAssets='+json.dumps(preload['archives'],separators=(',',':'))+';\n')
    names.append('resource-layout.mjs')
    with (OUTPUT/'joey_original_bg.wasm').open('rb') as source,(OUTPUT/'joey_original_bg.wasm.gz').open('wb') as target:
        with gzip.GzipFile(filename='',mode='wb',compresslevel=6,mtime=0,fileobj=target) as compressed:shutil.copyfileobj(source,compressed)
    hashes={name:checksum(OUTPUT/name) for name in sorted(names)}
    bundle=hashlib.sha256(json.dumps(hashes,sort_keys=True).encode()).hexdigest()
    version=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')+'-'+bundle[:8]
    callbacks=json.loads((ROOT/'.bridge/joey-web/reverse/output/card-callback-entry-provenance.json').read_text())
    revision={'version':version,'bundleSHA256':bundle,'wasmSHA256':EXPECTED_WASM,'preloadBytes':total,'preloadTransferEstimateBytes':transfer_estimate,'preloadEstimateMethod':'sum of pinned common spans compressed with Python gzip level1; original source ranges retained; actual browser transfer must be measured separately','completePreloadBytes':sum(length for name,length,sha in ARCHIVES),'files':hashes,'resources':[dict(name=name,length=length,sha256=sha) for name,length,sha in ARCHIVES],'cardCallbackTableSHA256':callbacks['tableSHA256'],'cardCallbackEntries':len(callbacks['entries']),'mergedEntries':callbacks['mergedEntryCount'],'status':'preview; full player duel and physical-phone fidelity not yet accepted'}
    revision['programGzipSHA256']=checksum(OUTPUT/'joey_original_bg.wasm.gz')
    revision['toolchain']=toolchain
    revision['packedResources']={'manifestURL':'/joey/original/resources.manifest.json','manifestSHA256':hashes['resources.manifest.json'],'pack':packed['pack']}
    revision['originalPackedResources']={'manifestURL':'/joey/original/original-resources.manifest.json','manifestSHA256':ORIGINAL_MANIFEST_SHA,'pack':original['pack']}
    revision['legacyPackedResources']=[revision['originalPackedResources'],{'manifestURL':'/joey/original/legacy-resources.manifest.json','manifestSHA256':LEGACY_MANIFEST_SHA,'pack':legacy['pack']}]
    revision['qualityProfile']=packed['qualityProfile']
    (OUTPUT/'revision.json').write_text(json.dumps(revision,ensure_ascii=False,indent=2)+'\n');names.append('revision.json')
    names.append('joey_original_bg.wasm.gz')
    upstream=ROOT/'.bridge/joey-web/research/theseus'
    if checksum(upstream/'win32/winapi/src/gdi32/joey_glyphs.bin')!='46c4254841927f04888cf3dce97b3e1baa639bdf7b55cdb57d53b229c6d4bc64':raise RuntimeError('Unreviewed font atlas')
    license_names=[path for path in upstream.glob('LICENSE*') if path.is_file()]
    notice='Original-program browser compatibility preview.\nTheseus upstream: https://github.com/evmar/theseus\nPinned commit: 0fe848f1905a651d843668400f0ad46ed4e212c0\nCompatibility patch: games/joey/reverse/theseus-joey.patch\nOriginal game artwork, executable and audio belong to their respective owners.\n\n'
    for path in license_names:notice+=path.name+'\n'+path.read_text()+'\n'
    notice+='\nEmbedded glyphs: canonical installed WenQuanYi Micro Hei, requested Songti mapped by Wine 6.0.3.\nRasterized CP936 characters for twelve captured original-game font profiles; cell heights12/14/18 normal/bold quality2/3.\nNative glyph capture SHA256: d8883352d624804e13f23418e688d23123242e5d6e6cdd747e765a6e79be9533\nLossless packed glyphs SHA256: 46c4254841927f04888cf3dce97b3e1baa639bdf7b55cdb57d53b229c6d4bc64\nFont file SHA256: 2420e8078af796b19a3f6ef13de527a1a91c1e7171eea115926c614ced1009b3\nDistributed under the Apache-2.0 alternative offered by the font copyright below.\n'
    for name in ['font-atlas-copyright.txt','font-atlas-Apache-2.0.txt']:notice+='\n'+(SOURCE.parent/'reverse'/name).read_text()+'\n'
    notice+='\n'+(SOURCE.parent/'reverse'/'brotli-decoder-NOTICE.txt').read_text()
    (OUTPUT/'NOTICE.txt').write_text(notice);names.append('NOTICE.txt')
    archive=OUTPUT.parent/('joey-original-preview-'+version+'.tgz')
    with tarfile.open(archive,'w:gz',compresslevel=1) as package:
        for name in names:package.add(OUTPUT/name,arcname=name,recursive=False)
    report={'version':version,'directory':str(OUTPUT),'archive':str(archive),'archiveSHA256':checksum(archive),'archiveBytes':archive.stat().st_size,'wasmGzipBytes':(OUTPUT/'joey_original_bg.wasm.gz').stat().st_size}
    (OUTPUT.parent/'original-preview-build.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
if __name__=='__main__':main()
