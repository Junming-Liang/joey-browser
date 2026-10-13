import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(new URL('..',import.meta.url).pathname);
const manifest=JSON.parse(await readFile(resolve(root,'version.json'),'utf8'));
const metadata=JSON.parse(await readFile(resolve(root,'package.json'),'utf8'));
assert.equal(manifest.version,metadata.version);
assert.equal(manifest.tag,'v'+metadata.version);
assert.equal(metadata.license,'MIT');
assert((await readFile(resolve(root,'LICENSE'),'utf8')).startsWith('MIT License\n'));
for(const [path,hash] of Object.entries(manifest.runtimeSources)){
 const bytes=await readFile(resolve(root,path));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,'Runtime source differs from the accepted release: '+path);
}
const patch=await readFile(resolve(root,'games/joey/reverse/theseus-joey.patch'));
assert.equal(createHash('sha256').update(patch).digest('hex'),manifest.theseusPatchSHA256);
assert.equal(manifest.includesOriginalGameExecutable,false);
assert.equal(manifest.productionCredentialsIncluded,false);
let checked=0;
const decoderPath='games/joey/reverse/brotli-decoder.wasm';
const decoder=await readFile(resolve(root,decoderPath));
assert.equal(createHash('sha256').update(decoder).digest('hex'),manifest.brotliDecoder.files['brotli-decoder.wasm']);
assert.equal(decoder.length,manifest.brotliDecoder.wasmBytes);
assert(WebAssembly.validate(decoder),'Vendored decoder must be a valid WASM module');
for(const descriptor of manifest.legacyPackedResources){
 const name=descriptor.manifestURL.split('/').at(-1),bytes=await readFile(resolve(root,'games/joey/original',name));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),descriptor.manifestSHA256,'Frozen legacy manifest changed');
 assert.deepEqual(JSON.parse(bytes).pack,descriptor.pack);
}
async function walk(folder){
 for(const entry of await readdir(folder,{withFileTypes:true})){
  if(['.git','.bridge','node_modules','__pycache__'].includes(entry.name))continue;
  const file=resolve(folder,entry.name);
  if(entry.isDirectory()){await walk(file);continue;}
  assert(relative(root,file)===decoderPath||!/\.(exe|dat|ydc|ydr|wasm|pack|zip|tgz|pem|key)$/.test(entry.name),'Private/original binary in source: '+relative(root,file));
  if(/\.(mjs|js)$/.test(entry.name)){
   const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);checked++;
  }
 }
}
await walk(root);
console.log(JSON.stringify({version:manifest.version,runtimeVersion:manifest.runtimeVersion,checkedJavaScriptFiles:checked,checkedRuntimeFiles:Object.keys(manifest.runtimeSources).length,compatibilityPatchHashVerified:true,license:metadata.license}));
