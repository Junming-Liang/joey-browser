const element=id=>document.getElementById(id),base=new URL('./',import.meta.url);
const getSession=async()=>{const response=await fetch(new URL('api/session',base),{cache:'no-store'});if(!response.ok)throw Error('无法读取登录状态');return response.json();};
let host,profile,Host,lastFailure,startupTimer,launchStarted;const surface=element('game-surface');
const startupLabels={'creating-host':'准备运行环境','starting-audio':'启动声音','preloading-resources':'准备游戏资源','loading-saves':'读取浏览器存档','loading-program':'请求原版程序','downloading-program':'下载原版程序','compiling-program':'编译原版程序','instantiated':'运行原版程序'};
function failureReport(){const canvas=surface.querySelector('canvas'),rect=canvas?.getBoundingClientRect();return {version:element('version').textContent,browser:navigator.userAgent,viewport:[innerWidth,innerHeight],environment:{secureContext:isSecureContext,isolated:crossOriginIsolated,sharedMemory:typeof SharedArrayBuffer==='function'},failure:lastFailure,diagnostics:host?.probe.diagnostics,stages:host?.probe.stages,renders:host?.probe.renders,renderTiming:host?.probe.renderTiming,drawTiming:host?.probe.drawTiming,elapsedMs:launchStarted?Math.round(performance.now()-launchStarted):null,canvas:canvas?{intrinsic:[canvas.width,canvas.height],display:[rect.x,rect.y,rect.width,rect.height]}:null,audio:host?.probe.audio,resourceStats:host?.probe.resourceStats,resourceCache:host?.probe.resourceCache,resourcePreload:host?.probe.resourcePreload,recentResourceReads:host?.probe.resourceReads.slice(-20),programProgress:host?.probe.programProgress,programDownload:host?.probe.programDownload,input:host?{queued:host.probe.inputQueued,consumed:host.probe.inputConsumed,last:host.probe.lastInput}:null,lastHostCall:host?.probe.calls.at(-1)};}
function updateStartupProgress(){
  if(lastFailure)return;
  const seconds=Math.floor((performance.now()-launchStarted)/1000),phase=host?.probe.stages.at(-1)?.stage||'creating-host';
  const stats=host?.probe.resourceStats;
  const waiting=stats?.pendingReads?.find(read=>Date.now()-read.startedAt>=200);
  const drawing=(host?.probe.renders||0)>0,reading=drawing?Boolean(waiting)&&Date.now()-(host?.probe.renderTiming?.lastRenderAt||0)>=200:stats?.activeReads>0;
  const progress=element('loading-progress'),program=host?.probe.programProgress,download=host?.probe.programDownload;
  element('loading').hidden=drawing&&!reading;
  progress.removeAttribute('value');
  let text;
  const preload=host?.probe.resourcePreload;
  if(phase==='preloading-resources'&&preload?.total>0){
    progress.max=preload.total;progress.value=preload.completed;
    text='正在准备'+(preload.mode==='complete'?'完整游戏':'常用')+'资源 '+Math.floor(100*preload.completed/preload.total)+'%（已准备 '+(preload.completed/1048576).toFixed(1)+' / '+(preload.total/1048576).toFixed(1)+' MiB，解压后保存在本机）';
    if(preload.restoredBytes)text+='，已恢复本机缓存 '+(preload.restoredBytes/1048576).toFixed(1)+' MiB';
    if(stats.networkRetries)text+='，网络中断后正在续传';
  }else if(phase==='downloading-program'&&download?.total>0){
    progress.max=download.total;progress.value=download.completed;
    text='正在下载程序 '+Math.floor(100*download.completed/download.total)+'%（'+(download.completed/1000000).toFixed(1)+' / '+(download.total/1000000).toFixed(1)+' MB）';
    if(download.restoredBytes)text+='，已恢复本机缓存 '+(download.restoredBytes/1000000).toFixed(1)+' MB';
    if(download.stats.networkRetries)text+='，网络中断后正在续传';
  }else if(phase==='downloading-program'&&program?.total>0){
    progress.max=program.total;progress.value=program.received;
    text='正在下载程序 '+Math.floor(100*program.received/program.total)+'%（'+(host.probe.programSource?.compressedBytes?'压缩传输约 '+(host.probe.programSource.compressedBytes/1000000).toFixed(1)+' MB，':'')+'已解压 '+(program.received/1048576).toFixed(1)+' / '+(program.total/1048576).toFixed(1)+' MiB）';
  }else if(phase==='instantiated'||reading){
    text='正在读取'+(drawing?'对局':'游戏')+'资源，已读取 '+(((stats?.downloadedBytes||0)+(stats?.diskCacheBytes||0))/1048576).toFixed(1)+' MB'+(stats?.diskCacheHits?'（含本机缓存）':'');
  }else text='正在'+(startupLabels[phase]||'准备游戏画面');
  element('loading-label').textContent=text;
  element('status').textContent=drawing&&!reading?'原版画面已开始绘制；完整对局和手机流畅度仍在验证。':text+'，已等待 '+(drawing?Math.max(0,Math.floor((Date.now()-(waiting?.startedAt||Date.now()))/1000)):seconds)+' 秒。';
  if(element('startup-details').open)element('startup-report').textContent=JSON.stringify(failureReport(),null,2);
}
function fitCanvas(){const canvas=surface.querySelector('canvas');if(!canvas)return;const scale=Math.min(surface.clientWidth/canvas.width,surface.clientHeight/canvas.height);canvas.style.width=Math.floor(canvas.width*scale)+'px';canvas.style.height=Math.floor(canvas.height*scale)+'px';}
new ResizeObserver(fitCanvas).observe(surface);new MutationObserver(fitCanvas).observe(surface,{childList:true});
function status(data){
  if(['failed','host-failed','worker-error'].includes(data.stage)){
    lastFailure=data;clearInterval(startupTimer);element('loading').hidden=true;element('startup-details').hidden=true;element('copy-error').hidden=false;element('copy-error').textContent='复制错误信息';
    const phase=startupLabels[data.startupPhase]||(host?.probe.renders?'运行游戏':'启动游戏');
    element('status').textContent=phase+'失败：'+String(data.error).slice(0,600)+'。可复制错误信息反馈。';
    element('failure-details').hidden=false;element('failure-report').textContent=JSON.stringify(failureReport(),null,2);
    for(const button of document.querySelectorAll('[data-key],#right-click,#sound'))button.disabled=true;
    const report=failureReport();
    fetch(new URL('api/failure',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browser:report.browser,stage:data.stage,startupPhase:data.startupPhase,error:String(data.error).slice(0,2000),errorName:data.errorName,renders:report.renders||0,...report.environment})}).catch(()=>{});
  }else if(data.stage==='first-frame'||startupLabels[data.stage])updateStartupProgress();
  else if(data.stage==='returned'){clearInterval(startupTimer);element('loading').hidden=true;element('status').textContent='游戏已退出，刷新页面可重新进入。';}
}
async function prepare(session){
  element('version').textContent='版本 '+session.version;
  if(!session.authenticated)return;
  element('login').hidden=true;element('game').hidden=false;
  if(session.preparation?.commonCompressedEstimateBytes&&session.program?.compressedBytes){
    const megabytes=Math.ceil((session.preparation.commonCompressedEstimateBytes+session.program.compressedBytes)/1000000);
    element('download-size').textContent='横屏后点击启动。首次启动预计下载约 '+megabytes+' MB 的程序和常用资源（压缩传输）；未缓存内容后续按需下载，下载中断后重新打开页面会从已保存的部分续传；再次启动复用本机缓存。游戏声音会在启动后开启。';
  }
  try{
    const [{createOriginalBrowserHost},{openPlayerFiles}]=await Promise.all([import('./browser-host.mjs'),import('./player-files.mjs')]);
    Host=createOriginalBrowserHost;profile=await openPlayerFiles();
    element('start').textContent='启动原版游戏';element('start').disabled=false;
  }catch(error){status({stage:'host-failed',startupPhase:'creating-host',error:String(error),stack:error.stack});console.error(error);return;}
  element('start').onclick=()=>{
    launchStarted=performance.now();element('copy-error').hidden=false;element('startup-details').hidden=false;
    startupTimer=setInterval(updateStartupProgress,1000);
    element('start').disabled=true;element('launch').hidden=true;
    element('status').textContent='正在加载原版游戏，首次启动请耐心等待。';
    try{
      host=Host({manifest:session.resources,program:session.program,preloadMode:element('complete-resources').checked?'complete':'common',baseURL:base,container:surface,onStatus:status,loadFiles:()=>profile.load(),saveFile:(path,bytes)=>profile.save(path,bytes)});
      window.joeyOriginal=host.probe;
      host.start().then(()=>{for(const button of document.querySelectorAll('[data-key],#right-click,#sound'))button.disabled=false;}).catch(error=>console.error(error));
    }catch(error){status({stage:'host-failed',startupPhase:'creating-host',error:String(error),stack:error.stack});console.error(error);}
  };
}
element('login-form').onsubmit=async event=>{
  event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;element('login-status').textContent='正在登录';
  try{
    const response=await fetch(new URL('api/login',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:element('password').value})});
    if(!response.ok)throw Error(response.status===429?'尝试次数较多，请稍后再试。':'密码不正确或登录失败。');
    element('password').value='';await prepare(await getSession());
  }catch(error){element('login-status').textContent=error.message;}finally{button.disabled=false;}
};
for(const button of document.querySelectorAll('[data-key]'))button.onclick=()=>host?.pressKey(button.dataset.key);
element('right-click').onclick=()=>host?.rightClick();
element('sound').onclick=async()=>{try{await host.resumeAudio();element('sound').textContent='声音已恢复';}catch(error){element('status').textContent='声音恢复失败：'+error.message;}};
element('copy-error').onclick=async()=>{
  const report=failureReport(),details=element(lastFailure?'failure-details':'startup-details');element(lastFailure?'failure-report':'startup-report').textContent=JSON.stringify(report,null,2);
  try{await navigator.clipboard.writeText(JSON.stringify(report,null,2));element('copy-error').textContent='已复制，可以粘贴反馈';}
  catch{details.hidden=false;details.open=true;element('copy-error').textContent='请展开运行信息，选择文字复制';}
};
element('startup-details').ontoggle=()=>{if(element('startup-details').open)element('startup-report').textContent=JSON.stringify(failureReport(),null,2);};
element('fullscreen').onclick=async()=>{
  try{if(document.fullscreenElement)await document.exitFullscreen();else await element('game').requestFullscreen();}catch{element('status').textContent='此浏览器不支持页面全屏，请横屏使用。';}
};
window.addEventListener('pagehide',()=>{clearInterval(startupTimer);host?.stop();profile?.close();});
getSession().then(prepare).catch(error=>{element('login-status').textContent=error.message;});
