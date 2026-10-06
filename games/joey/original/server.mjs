import {createServer} from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {resolve} from 'node:path';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createGzip} from 'node:zlib';

const prefix='/joey/original/';
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.wasm':'application/wasm','.json':'application/json'};
const assets=['index.html','app.mjs','style.css','browser-host.mjs','original-worker.mjs','player-files.mjs','resource-cache.mjs','resource-layout.mjs','range-reader.mjs','pcm-audio-host.mjs','pcm-worklet.js','joey_original.js','joey_original_bg.wasm'];
const publicAssets=new Set(['index.html','app.mjs','style.css']);
const acceptsGzip=req=>/(?:^|,|\s)gzip(?:\s*(?:,|;|$))/.test(req.headers['accept-encoding']||'')&&!/gzip\s*;\s*q=0(?:\D|$)/.test(req.headers['accept-encoding']||'');
export async function createOriginalServer(config){
  const root=resolve(config.filesRoot),resourcesRoot=resolve(config.resourcesRoot);
  const revision=JSON.parse(await readFile(resolve(root,'revision.json'),'utf8'));
  const files=new Map();
  for(const name of assets){const path=resolve(root,name),info=await stat(path);if(!info.isFile())throw Error('Invalid asset '+name);files.set(name,{path,size:info.size,etag:revision.files[name]});}
  const compressed=resolve(root,'joey_original_bg.wasm.gz'),compressedInfo=await stat(compressed);
  if(!/^[a-f0-9]{64}$/.test(revision.programGzipSHA256||''))throw Error('Missing pinned compressed program');
  const resources=new Map(revision.resources.map(file=>[file.name,{...file,path:resolve(resourcesRoot,file.name)}]));
  if(resources.size!==3||!['data.dat','Voice.dat','Region.dat'].every(name=>resources.has(name)))throw Error('Invalid archive allowlist');
  for(const file of resources.values())if((await stat(file.path)).size!==file.length)throw Error('Archive size mismatch '+file.name);
  if(!/^[a-f0-9]{64}$/.test(config.passwordHash)||typeof config.passwordSalt!=='string'||!/^https?:\/\//.test(config.origin))throw Error('Invalid original gateway config');
  const expected=Buffer.from(config.passwordHash,'hex'),sessions=new Map(),attempts=new Map(),failureReports=new Map();
  const authenticated=req=>{
    const token=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('joey_original_session='))?.slice(22);
    const expiry=sessions.get(token);if(!expiry)return false;if(expiry<Date.now()){sessions.delete(token);return false;}return true;
  };
  const common={
    'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp','Cross-Origin-Resource-Policy':'same-origin',
    'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin',
    'Content-Security-Policy':"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    'Cache-Control':'private, no-cache'
  };
  const server=createServer(async(req,res)=>{
    for(const [name,value]of Object.entries(common))res.setHeader(name,value);
    const json=(status,value,headers={})=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));};
    try{
      const raw=(req.url||'').split('?')[0];
      if(!raw.startsWith(prefix)||raw.includes('%')||raw.includes('\\')||raw.includes('..'))return json(404,{error:'Not found'});
      const name=raw.slice(prefix.length)||'index.html';
      if(name==='api/login'&&req.method==='POST'){
        if(req.headers.origin!==config.origin||!(req.headers['content-type']||'').startsWith('application/json'))return json(403,{error:'Invalid origin'});
        const now=Date.now(),ip=String(req.headers['x-real-ip']||req.socket.remoteAddress).slice(0,100);
        for(const [key,value]of attempts)if(value.until<=now)attempts.delete(key);
        const bucket=attempts.get(ip)||{count:0,until:now+900000};
        if(bucket.count>=5)return json(429,{error:'Retry later'},{'Retry-After':String(Math.ceil((bucket.until-now)/1000))});
        bucket.count++;if(!attempts.has(ip)&&attempts.size>=512)attempts.delete(attempts.keys().next().value);attempts.set(ip,bucket);
        let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>2048)return json(413,{error:'Request too large'});}
        let password;try{password=JSON.parse(body).password;}catch{return json(400,{error:'Invalid body'});}
        if(typeof password!=='string'||password.length>128)return json(400,{error:'Invalid password'});
        if(!timingSafeEqual(scryptSync(password,config.passwordSalt,32),expected))return json(401,{error:'Invalid password'});
        attempts.delete(ip);for(const [token,expiry]of sessions)if(expiry<now)sessions.delete(token);
        if(sessions.size>=32)sessions.delete(sessions.keys().next().value);
        const token=randomBytes(32).toString('base64url');sessions.set(token,now+86400000);
        return json(200,{ok:true},{'Set-Cookie':`joey_original_session=${token}; Path=${prefix}; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`});
      }
      if(name==='api/failure'&&req.method==='POST'){
        if(req.headers.origin!==config.origin||!(req.headers['content-type']||'').startsWith('application/json'))return json(403,{error:'Invalid origin'});
        if(!authenticated(req))return json(401,{error:'Authentication required'});
        const token=(req.headers.cookie||'').split(';').map(part=>part.trim()).find(part=>part.startsWith('joey_original_session='))?.slice(22);
        for(const key of failureReports.keys())if(!sessions.has(key))failureReports.delete(key);
        if((failureReports.get(token)||0)>=4)return json(429,{error:'Diagnostic limit'});
        let body='';for await(const chunk of req){body+=chunk.toString('utf8');if(Buffer.byteLength(body)>8192)return json(413,{error:'Request too large'});}
        let data;try{data=JSON.parse(body);}catch{return json(400,{error:'Invalid body'});}
        if(!data||typeof data!=='object'||Array.isArray(data)||typeof data.error!=='string')return json(400,{error:'Invalid diagnostic'});
        const record={version:revision.version};
        for(const key of ['browser','stage','startupPhase','error','errorName'])if(typeof data[key]==='string')record[key]=data[key].slice(0,key==='error'?2000:300);
        if(Number.isSafeInteger(data.renders)&&data.renders>=0)record.renders=data.renders;
        for(const key of ['secureContext','isolated','sharedMemory'])if(typeof data[key]==='boolean')record[key]=data[key];
        failureReports.set(token,(failureReports.get(token)||0)+1);
        console.error('Original preview failure: '+JSON.stringify(record));
        return json(200,{recorded:true});
      }
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'Method not allowed'},{Allow:'GET, HEAD'});
      const auth=authenticated(req);
      if(name==='api/session')return json(200,{authenticated:auth,version:revision.version,...(auth?{program:{length:files.get('joey_original_bg.wasm').size,compressedBytes:compressedInfo.size,compressedSHA256:revision.programGzipSHA256,compressedURL:prefix+'program-bytes'},preparation:{commonBytes:revision.preloadBytes,commonCompressedEstimateBytes:revision.preloadTransferEstimateBytes,completeBytes:revision.completePreloadBytes},resources:[...resources.values()].map(file=>({path:'/'+file.name,url:prefix+'resources/'+file.name,compressedURL:prefix+'resource-bytes/'+file.name,length:file.length,sha256:file.sha256}))}:{})});
      if(!publicAssets.has(name)&&!auth)return json(401,{error:'Authentication required'});
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
  return server;
}
function stream(path,res,options={},compressed=false){const reader=createReadStream(path,options),encoder=compressed?createGzip({level:1}):null;reader.on('error',()=>res.destroy());res.on('close',()=>{reader.destroy();encoder?.destroy();});if(encoder){encoder.on('error',()=>res.destroy());reader.pipe(encoder).pipe(res);}else reader.pipe(res);}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const config=JSON.parse(await readFile(process.env.JOEY_ORIGINAL_CONFIG,'utf8'));
  const server=await createOriginalServer(config);server.listen(config.port,'127.0.0.1',()=>console.log('Original browser preview ready on loopback port '+config.port));
}
