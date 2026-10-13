// This preview has its own browser profile; server-side player files are never read.
const reserved=new Set(['/data.dat','/voice.dat','/region.dat','/joey_pc_cn.exe']);
const sameBytes=(a,b)=>a===b||Boolean(a&&b&&a.length===b.length&&a.every((value,index)=>value===b[index]));
export function isPlayerFile(path){
  return typeof path==='string'&&path.length<=200&&path.startsWith('/')&&
    !path.includes('\\')&&!/[\x00-\x1f\x7f]/.test(path)&&
    !reserved.has(path.toLowerCase())&&
    path.slice(1).split('/').every(part=>part&&part!=='.'&&part!=='..');
}
export async function openPlayerFiles(){
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('joey-original-preview-player',2);
    request.onupgradeneeded=()=>{for(const name of ['files','backups'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:name==='files'?'path':'id'});};
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    request.onblocked=()=>reject(Error('请关闭其他游戏标签后重新打开，以启用存档备份'));
  });
  database.onversionchange=()=>database.close();
  const validate=files=>{
    if(files.length>64||files.reduce((sum,file)=>sum+(file.bytes?.byteLength||0),0)>2097152||files.some(file=>!isPlayerFile(file.path)||!(file.bytes instanceof Uint8Array)||file.bytes.length>262144))throw Error('Invalid browser player profile');
    return files;
  };
  const transaction=(mode,operation)=>new Promise((resolve,reject)=>{
    const tx=database.transaction('files',mode),store=tx.objectStore('files');let result;
    try {const request=operation(store);request.onsuccess=()=>{result=request.result;};}
    catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Player storage transaction aborted'));
  });
  return {
    async acquireWriter(){
      if(!navigator.locks)throw Error('此浏览器无法安全锁定游戏存档，请使用支持此功能的 Safari 或 Chrome');
      return new Promise((resolve,reject)=>{
        const ownership=navigator.locks.request('joey-original-preview-player-writer',{mode:'exclusive',ifAvailable:true},lock=>{
          if(!lock){reject(Error('另一游戏标签正在使用此存档，请先关闭该标签'));return;}
          return new Promise(release=>resolve(async()=>{release();await ownership;}));
        });
        ownership.catch(reject);
      });
    },
    async load(){
      const files=await transaction('readonly',store=>store.getAll());
      return validate(files);
    },
    async save(path,bytes){
      if(!isPlayerFile(path)||!(bytes instanceof Uint8Array)||bytes.length>262144)throw Error('Invalid original player file');
      await new Promise((resolve,reject)=>{
        const tx=database.transaction('files','readwrite'),store=tx.objectStore('files');let failure;
        const request=store.getAll();request.onsuccess=()=>{try{
          const prior=validate(request.result),remaining=prior.filter(file=>file.path!==path);
          if(remaining.length>=64||remaining.reduce((sum,file)=>sum+file.bytes.length,bytes.length)>2097152)throw Error('Browser player profile capacity exceeded');
          if(!sameBytes(prior.find(file=>file.path===path)?.bytes,bytes))store.put({path,bytes});
        }catch(error){failure=error;tx.abort();}};
        tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(failure||tx.error||Error('Player save aborted'));
      });
    },
    // Keep a full, immutable first-unlock backup and the most recent deck backup.
    // Read, transform, backup and write commit together, including failure rollback.
    async patch(id,transform){
      if(!['before-unlock','before-deck'].includes(id)||typeof transform!=='function')throw Error('Invalid player patch');
      await new Promise((resolve,reject)=>{
        const tx=database.transaction(['files','backups'],'readwrite'),files=tx.objectStore('files'),backups=tx.objectStore('backups');let failure;
        const request=files.getAll();request.onsuccess=()=>{try{
          const prior=validate(request.result),next=validate(transform(prior.map(file=>({...file,bytes:file.bytes.slice()}))));
          const nextByPath=new Map(next.map(file=>[file.path,file]));
          if(nextByPath.size!==next.length)throw Error('Duplicate player file');
          const deckChanged=!sameBytes(prior.find(file=>file.path==='/deck.ydc')?.bytes,nextByPath.get('/deck.ydc')?.bytes);
          const backup=backups.get(id);backup.onsuccess=()=>{if(!backup.result||(id==='before-deck'&&deckChanged))backups.put({id,createdAt:Date.now(),files:prior});};
          if(prior.length!==next.length||prior.some(file=>!sameBytes(file.bytes,nextByPath.get(file.path)?.bytes))){files.clear();for(const file of next)files.put(file);}
        }catch(error){failure=error;tx.abort();}};
        tx.oncomplete=resolve;tx.onabort=()=>reject(failure||tx.error||Error('Player patch aborted'));tx.onerror=()=>reject(tx.error);
      });
    },
    async restore(id){
      if(!['before-unlock','before-deck'].includes(id))throw Error('Invalid backup');
      await new Promise((resolve,reject)=>{
        const tx=database.transaction(['files','backups'],'readwrite'),files=tx.objectStore('files');let failure;
        const request=tx.objectStore('backups').get(id);request.onsuccess=()=>{try{
          if(!request.result)throw Error('还没有此项备份');const saved=validate(request.result.files);
          if(id==='before-deck'){
            const deck=saved.find(file=>file.path==='/deck.ydc'),current=files.getAll();
            current.onsuccess=()=>{try{
              validate([...current.result.filter(file=>file.path!=='/deck.ydc'),...(deck?[deck]:[])]);
              if(deck)files.put(deck);else files.delete('/deck.ydc');
            }catch(error){failure=error;tx.abort();}};
          }
          else{files.clear();for(const file of saved)files.put(file);}
        }catch(error){failure=error;tx.abort();}};
        tx.oncomplete=resolve;tx.onabort=()=>reject(failure||tx.error||Error('Backup restore aborted'));tx.onerror=()=>reject(tx.error);
      });
    },
    close(){database.close();}
  };
}
