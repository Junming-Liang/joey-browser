import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createGzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {attachNetworkRelay} from './network-relay.mjs';

const resourcePrefix='/joey/original/';
const baseProtocolIdentity='2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77:shim-v1';
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.json':'application/json'};
const assets=['index.html','app.mjs','style.css','browser-host.mjs','collectible-effects.mjs','subtitles.mjs','subtitle-catalog.mjs','custom-resources.mjs','network-packet-policy.mjs','network-host.mjs','original-worker.mjs','player-files.mjs','collection-patch.mjs','collection-catalog.mjs','resource-cache.mjs','resource-reader.mjs','resource-layout.mjs','range-reader.mjs','packed-resource-reader.mjs','resource-byte-filter.mjs','structured-byte-filter.mjs','resources.manifest.json','pcm-audio-host.mjs','pcm-worklet.js','joey_original.js','joey_original_bg.wasm'];
const acceptsGzip=req=>/(?:^|,|\s)gzip(?:\s*(?:,|;|$))/.test(req.headers['accept-encoding']||'')&&!/gzip\s*;\s*q=0(?:\D|$)/.test(req.headers['accept-encoding']||'');
export async function createOriginalServer(config){
  // The online preview uses separate code and service state, but keeps the
  // accepted immutable resource URLs so existing browser caches are reusable.
  const prefix=config.customPreview===true?'/joey/custom-preview/':config.preview===true?'/joey/online-preview/':resourcePrefix;
  const root=resolve(config.filesRoot),resourcesRoot=resolve(config.resourcesRoot);
  const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
  const customResources=revision.customResources;
  if(!customResources||customResources.rulesVersion!=='joey-five-collectible-cards-v2'||customResources.sourceSHA256!=='a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f'||customResources.blob.sha256!==revision.files['custom-resources.bin']||customResources.compressed.sha256!==revision.files['custom-resources.bin.gz'])throw Error('Custom resource identity mismatch');
  const protocolIdentity=baseProtocolIdentity+':collectibles-v2:'+revision.wasmSHA256+':'+customResources.blob.sha256;
  const files=new Map();
  for(const name of [...assets,'brotli-block-decoder.mjs','brotli-decoder-worker.mjs','brotli-decoder.mjs','brotli-decoder.wasm','legacy-resources.manifest.json','original-resources.manifest.json']){const path=resolve(root,name),info=await stat(path);if(!info.isFile())throw Error('Invalid asset '+name);files.set(name,{path,size:info.size,etag:revision.files[name]});}
  const compressed=resolve(root,'joey_original_bg.wasm.gz'),compressedInfo=await stat(compressed);
  const customFiles=new Map();
  for(const [route,name,descriptor] of [['custom-resource-bytes','custom-resources.bin.gz',customResources.compressed],['custom-resource-raw-bytes','custom-resources.bin',customResources.blob]]){
    const path=resolve(root,name),info=await stat(path);
    if(!info.isFile()||info.size!==descriptor.length)throw Error('Custom resource size mismatch');
    customFiles.set(route,{path,size:info.size,sha256:descriptor.sha256});
  }
  if(!/^[a-f0-9]{64}$/.test(revision.programGzipSHA256||''))throw Error('Missing pinned compressed program');
  const resources=new Map(revision.resources.map(file=>[file.name,{...file,path:resolve(resourcesRoot,file.name)}]));
  if(resources.size!==3||!['data.dat','Voice.dat','Region.dat'].every(name=>resources.has(name)))throw Error('Invalid archive allowlist');
  for(const file of resources.values())if((await stat(file.path)).size!==file.length)throw Error('Archive size mismatch '+file.name);
  const packedResources=revision.packedResources,pack=packedResources?.pack;
  if(pack?.sha256!=='5554c09969b2bc03233198843b977174f4b3468cae19cb6c9f3d0b0da10275dc'||pack.length!==179562757||pack.path!=='/__joey_packed_resources_v1'||pack.url!==resourcePrefix+'resource-packs/'+pack.sha256||packedResources.manifestURL!==resourcePrefix+'resources.manifest.json')throw Error('Invalid compressed resource identity');
  const packPath=resolve(config.packedResourcesRoot,'resources.gzip.pack'),packInfo=await stat(packPath);
  if(!packInfo.isFile()||packInfo.size!==pack.length)throw Error('Compressed resource size mismatch');
  const manifestBytes=await readFile(resolve(root,'resources.manifest.json'));
  if(createHash('sha256').update(manifestBytes).digest('hex')!==packedResources.manifestSHA256||JSON.stringify(JSON.parse(manifestBytes).pack)!==JSON.stringify(pack))throw Error('Compressed resource manifest mismatch');
  const legacyPackedResources=revision.legacyPackedResources,originalPackedResources=revision.originalPackedResources;
  const legacyPins=[['original-resources.manifest.json','722216f76a656d878246f6cd4337fde2f9f37895670e54e3a02639c35d6e6ef9',227949455,'a08083b1fcb062907d495be83941be755397cd0d78e382fb4d38bb71f95689aa'],['legacy-resources.manifest.json','42d626a804979565e5dabe976975c8f5db88b0c4314b9811e44ba4eec2091f49',270625555,'4ff202b30b753adf1fa2487ac352ad4f1e1f4540587b0cea4fedaed0164e7e86']];
  if(!Array.isArray(legacyPackedResources)||legacyPackedResources.length!==2||JSON.stringify(originalPackedResources)!==JSON.stringify(legacyPackedResources[0]))throw Error('Invalid previous compressed resource identities');
  const packs=new Map([[pack.sha256,{pack,path:packPath}]]);
  for(const [index,[name,sha,length,manifestSHA]]of legacyPins.entries()){
    const previous=legacyPackedResources[index];
    if(previous?.manifestURL!==resourcePrefix+name||previous.manifestSHA256!==manifestSHA||previous.pack?.sha256!==sha||previous.pack.length!==length||previous.pack.url!==resourcePrefix+'resource-packs/'+sha||previous.pack.path!==pack.path)throw Error('Invalid previous compressed resource identity');
    const previousBytes=await readFile(resolve(root,name));
    if(createHash('sha256').update(previousBytes).digest('hex')!==manifestSHA)throw Error('Previous compressed manifest mismatch');
    const previousPath=resolve(config.packedResourcesRoot,'..',sha,'resources.gzip.pack');
    try{const info=await stat(previousPath);if(!info.isFile()||info.size!==length)throw Error('Previous compressed resource size mismatch');packs.set(sha,{pack:previous.pack,path:previousPath});}catch(error){if(error.code!=='ENOENT'||index===0)throw error;}
  }
  const origin=new URL(config.origin);
  if(!['http:','https:'].includes(origin.protocol)||origin.origin!==config.origin)throw Error('Invalid original gateway config');
  const socketOrigin=(origin.protocol==='https:'?'wss://':'ws://')+origin.host;
  const failureReports=new Map();
  const common={
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
    'Content-Security-Policy':`default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'${config.network===true?' '+socketOrigin:''}; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'`,
    'Cache-Control':'private, no-cache'
  };
  const server=createServer(async(req,res)=>{
    for(const [name,value]of Object.entries(common))res.setHeader(name,value);
    const json=(status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
    try{
      const raw=(req.url||'').split('?')[0];
      if(!raw.startsWith(prefix)||raw.includes('%')||raw.includes('\\')||raw.includes('..'))return json(404,{error:'Not found'});
      const name=raw.slice(prefix.length)||'index.html';
      if(name==='api/failure'&&req.method==='POST'){
        if(req.headers.origin!==config.origin||!(req.headers['content-type']||'').startsWith('application/json'))return json(403,{error:'Invalid origin'});
        const now=Date.now(),ip=String(req.headers['x-real-ip']||req.socket.remoteAddress).slice(0,100);
        for(const [key,value]of failureReports)if(value.until<=now)failureReports.delete(key);
        const bucket=failureReports.get(ip)||{count:0,until:now+900000};
        if(bucket.count>=4)return json(429,{error:'Diagnostic limit'});
        bucket.count++;if(!failureReports.has(ip)&&failureReports.size>=512)failureReports.delete(failureReports.keys().next().value);failureReports.set(ip,bucket);
        let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>8192)return json(413,{error:'Request too large'});}
        let data;try{data=JSON.parse(body);}catch{return json(400,{error:'Invalid body'});}
        if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.error!=='string')return json(400,{error:'Invalid diagnostic'});
        const record={version:revision.version};
        for(const key of ['browser','stage','startupPhase','error','errorName'])if(typeof data[key]==='string')record[key]=data[key].slice(0,key==='error'?2000:300);
        if(Number.isSafeInteger(data.renders)&&data.renders>=0)record.renders=data.renders;
        for(const key of ['secureContext','isolated','sharedMemory'])if(typeof data[key]==='boolean')record[key]=data[key];
        console.error('Original preview failure: '+JSON.stringify(record));
        return json(200,{recorded:true});
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'Method not allowed'},{Allow:'GET, HEAD'});
      // Keep the metadata shape compatible with previously loaded clients.
      if(name==='api/session')return json(200,{authenticated:true,access:'public',version:revision.version,network:{enabled:config.network===true,protocolIdentity},customResources,packedResources,originalPackedResources,legacyPackedResources,qualityProfile:revision.qualityProfile,program:{length:files.get('joey_original_bg.wasm').size,compressedBytes:compressedInfo.size,compressedSHA256:revision.programGzipSHA256,compressedURL:prefix+'program-bytes'},preparation:{commonBytes:revision.preloadBytes,commonCompressedEstimateBytes:revision.preloadTransferEstimateBytes,completeBytes:revision.completePreloadBytes,completeCompressedBytes:pack.length},resources:[...resources.values()].map(file=>({path:'/'+file.name,url:prefix+'resources/'+file.name,compressedURL:prefix+'resource-bytes/'+file.name,length:file.length,sha256:file.sha256}))});
      if(name.startsWith('resource-packs/')&&packs.has(name.slice(15))){
        const {pack,path:packPath}=packs.get(name.slice(15));
        const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||''),start=Number(match?.[1]),end=Number(match?.[2]);
        if(!match||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=pack.length||end-start>=1048576)return json(416,{error:'Exact compressed resource range required'});
        // IndexedDB owns this compressed cache; avoid a second large HTTP copy.
        res.writeHead(206,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Content-Range':`bytes ${start}-${end}/${pack.length}`,'Content-Length':end-start+1,ETag:`"${pack.sha256}"`,'Accept-Ranges':'bytes'});
        if(req.method==='HEAD')return res.end();return stream(packPath,res,{start,end});
      }
      if(customFiles.has(name)){
        const file=customFiles.get(name),match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||''),start=Number(match?.[1]),end=Number(match?.[2]);
        if(!match||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=file.size||end-start>=1048576)return json(416,{error:'Exact custom resource range required'});
        res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Range':`bytes ${start}-${end}/${file.size}`,'Content-Length':end-start+1,ETag:`"${file.sha256}"`,'Accept-Ranges':'bytes','Cache-Control':'no-store'});
        if(req.method==='HEAD')return res.end();return stream(file.path,res,{start,end});
      }
      if(name==='program-bytes'){
        const match=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');
        if(!match)return json(416,{error:'Exact program range required'});
        const start=Number(match[1]),end=Number(match[2]);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=compressedInfo.size||end-start>=1048576)return json(416,{error:'Invalid program range'});
        // Offsets refer to the gzip file itself. No HTTP Content-Encoding here:
        // the client persists compressed bytes and decompresses only after SHA256.
        res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Range':`bytes ${start}-${end}/${compressedInfo.size}`,'Content-Length':end-start+1,ETag:`"${revision.programGzipSHA256}"`,'Accept-Ranges':'bytes'});
        if(req.method==='HEAD')return res.end();return stream(compressed,res,{start,end});
      }
      if(name.startsWith('resource-bytes/')){
        const file=resources.get(name.slice(15));if(!file)return json(404,{error:'Not found'});
        const query=new URL(req.url,config.origin).searchParams,startText=query.get('start'),endText=query.get('end');
        if([...query].length!==2||!/^\d+$/.test(startText||'')||!/^\d+$/.test(endText||''))return json(416,{error:'Exact byte span required'});
        const start=Number(startText),end=Number(endText);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=file.length||end-start>=8388608)return json(416,{error:'Invalid span'});
        // This URL identifies a complete slice representation (HTTP200), so gzip
        // never changes the meaning of HTTP Range offsets on the original route.
        const gzip=acceptsGzip(req),headers={'Content-Type':'application/octet-stream','X-Original-Range':`bytes ${start}-${end}/${file.length}`,Vary:'Accept-Encoding',ETag:`"${file.sha256}-${start}-${end}-${gzip?'gzip':'raw'}"`};
        if(gzip)headers['Content-Encoding']='gzip';else headers['Content-Length']=end-start+1;
        res.writeHead(200,headers);if(req.method==='HEAD')return res.end();return stream(file.path,res,{start,end},gzip);
      }
      if(name.startsWith('resources/')){
        const file=resources.get(name.slice(10));if(!file)return json(404,{error:'Not found'});
        const range=req.headers.range,match=typeof range==='string'&&/^bytes=(\d+)-(\d+)$/.exec(range);
        if(!match)return json(416,{error:'Exact byte range required'},{'Content-Range':`bytes */${file.length}`});
        const start=Number(match[1]),end=Number(match[2]);
        if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||end>=file.length||end-start>=8388608)return json(416,{error:'Invalid range'},{'Content-Range':`bytes */${file.length}`});
        res.writeHead(206,{'Content-Type':'application/octet-stream','Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${file.length}`,'Accept-Ranges':'bytes',ETag:`"${file.sha256}"`});
        if(req.method==='HEAD')return res.end();return stream(file.path,res,{start,end});
      }
      const file=files.get(name);if(!file)return json(404,{error:'Not found'});
      const extension='.'+name.split('.').at(-1),headers={'Content-Type':types[extension],ETag:`"${file.etag}"`};
      let path=file.path,size=file.size;
      if(name==='joey_original_bg.wasm'&&acceptsGzip(req)){
        path=compressed;size=(await stat(compressed)).size;headers['Content-Encoding']='gzip';headers.Vary='Accept-Encoding';
      }
      if(req.headers['if-none-match']===headers.ETag){res.writeHead(304,headers);return res.end();}
      res.writeHead(200,{...headers,'Content-Length':size});if(req.method==='HEAD')return res.end();stream(path,res);
    }catch(error){console.error('Original gateway request failed:',error.message);if(!res.headersSent)json(500,{error:'Request failed'});else res.destroy();}
  });
  server.headersTimeout=10000;server.requestTimeout=15000;server.maxHeadersCount=40;
  if(config.network===true){
    const relay=attachNetworkRelay(server,{path:prefix+'api/network',origin:config.origin,protocolIdentity});
    server.once('close',()=>relay.close());
  }
  return server;
}
function stream(path,res,options={},compressed=false){const reader=createReadStream(path,options),encoder=compressed?createGzip({level:1}):null;reader.on('error',()=>res.destroy());res.on('close',()=>{reader.destroy();encoder?.destroy();});if(encoder){encoder.on('error',()=>res.destroy());reader.pipe(encoder).pipe(res);}else reader.pipe(res);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=JSON.parse(await readFile(process.env.JOEY_ORIGINAL_CONFIG,'utf8'));
  const server=await createOriginalServer(config);server.listen(config.port,'127.0.0.1',()=>console.log('Original browser preview ready on loopback port '+config.port));
}
