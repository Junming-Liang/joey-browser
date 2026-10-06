// This preview has its own browser profile; server-side player files are never read.
const reserved=new Set(['/data.dat','/voice.dat','/region.dat','/joey_pc_cn.exe']);
export function isPlayerFile(path){
  return typeof path==='string'&&path.length<=200&&path.startsWith('/')&&
    !path.includes('\\')&&!/[\x00-\x1f\x7f]/.test(path)&&
    !reserved.has(path.toLowerCase())&&
    path.slice(1).split('/').every(part=>part&&part!=='.'&&part!=='..');
}
export async function openPlayerFiles(){
  const database=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('joey-original-preview-player',1);
    request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'path'});
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const transaction=(mode,operation)=>new Promise((resolve,reject)=>{
    const tx=database.transaction('files',mode),store=tx.objectStore('files');let result;
    try {const request=operation(store);request.onsuccess=()=>{result=request.result;};}
    catch(error){tx.abort();reject(error);return;}
    tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('Player storage transaction aborted'));
  });
  return {
    async load(){
      const files=await transaction('readonly',store=>store.getAll());
      if(files.length>64||files.reduce((sum,file)=>sum+(file.bytes?.byteLength||0),0)>2097152||files.some(file=>!isPlayerFile(file.path)||!(file.bytes instanceof Uint8Array)||file.bytes.length>262144))throw Error('Invalid browser player profile');
      return files;
    },
    async save(path,bytes){
      if(!isPlayerFile(path)||!(bytes instanceof Uint8Array)||bytes.length>262144)throw Error('Invalid original player file');
      const prior=await this.load();
      if(prior.filter(file=>file.path!==path).length>=64||prior.filter(file=>file.path!==path).reduce((sum,file)=>sum+file.bytes.length,bytes.length)>2097152)throw Error('Browser player profile capacity exceeded');
      await transaction('readwrite',store=>store.put({path,bytes}));
    },
    close(){database.close();}
  };
}
