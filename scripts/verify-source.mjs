import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=resolve(new URL('..',import.meta.url).pathname);
const manifest=JSON.parse(await readFile(resolve(root,'version.json'),'utf8'));
assert.equal(manifest.version,'0.1.0');
const patch=await readFile(resolve(root,'games/joey/reverse/theseus-joey.patch'));
assert.equal(createHash('sha256').update(patch).digest('hex'),manifest.theseusPatchSHA256);
assert.equal(manifest.includesOriginalGameExecutable,false);
assert.equal(manifest.productionCredentialsIncluded,false);
let checked=0;
async function walk(folder){
 for(const entry of await readdir(folder,{withFileTypes:true})){
  if(['.git','.bridge','node_modules','__pycache__'].includes(entry.name))continue;
  const file=resolve(folder,entry.name);
  if(entry.isDirectory()){await walk(file);continue;}
  assert(!/\.(exe|dat|ydc|ydr|wasm)$/.test(entry.name),'Private/original binary in source: '+relative(root,file));
  if(/\.(mjs|js)$/.test(entry.name)){
   const result=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});
   assert.equal(result.status,0,result.stderr);checked++;
  }
 }
}
await walk(root);
console.log(JSON.stringify({version:manifest.version,runtimeVersion:manifest.runtimeVersion,checkedJavaScriptFiles:checked,compatibilityPatchHashVerified:true}));
