const element=id=>document.getElementById(id),base=new URL('./',import.meta.url);
const getSession=async()=>{const response=await fetch(new URL('api/session',base),{cache:'no-store'});if(!response.ok)throw Error('无法读取游戏信息');return response.json();};
let host,profile,Host,collection,catalog,lastFailure,startupTimer,launchStarted;const surface=element('game-surface');
function rememberUnlock(){try{localStorage.setItem('joey-original-unlock-cards',element('unlock-cards').checked?'on':'off');}catch{}}
element('unlock-cards').onchange=rememberUnlock;
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
    if(preload.phase==='verifying'){
      progress.max=preload.totalBlocks;progress.value=preload.verifiedBlocks;
      text='正在校验完整资源 '+preload.verifiedBlocks+' / '+preload.totalBlocks+'，压缩包已保存在本机';
    }else if(preload.byteDomain==='compressed'){
      text='正在准备完整压缩资源 '+Math.floor(100*preload.completed/preload.total)+'%（'+(preload.completed/1000000).toFixed(1)+' / '+(preload.total/1000000).toFixed(1)+' MB，保持压缩保存）';
      if(preload.restoredBytes)text+='，已恢复本机缓存 '+(preload.restoredBytes/1000000).toFixed(1)+' MB';
    }else if(preload.source==='installed-original')text='已复用完整旧资源缓存，无需重新下载';
    else{
      text='正在准备常用资源 '+Math.floor(100*preload.completed/preload.total)+'%（已准备 '+(preload.completed/1048576).toFixed(1)+' / '+(preload.total/1048576).toFixed(1)+' MiB，解压后保存在本机）';
      if(preload.restoredBytes)text+='，已恢复本机缓存 '+(preload.restoredBytes/1048576).toFixed(1)+' MiB';
    }
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
    for(const button of document.querySelectorAll('[data-key],#right-click,#keyboard,#sound'))button.disabled=true;
    const report=failureReport();
    fetch(new URL('api/failure',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({browser:report.browser,stage:data.stage,startupPhase:data.startupPhase,error:String(data.error).slice(0,2000),errorName:data.errorName,renders:report.renders||0,...report.environment})}).catch(()=>{});
  }else if(data.stage==='first-frame'||startupLabels[data.stage])updateStartupProgress();
  else if(data.stage==='returned'){clearInterval(startupTimer);element('loading').hidden=true;element('status').textContent='游戏已退出，刷新页面可重新进入。';for(const button of document.querySelectorAll('[data-key],#right-click,#keyboard,#sound'))button.disabled=true;}
}
async function prepare(session){
  element('version').textContent='版本 '+session.version;
  const quality=element('complete-quality');
  const selectedPack=()=>quality.value==='original'&&session.originalPackedResources?session.originalPackedResources:session.packedResources;
  const updateQuality=()=>{
    const descriptor=selectedPack();
    if(descriptor)element('complete-label').textContent='启动前安装完整'+(session.originalPackedResources&&quality.value==='light'?'轻量':'压缩')+'资源（约 '+Math.ceil(descriptor.pack.length/1000000)+' MB；中断后可续传，已有完整缓存直接复用）';
    const visible=Boolean(session.originalPackedResources)&&element('complete-resources').checked;
    element('resource-quality-option').hidden=!visible;element('complete-quality-note').hidden=!visible;quality.disabled=!visible;
    element('complete-quality-note').textContent=quality.value==='light'?'轻量包只对卡图与声音做轻度压缩，界面、文字和游戏内容保持原版。已有完整原版缓存会直接复用。':'原画原声使用无损资源包。';
  };
  element('complete-resources').onchange=updateQuality;quality.onchange=updateQuality;updateQuality();
  if(session.preparation?.commonCompressedEstimateBytes&&session.program?.compressedBytes){
    const megabytes=Math.ceil((session.preparation.commonCompressedEstimateBytes+session.program.compressedBytes)/1000000);
    element('download-size').textContent='横屏后点击启动。首次启动预计下载约 '+megabytes+' MB 的程序和常用资源（压缩传输）；未缓存内容后续按需下载，下载中断后重新打开页面会从已保存的部分续传；再次启动复用本机缓存。游戏声音会在启动后开启。';
  }
  try{
    const [{createOriginalBrowserHost},{openPlayerFiles},patch,{collectionCatalog}]=await Promise.all([import('./browser-host.mjs'),import('./player-files.mjs'),import('./collection-patch.mjs'),import('./collection-catalog.mjs')]);
    Host=createOriginalBrowserHost;profile=await openPlayerFiles();
    collection=patch;catalog=collectionCatalog;
    try{element('unlock-cards').checked=localStorage.getItem('joey-original-unlock-cards')!=='off';}catch{}
    const groups=new Map();
    for(const deck of catalog.decks){if(!groups.has(deck.group)){const group=document.createElement('optgroup');group.label=deck.group;groups.set(deck.group,group);element('preset-deck').append(group);}const option=document.createElement('option');option.value=deck.id;option.textContent=deck.label+' · '+deck.main+' 张';groups.get(deck.group).append(option);}
    try{const info=collection.collectionInfo(await profile.load());element('collection-status').textContent=(info?'当前收藏 '+info.kinds+' 种卡片。':'')+'启动时安装全部 '+catalog.decks.length+' 套卡组，在游戏内“卡组编辑 → 读取”切换；首次自动使用补血削血卡组。';}
    catch(error){element('collection-status').textContent=error.message+'；可恢复此前的备份。';}
    element('start').textContent='启动原版游戏';element('start').disabled=false;
    element('restore-collection').disabled=false;element('restore-deck').disabled=false;
  }catch(error){status({stage:'host-failed',startupPhase:'creating-host',error:String(error),stack:error.stack});console.error(error);return;}
  element('start').onclick=()=>{
    launchStarted=performance.now();element('copy-error').hidden=false;element('startup-details').hidden=false;
    startupTimer=setInterval(updateStartupProgress,1000);
    element('start').disabled=true;element('launch').hidden=true;
    element('status').textContent='正在加载原版游戏，首次启动请耐心等待。';
    try{
      const unlock=element('unlock-cards').checked,deckId=element('preset-deck').value;
      const descriptor=selectedPack(),previous=(session.legacyPackedResources||[]).filter(file=>file.pack.sha256!==descriptor?.pack.sha256);
      host=Host({manifest:session.resources,program:session.program,packedResources:descriptor,legacyPackedResources:previous,preloadMode:element('complete-resources').checked?'complete':'common',baseURL:base,container:surface,onStatus:status,claimProfile:()=>profile.acquireWriter(),loadFiles:async signal=>{
        const check=()=>{if(signal.aborted)throw new DOMException('游戏启动已取消','AbortError');};check();
        if(deckId&&!unlock)throw Error('使用全卡预设卡组时，请同时勾选全卡解锁');
        if(unlock)await profile.patch('before-unlock',files=>collection.applyCollectionPatch(files,catalog,{unlock:true}));
        check();
        await profile.patch('before-deck',files=>collection.applyCollectionPatch(files,catalog,{unlock,deckId,installDecks:true}));
        check();
        return collection.withProfileKey(await profile.load());
      },saveFile:(path,bytes)=>profile.save(path,bytes)});
      window.joeyOriginal=host.probe;
      host.start().then(()=>{if(!host.probe.stopped)for(const button of document.querySelectorAll('[data-key],#right-click,#keyboard,#sound'))button.disabled=false;}).catch(error=>console.error(error));
    }catch(error){status({stage:'host-failed',startupPhase:'creating-host',error:String(error),stack:error.stack});console.error(error);}
  };
}
for(const [button,id]of [['restore-collection','before-unlock'],['restore-deck','before-deck']])element(button).onclick=async()=>{
  element('restore-collection').disabled=true;element('restore-deck').disabled=true;element('start').disabled=true;
  let release;
  try{release=await profile.acquireWriter();await profile.restore(id);if(id==='before-unlock'){element('unlock-cards').checked=false;rememberUnlock();}element('preset-deck').value='';element('collection-status').textContent=id==='before-unlock'?'已恢复解锁前的存档，全卡解锁已取消勾选。':'已恢复上次切换前的卡组，收藏和游戏进度保留。';}
  catch(error){element('collection-status').textContent=error.message;}
  finally{await release?.();element('restore-collection').disabled=false;element('restore-deck').disabled=false;element('start').disabled=false;}
};
for(const button of document.querySelectorAll('[data-key]'))button.onclick=()=>host?.pressKey(button.dataset.key);
element('right-click').onclick=()=>host?.rightClick();
const keyboard=element('keyboard-input');
const resetKeyboard=()=>{keyboard.value=' ';keyboard.setSelectionRange(1,1);};
element('keyboard').onclick=()=>{resetKeyboard();keyboard.focus({preventScroll:true});};
keyboard.onbeforeinput=event=>{if(event.inputType==='deleteContentBackward'){event.preventDefault();host?.pressKey('Backspace');resetKeyboard();}};
keyboard.oninput=event=>{if(event.isComposing)return;const text=event.data??keyboard.value.slice(1);resetKeyboard();if(text)host?.typeText(text).catch(error=>{element('status').textContent=error.message;});};
keyboard.onkeydown=event=>{if(['Enter','Escape','Backspace','Delete'].includes(event.code)){event.preventDefault();host?.pressKey(event.code);if(event.code==='Enter'||event.code==='Escape')keyboard.blur();}};
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
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
getSession().then(prepare).catch(error=>status({stage:'host-failed',startupPhase:'creating-host',error:String(error)}));
