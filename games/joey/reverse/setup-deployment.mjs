// Local complete packages only: restore byte-exact inputs without a Rust build.
import {readFile,open,mkdtemp,rename,link,rm,stat,writeFile,access} from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {brotliDecompressSync,gunzipSync,createGunzip} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {parseArgs} from 'node:util';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {filterOriginalBytes} from './resource-byte-filter.mjs';
import {filterStructuredBytes} from './structured-byte-filter.mjs';

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function fileHash(path){
 const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');
}
export function decodeOriginalBlock(packed,block){
 if(!Number.isSafeInteger(block.length)||block.length<1||block.length>1048576||packed.length!==block.packedLength||digest(packed)!==block.packedSHA256)throw Error('Compressed block checksum or size mismatch');
 if(!['brotli','gzip'].includes(block.codec))throw Error('Unsupported block codec');
 const decoded=(block.codec==='brotli'?brotliDecompressSync:gunzipSync)(packed,{maxOutputLength:block.length,info:true});
 if(decoded.buffer.length!==block.length||decoded.engine.bytesWritten!==packed.length)throw Error('Decompressed block length or tail mismatch');
 const simple=['none','delta-rgb','delta-pcm16','delta-pcm16-plane'];
 const original=simple.includes(block.kind)?filterOriginalBytes(decoded.buffer,block.kind,true):filterStructuredBytes(decoded.buffer,block.kind,block.spans,true);
 if(digest(original)!==block.sha256)throw Error('Restored block checksum mismatch');return original;
}
export async function restoreOriginalArchives(manifest,packPath,destination){
 const names=['/data.dat','/Voice.dat','/Region.dat'];
 if(manifest.format!=='joey-lossless-pack-v2'||manifest.archives.length!==3||names.some(name=>manifest.archives.filter(f=>f.path===name).length!==1))throw Error('Expected original lossless archives');
 if((await stat(packPath)).size!==manifest.pack.length||await fileHash(packPath)!==manifest.pack.sha256)throw Error('Original resource pack checksum mismatch');
 const pack=await open(packPath,'r');
 try{
  for(const file of manifest.archives){
   const path=join(destination,file.path.slice(1));const output=await open(path,'wx');let position=0;
   try{
    for(const block of manifest.blocks.filter(b=>b.path===file.path)){
     if(block.start!==position||!Number.isSafeInteger(block.packedStart)||block.packedStart<0||!Number.isSafeInteger(block.packedLength)||block.packedLength<1||block.packedLength>1049600||block.packedStart+block.packedLength>manifest.pack.length)throw Error('Invalid archive block layout');
     const packed=Buffer.alloc(block.packedLength);let copied=0;
     while(copied<packed.length){const {bytesRead}=await pack.read(packed,copied,packed.length-copied,block.packedStart+copied);if(!bytesRead)throw Error('Truncated original resource pack');copied+=bytesRead;}
     const original=decodeOriginalBlock(packed,block);let written=0;
     while(written<original.length){const {bytesWritten}=await output.write(original,written,original.length-written,position+written);if(!bytesWritten)throw Error('Archive write failed');written+=bytesWritten;}
     position+=original.length;
    }
    if(position!==file.length)throw Error('Incomplete original archive');
    await output.close();
    if(await fileHash(path)!==file.sha256)throw Error('Restored archive checksum mismatch');
   }catch(error){await output.close().catch(()=>{});await rm(path,{force:true});throw error;}
   console.log('Restored and verified '+file.path.slice(1));
  }
 }finally{await pack.close();}
}
const exists=async path=>{try{await access(path);return true;}catch(error){if(error.code!=='ENOENT')throw error;return false;}};
async function setup(){
 const {values}=parseArgs({options:{origin:{type:'string'},port:{type:'string',default:'18891'}}});
 const port=Number(values.port);if(!Number.isSafeInteger(port)||port<1||port>65535)throw Error('Invalid port');
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),origin=new URL(values.origin||'http://127.0.0.1:'+port);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Origin must contain only scheme, host and optional port');
 const configPath=join(root,'config.local.json');if(await exists(configPath))throw Error('Existing config preserved; setup only prepares a new deployment');
 const version=JSON.parse(await readFile(join(root,'version.json'))),site=join(root,'site'),revision=JSON.parse(await readFile(join(site,'revision.json')));
 if(revision.wasmSHA256!==version.wasmSHA256||revision.programGzipSHA256!==version.programGzipSHA256)throw Error('Program identity mismatch');
 for(const [name,hash]of Object.entries(revision.files)){
  if(name==='joey_original_bg.wasm')continue;
  if(!/^[a-zA-Z0-9_.-]+$/.test(name)||await fileHash(join(site,name))!==hash)throw Error('Site asset checksum mismatch: '+name);
 }
 const exe=version.licensedOriginalInputs.find(f=>f.name==='joey_pc_cn.exe');if(await fileHash(join(root,'game',exe.name))!==exe.sha256)throw Error('Original executable checksum mismatch');
 const packs=join(root,'packs'),light=version.packedResources.pack,original=version.originalPackedResources.pack;
 const lightPath=join(packs,light.sha256,'resources.gzip.pack'),originalPath=join(packs,original.sha256,'resources.gzip.pack');
 if((await stat(lightPath)).size!==light.length||await fileHash(lightPath)!==light.sha256)throw Error('Light resource pack checksum mismatch');
 const manifestBytes=await readFile(join(site,'original-resources.manifest.json'));
 if(digest(manifestBytes)!==version.originalPackedResources.manifestSHA256)throw Error('Original manifest checksum mismatch');
 const manifest=JSON.parse(manifestBytes);if(JSON.stringify(manifest.pack)!==JSON.stringify(original))throw Error('Original pack identity mismatch');
 const resources=join(root,'resources');
 if(await exists(resources)){
  for(const file of manifest.archives)if(await fileHash(join(resources,file.path.slice(1)))!==file.sha256)throw Error('Existing resource files preserved: checksum mismatch');
 }else{
  const temporary=await mkdtemp(join(root,'.restore-'));
  try{await restoreOriginalArchives(manifest,originalPath,temporary);await rename(temporary,resources);}finally{await rm(temporary,{recursive:true,force:true});}
 }
 const wasm=join(site,'joey_original_bg.wasm');
 if(await exists(wasm)){if(await fileHash(wasm)!==version.wasmSHA256)throw Error('Existing program preserved: checksum mismatch');}
 else{
  const compressed=join(site,'joey_original_bg.wasm.gz');if(await fileHash(compressed)!==version.programGzipSHA256)throw Error('Compressed program checksum mismatch');
  const temporary=await mkdtemp(join(root,'.program-')),output=join(temporary,'program.wasm');
  try{await pipeline(createReadStream(compressed),createGunzip(),createWriteStream(output,{flags:'wx'}));if((await stat(output)).size!==version.wasmBytes||await fileHash(output)!==version.wasmSHA256)throw Error('Restored program checksum mismatch');await link(output,wasm);}finally{await rm(temporary,{recursive:true,force:true});}
 }
 await writeFile(configPath,JSON.stringify({origin:origin.origin,port,filesRoot:site,resourcesRoot:resources,packedResourcesRoot:join(packs,light.sha256)},null,2)+'\n',{flag:'wx',mode:0o600});
 console.log('Setup complete. Start in this directory:');
 console.log('JOEY_ORIGINAL_CONFIG="$PWD/config.local.json" node --max-old-space-size=64 site/server.mjs');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)setup().catch(error=>{console.error(error.message);process.exitCode=1;});
