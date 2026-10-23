// Compose new cards in the original 200x290 bitmap frame; preserve source art unchanged.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url)),source=path.join(root,'games/joey/custom'),output=path.join(source,'cards');
const sha=b=>createHash('sha256').update(b).digest('hex');
const specBytes=await readFile(path.join(source,'cards.json')),spec=JSON.parse(specBytes),cards=spec.cards;
assert.equal(cards.length,5);
const archive=await readFile(path.join(root,'.bridge/joey-web/reverse/input/data.dat'));
assert.equal(archive.subarray(0,8).toString(),'KCEJYUGI');
const entries=new Map();
for(let i=0;i<archive.readUInt32LE(8);i++){
 const start=12+i*268,record=archive.subarray(start,start+268);assert.equal(record.length,268);
 const name=Buffer.from(record.subarray(0,256));
 for(let j=0;j<name.length;j++)name[j]=(record[j]>>4)|((record[j]&15)<<4);
 const file=name.subarray(0,name.indexOf(0)).toString('latin1').toLowerCase();
 const at=record.readUInt32LE(256),size=record.readUInt32LE(260);assert.ok(at+size<=archive.length);entries.set(file,archive.subarray(at,at+size));
}
const original=name=>{const b=entries.get('card\\'+name.toLowerCase());assert.ok(b,`Missing original ${name}`);return b;};
function decode(b){
 assert.equal(b.toString('ascii',0,2),'BM');assert.equal(b.readInt32LE(18),200);assert.equal(b.readInt32LE(22),290);assert.equal(b.readUInt16LE(28),24);assert.equal(b.readUInt32LE(30),0);
 const offset=b.readUInt32LE(10),rgba=new Uint8Array(200*290*4);
 for(let y=0;y<290;y++)for(let x=0;x<200;x++){const i=(y*200+x)*4,j=offset+(289-y)*600+x*3;rgba[i]=b[j+2];rgba[i+1]=b[j+1];rgba[i+2]=b[j];rgba[i+3]=255;}
 return rgba;
}
function copyTexture(base,texture,[x,y,w,h],[sx,sy,sw,sh]){
 for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
  const phase=yy%(sh*2),sourceY=phase<sh?phase:sh*2-1-phase;
  const from=((sy+sourceY)*200+sx+xx%sw)*4,to=((y+yy)*200+x+xx)*4;
  base.set(texture.subarray(from,from+4),to);
 }
}
const effectTexture=decode(original('sdk004.bmp')),effectTitle=decode(original('mrl079.bmp'));
const spellTexture=decode(original('sdy023.bmp')),spellTitle=decode(original('lob050.bmp'));
const props=entries.get('bin#\\card_prop.bin'),list=entries.get('card\\list_card.txt').toString('latin1');
const files=new Map([...list.matchAll(/\/\/\s*(\d{4}):\[\d+\]\s*\r?\n([^\r\n]+)/g)].map(m=>[+m[1],m[2].toLowerCase()]));
const originals={spell:[],effect:[]};
for(let i=0;i<props.length/4;i++){const p=props.readUInt32LE(i*4),race=(p>>>20)&31,kind=race===22?'spell':race<21&&((p>>>18)&3)===1?'effect':null,file=files.get(i);if(kind&&file&&file!=='token_sl.bmp')originals[kind].push(decode(original(file)));}
function recoverBackground(base,kind,[x,y,w,h],title=false){
 for(let yy=y;yy<y+h;yy++)for(let xx=x;xx<x+w;xx++){
  const at=(yy*200+xx)*4,counts=new Map();let selected=null,best=0;
  for(const sample of originals[kind]){const r=sample[at],g=sample[at+1],b=sample[at+2];
   const background=title?(kind==='spell'?g>70&&g-r>18&&g-b>1:r>135&&r-g>18&&g-b>8):r>120&&g>105&&b>75;
   if(!background)continue;const key=(r<<16)|(g<<8)|b,count=(counts.get(key)||0)+1;counts.set(key,count);if(count>best){selected=sample;best=count;}
  }
  if(selected)base.set(selected.subarray(at,at+4),at);
 }
}
const measurements={art:[28,63,144,144],title:[19,18,140,18],type:[19,223,161,7],body:[19,230,161,33],stats:[99,265,82,8],setCode:[145,211,35,7],copyright:[105,278,76,5],attribute:[160,16,22,22],stars:[120,42,56,14]};
const assignments=[['sdy023.bmp',null],['mrl079.bmp','mrl020.bmp'],['lon070.bmp','mrl094.bmp'],['sdk004.bmp','mrl079.bmp'],['mrl079.bmp','mrl094.bmp']];
const inputs=[],sources={};
for(const file of new Set([...assignments.flat().filter(Boolean),'mrl020.bmp','mrl094.bmp','sdy023.bmp','mrl079.bmp','lon070.bmp','sdk004.bmp']))sources[file]={data:'data:image/bmp;base64,'+original(file).toString('base64'),sha256:sha(original(file))};
for(let i=0;i<cards.length;i++){
 const card=cards[i],kind=card.kind,base=decode(original(assignments[i][0]));
 copyTexture(base,kind==='spell'?spellTitle:effectTitle,measurements.title,kind==='spell'?[65,18,90,18]:[102,18,55,18]);
 recoverBackground(base,kind,measurements.title,true);
 copyTexture(base,kind==='spell'?spellTexture:effectTexture,kind==='spell'?[19,223,162,49]:[19,230,162,33],kind==='spell'?[19,235,162,35]:[19,240,162,22]);
 if(kind==='effect')copyTexture(base,effectTexture,[19,265,162,8],[19,251,162,8]);
 // Remove unrelated printed set codes and old copyright attribution using frame texture.
 copyTexture(base,kind==='spell'?spellTexture:effectTexture,[145,212,36,6],[40,215,36,1]);
 copyTexture(base,kind==='spell'?spellTexture:effectTexture,measurements.copyright,[25,278,65,5]);
 const art=await readFile(path.join(source,'art',card.art+'.png'));
 inputs.push({card,base:Array.from(base),original:assignments[i][0],typeSource:assignments[i][1],art:'data:image/png;base64,'+art.toString('base64'),artSHA256:sha(art)});
}
const fonts=[];for(const family of ['Times New Roman','Arial']){const file=execFileSync('fc-match',[family,'-f','%{file}'],{encoding:'utf8'}).trim();fonts.push({family,sha256:sha(await readFile(file))});}

const require=createRequire(import.meta.url);let playwright;try{playwright=require('playwright');}catch{playwright=createRequire(path.join(root,'.bridge/joey-github-v1/package.json'))('playwright');}
const browser=await playwright.chromium.launch({headless:true,...(process.env.JOEY_CHROMIUM_PATH?{executablePath:process.env.JOEY_CHROMIUM_PATH}:{})});
try{
 const page=await browser.newPage({viewport:{width:1100,height:640},deviceScaleFactor:1});
 await page.setContent('<meta charset="utf-8"><style>body{margin:0;background:#26272a}canvas{display:block}</style>');
 const rendered=await page.evaluate(async({inputs,sources,measurements})=>{
  const make=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  const png=c=>c.toDataURL('image/png').split(',')[1];
  const pixels=c=>Array.from(c.getContext('2d').getImageData(0,0,c.width,c.height).data);
  const images={};for(const [name,source] of Object.entries(sources)){const image=new Image();image.src=source.data;await image.decode();images[name]=image;}
  const results=[];
  for(const input of inputs){
   const {card}=input,spell=card.kind==='spell',c=make(200,290),ctx=c.getContext('2d');ctx.putImageData(new ImageData(new Uint8ClampedArray(input.base),200,290),0,0);
   const art=new Image();art.src=input.art;await art.decode();if(art.width!==art.height)throw Error('Source art must remain square');
   ctx.imageSmoothingQuality='high';ctx.drawImage(art,...measurements.art);
   ctx.fillStyle=spell?'#fffef0':'#100d09';ctx.textBaseline='alphabetic';
   // Original names use a narrow serif small-cap face. Matrix is absent locally;
   // installed Times New Roman small caps retain the original cap-height hierarchy.
   let cursor=20;const title=[];
   for(const char of card.nameEn){const full=char===char.toUpperCase()&&char!==' ';const font=`${full?16.5:12.3}px "Times New Roman"`;ctx.font=font;const glyph=char.toUpperCase(),width=ctx.measureText(glyph).width;title.push({glyph,font,x:cursor});cursor+=width;}
   if(cursor>159)throw Error('Title overlaps original attribute');
   for(const part of title){ctx.font=part.font;ctx.fillText(part.glyph,part.x,32.5);}
   if(!spell){const r=measurements.type;ctx.drawImage(images[input.typeSource],...r,...r);}
   const bodySize=6.05,lineHeight=6.65,bodyY=spell?228.8:235.5,bodyWidth=159.5;
   ctx.font=`${bodySize}px Arial`;ctx.fillStyle='#15120e';const words=card.effectEn.split(/\s+/),lines=[];let current='';
   for(const word of words){const next=current?current+' '+word:word;if(ctx.measureText(next).width>bodyWidth&&current){lines.push(current);current=word;}else current=next;}if(current)lines.push(current);
   if(lines.join(' ')!==card.effectEn)throw Error('Card description changed');
   const bottom=bodyY+(lines.length-1)*lineHeight;if(bottom>262)throw Error('Card description overflows');
   for(let i=0;i<lines.length;i++)ctx.fillText(lines[i],20,bodyY+i*lineHeight);
   if(!spell){ctx.textAlign='right';ctx.font='bold 8.3px "Times New Roman"';ctx.fillText(`ATK/${card.attack}  DEF/${card.defense}`,180,272.2);ctx.textAlign='left';}
   const native=pixels(c),mini=make(50,72);mini.getContext('2d').drawImage(c,0,0,50,72);
   const high=make(1000,1450),h=high.getContext('2d');h.imageSmoothingEnabled=false;h.drawImage(c,0,0,1000,1450);
   // Exact original borders, cloud frame, stars and attribute survive composition.
   for(const [name,r] of Object.entries({attribute:measurements.attribute,stars:measurements.stars})){for(let y=r[1];y<r[1]+r[3];y++)for(let x=r[0];x<r[0]+r[2];x++){const at=(y*200+x)*4;for(let k=0;k<4;k++)if(native[at+k]!==input.base[at+k])throw Error('Changed original '+name);}}
   results.push({preview:png(high),native:png(c),mini:png(mini),rgba:native,miniRgba:pixels(mini),layout:{lines,bodySize,lineHeight,bottom,titleRight:cursor},canvas:c});
  }
  function sheet(items,columns,scale=2){const rows=Math.ceil(items.length/columns),c=make((columns*220+20)*scale,(rows*310+20)*scale),x=c.getContext('2d');x.fillStyle='#26272a';x.fillRect(0,0,c.width,c.height);x.imageSmoothingEnabled=false;items.forEach((im,i)=>x.drawImage(im,(20+i%columns*220)*scale,(20+Math.floor(i/columns)*310)*scale,200*scale,290*scale));return c;}
  const overview=sheet(results.map(r=>r.canvas),5);
  // Seeded, fixed interleave: comparisons contain original and new cards at equal native size.
  const mix=[images['mrl079.bmp'],results[0].canvas,images['lon070.bmp'],results[3].canvas,results[1].canvas,results[2].canvas,images['mrl020.bmp'],results[4].canvas,images['sdy023.bmp'],images['mrl094.bmp']];
  const comparison=sheet(mix,5);comparison.style.width='1120px';comparison.style.height='640px';document.body.append(comparison);
  return {results:results.map(({canvas,...rest})=>rest),overview:png(overview),comparison:png(comparison)};
 },{inputs,sources,measurements});
 function bmp(width,height,rgba){const stride=(width*3+3)&~3,offset=56,b=Buffer.alloc(offset+stride*height);b.write('BM');b.writeUInt32LE(b.length,2);b.writeUInt32LE(offset,10);b.writeUInt32LE(40,14);b.writeInt32LE(width,18);b.writeInt32LE(height,22);b.writeUInt16LE(1,26);b.writeUInt16LE(24,28);b.writeUInt32LE(stride*height,34);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const from=(y*width+x)*4,to=offset+(height-1-y)*stride+x*3;assert.equal(rgba[from+3],255);b[to]=rgba[from+2];b[to+1]=rgba[from+1];b[to+2]=rgba[from];}return b;}
 await mkdir(output,{recursive:true});
 const manifest={schema:2,rulesVersion:spec.rulesVersion,specSHA256:sha(specBytes),archiveSHA256:sha(archive),renderer:'Original bitmap templates with browser Canvas text',browser:browser.version(),fonts,measurements,preview:'5x pixel-faithful preview of final game bitmap',cards:[]};
 for(let i=0;i<cards.length;i++){
  const card=cards[i],render=rendered.results[i],assets={};
  for(const [suffix,bytes] of [['.png',Buffer.from(render.preview,'base64')],['.native.png',Buffer.from(render.native,'base64')],['.mini.png',Buffer.from(render.mini,'base64')],['.bmp',bmp(200,290,render.rgba)],['.mini.bmp',bmp(50,72,render.miniRgba)]]){
   if(suffix.endsWith('.bmp')){const decoded=await page.evaluate(async data=>{const im=new Image();im.src=data;await im.decode();const c=document.createElement('canvas');c.width=im.width;c.height=im.height;const x=c.getContext('2d');x.drawImage(im,0,0);return Array.from(x.getImageData(0,0,c.width,c.height).data);},'data:image/bmp;base64,'+bytes.toString('base64'));assert.deepEqual(decoded,suffix==='.bmp'?render.rgba:render.miniRgba);}
   const file=card.art+suffix;await writeFile(path.join(output,file),bytes);assets[suffix]={file,bytes:bytes.length,sha256:sha(bytes)};
  }
  manifest.cards.push({internal:card.internal,legacy:card.legacy,name:card.name,nameEn:card.nameEn,artSHA256:inputs[i].artSHA256,template:inputs[i].original,templateSHA256:sources[inputs[i].original].sha256,typeSource:inputs[i].typeSource,layout:render.layout,assets});
 }
 await writeFile(path.join(output,'contact-sheet.png'),Buffer.from(rendered.overview,'base64'));await writeFile(path.join(output,'mixed-original-comparison.png'),Buffer.from(rendered.comparison,'base64'));await page.screenshot({path:path.join(output,'browser-review.png'),fullPage:true});await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 console.log(JSON.stringify({cards:5,output,textComplete:true,originalIconsPreserved:true,bmpRoundtripExact:true}));
}finally{await browser.close();}
