// Real-browser save migration, backup rollback and original codec invariants.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {collectionCatalog as catalog} from './collection-catalog.mjs';
import {applyCollectionPatch,decodeCollection,encodeOriginal,collectionInfo,systemPath,deckLibraryPath} from './collection-patch.mjs';
const root=resolve('.bridge/joey-web/reverse/output/original-preview'),out=resolve('.bridge/joey-web/reverse/output/cards-patch');
const fresh=Uint8Array.from(Buffer.from(catalog.freshSystem,'base64'));
assert.deepEqual(encodeOriginal(decodeCollection(fresh)),fresh);
const before=[{path:systemPath,bytes:fresh},{path:'/deck.ydc',bytes:new Uint8Array([1,2,3])},{path:'/progress.bin',bytes:new Uint8Array([7,8])}];
const patched=applyCollectionPatch(before,catalog,{unlock:true,deckId:'classic_exodia_deck'});
assert.deepEqual(collectionInfo(patched),{kinds:771,copies:2313});
assert.deepEqual(before[0].bytes,fresh,'Input save must not be mutated');
assert.deepEqual(patched.find(file=>file.path==='/progress.bin').bytes,new Uint8Array([7,8]));
const decodedBefore=decodeCollection(fresh),decodedAfter=decodeCollection(patched.find(file=>file.path===systemPath).bytes);
for(let i=0;i<decodedBefore.length;i++){
 const cardCount=i>=20&&i<4116&&(i-20)%2===0;
 if(!cardCount&&![18,19,4492,4493].includes(i))assert.equal(decodedAfter[i],decodedBefore[i],'Preserve progress, card flags and profile identity at '+i);
}
const byPath=files=>files.slice().sort((a,b)=>a.path.localeCompare(b.path));
// Installing the library with unlock disabled must leave both the collection
// and active native deck untouched, including the first library installation.
const lockedLibrary=applyCollectionPatch(before,catalog,{unlock:false,installDecks:true});
assert.deepEqual(lockedLibrary.find(file=>file.path===systemPath).bytes,fresh);
assert.deepEqual(lockedLibrary.find(file=>file.path==='/deck.ydc').bytes,before[1].bytes);
assert.equal(lockedLibrary.filter(file=>catalog.decks.some(deck=>deck.filePath===file.path)).length,45);

const library=applyCollectionPatch(before,catalog,{unlock:true,installDecks:true});
assert.equal(library.filter(f=>catalog.decks.some(d=>d.filePath===f.path)).length,45);
for(const preset of catalog.decks){
 const exported=library.find(f=>f.path===preset.filePath).bytes;
 assert(preset.filePath.startsWith('/Yu-Gi-Oh! Power of Chaos Common/')&&preset.filePath.endsWith('.ydc'));
 assert.deepEqual(exported.subarray(0,8),decodedAfter.subarray(0,8));
 assert.deepEqual(exported.subarray(8),new Uint8Array(Buffer.from(preset.bytes,'base64')).subarray(8));
}
assert(library.some(f=>f.path===deckLibraryPath));
assert.deepEqual(library.find(f=>f.path==='/deck.ydc').bytes.subarray(8),new Uint8Array(Buffer.from(catalog.decks[0].bytes,'base64')).subarray(8));
const changed=applyCollectionPatch(library,catalog,{deckId:'classic_exodia_deck'});
assert.deepEqual(byPath(applyCollectionPatch(changed,catalog,{installDecks:true})),byPath(changed),'Launching again must retain later active deck edits');
assert.deepEqual(byPath(applyCollectionPatch(patched,catalog,{unlock:true})),byPath(patched),'Unlock must be idempotent');
const damaged=fresh.slice();damaged[15]^=1;
assert.throws(()=>applyCollectionPatch([{path:systemPath,bytes:damaged}],catalog,{unlock:true}),/校验/);
const {chromium,webkit}=createRequire(import.meta.url)('playwright');
const {createOriginalServer}=await import(pathToFileURL(root+'/server.mjs'));
const config={filesRoot:root,resourcesRoot:resolve('.bridge/joey-web/reverse/input'),packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/compression-20261013/light-pack'),origin:'http://127.0.0.1'};
const server=await createOriginalServer(config);await new Promise(done=>server.listen(0,'127.0.0.1',done));config.origin+=':'+server.address().port;const prefix=config.origin+'/joey/original/';
const reports=[];
try{
 for(const [name,engine]of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch(name==='chromium'?{...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}:{headless:true});
  const context=await browser.newContext();
  try{
   const page=await context.newPage();
   // Avoid the application opening version2 before we seed the old version1 DB.
   await page.route('**/app.mjs',route=>route.fulfill({body:'',contentType:'text/javascript'}));await page.goto(prefix);
   const report=await page.evaluate(async seed=>{
    const check=(v,message)=>{if(!v)throw Error(message);};
    const old=await new Promise((resolve,reject)=>{const request=indexedDB.open('joey-original-preview-player',1);request.onupgradeneeded=()=>request.result.createObjectStore('files',{keyPath:'path'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const prior=seed.map(file=>({...file,bytes:Uint8Array.from(file.bytes)}));
    await new Promise((resolve,reject)=>{const tx=old.transaction('files','readwrite');for(const file of prior)tx.objectStore('files').put(file);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});old.close();
    const {openPlayerFiles}=await import('./player-files.mjs'),patch=await import('./collection-patch.mjs'),{collectionCatalog}=await import('./collection-catalog.mjs');const profile=await openPlayerFiles();
    const serial=files=>JSON.stringify(files.map(f=>({path:f.path,bytes:Array.from(f.bytes)})).sort((a,b)=>a.path.localeCompare(b.path)));
    check(serial(await profile.load())===serial(prior),'Version1 migration lost data');
    await profile.patch('before-unlock',files=>patch.applyCollectionPatch(files,collectionCatalog,{unlock:true}));
    check(patch.collectionInfo(await profile.load()).kinds===771,'Full card collection');
    const unlocked=serial(await profile.load());let refused=false;
    try{await profile.patch('before-deck',files=>{files[0].bytes[0]^=255;throw Error('deliberate invalid import');});}catch{refused=true;}
    check(refused&&serial(await profile.load())===unlocked,'Failed patch must roll back atomically');
    let absent=false;try{await profile.restore('before-deck');}catch{absent=true;}check(absent,'Failed import must not commit a backup');
    await profile.patch('before-deck',files=>patch.applyCollectionPatch(files,collectionCatalog,{deckId:'classic_exodia_deck'}));
    await profile.save('/progress.bin',new Uint8Array([9,10]));await profile.restore('before-deck');
    const restored=await profile.load();check(serial(restored.filter(f=>f.path==='/deck.ydc'))===serial(prior.filter(f=>f.path==='/deck.ydc')),'Deck restore');check(restored.find(f=>f.path==='/progress.bin').bytes[0]===9,'Deck restore must preserve newer progress');
    await profile.patch('before-unlock',files=>patch.applyCollectionPatch(files,collectionCatalog,{unlock:true}));await profile.restore('before-unlock');check(serial(await profile.load())===serial(prior),'Repeated unlock must preserve the immutable first backup');
    await profile.patch('before-deck',files=>patch.applyCollectionPatch(files,collectionCatalog,{unlock:true,installDecks:true}));
    const library=await profile.load();check(library.filter(f=>collectionCatalog.decks.some(d=>d.filePath===f.path)).length===45,'All native deck archives must commit together');
    await profile.patch('before-deck',files=>patch.applyCollectionPatch(files,collectionCatalog,{deckId:'classic_exodia_deck'}));
    const active=serial(await profile.load());await profile.patch('before-deck',files=>patch.applyCollectionPatch(files,collectionCatalog,{installDecks:true}));check(serial(await profile.load())===active,'Subsequent launch resets active deck');
    profile.close();return {migration:true,rollback:true,deckRestorePreservesProgress:true,firstUnlockBackupImmutable:true,allNativeDeckFiles:45,laterDeckPreserved:true,catalogCards:collectionCatalog.cardIndices.length,classicDecks:collectionCatalog.classicPackCompatible};
   },before.map(f=>({path:f.path,bytes:Array.from(f.bytes)})));
   await page.unroute('**/app.mjs');await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);
   await page.locator('#collection-options').evaluate(element=>element.open=true);assert.equal(await page.locator('#preset-deck optgroup').first().getAttribute('label'),'玩家经典卡组');
   assert.equal(await page.locator('#preset-deck optgroup').first().locator('option').count(),catalog.classicPackCompatible+catalog.classicBurnCompatible);
   await page.locator('#unlock-cards').uncheck();await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#unlock-cards').isChecked(),false,'Unlock choice must persist');
   await page.evaluate(async()=>{const {openPlayerFiles}=await import('./player-files.mjs'),{systemPath}=await import('./collection-patch.mjs');const profile=await openPlayerFiles();try{const save=(await profile.load()).find(file=>file.path===systemPath);save.bytes[15]^=1;await profile.save(systemPath,save.bytes);}finally{profile.close();}});
   await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#restore-collection').isEnabled(),true,'Corrupted collection must not hide backup recovery');
   await page.locator('#collection-options').evaluate(element=>element.open=true);await page.locator('#restore-collection').click();await page.waitForFunction(()=>document.getElementById('collection-status').textContent.includes('已恢复解锁前'));
   await page.reload();await page.waitForFunction(()=>!document.getElementById('start').disabled);assert.equal(await page.locator('#unlock-cards').isChecked(),false,'Restoring original save must not silently unlock on the next visit');
   reports.push({browser:name,...report,unlockChoicePersists:true,corruptSaveRecoveryUI:true});console.log(JSON.stringify(reports.at(-1)));
  }finally{await context.close();await browser.close();}
 }
 await mkdir(out,{recursive:true});await writeFile(out+'/collection-checks.json',JSON.stringify(reports,null,2)+'\n');
}finally{server.closeAllConnections();await new Promise(done=>server.close(done));}
