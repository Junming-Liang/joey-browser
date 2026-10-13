#!/usr/bin/env python3
"""Validate classic presets against original enabled cards and extract theme decks."""
import base64,hashlib,json,struct,sys,collections
from pathlib import Path
from poc_data import archive_index,legacy_to_internal
root=Path(__file__).resolve().parents[3]
source=root/'.bridge/joey-web/reverse/input/data.dat'
assert hashlib.sha256(source.read_bytes()).hexdigest()=='a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f'
with source.open('rb') as file:
 header=file.read(12);entries=archive_index(header+file.read(int.from_bytes(header[8:12],'little')*268),source.stat().st_size)
 def read(name):
  entry=next(e for e in entries if e['name'].lower()==name.lower());file.seek(entry['offset']);return file.read(entry['size'])
 packs=read('bin#\\card_pack.bin');indices=[i for i,(pack,) in enumerate(struct.iter_unpack('<H',packs)) if pack]
 assert len(indices)==771 and max(indices)<2048
 inverse=read('bin#\\card_intid.bin')
 legacy_ids=read('bin#\\card_id.bin');names=read('bin#\\card_namejpn.bin')
 named={}
 for index in indices:
  name=names[index*64:(index+1)*64].split(b'\0')[0].decode('gbk')
  named.setdefault(name,[]).append(index)
 def groups(data):
  position=8;result=[]
  for limit in [80,15,15]:
   count=struct.unpack_from('<H',data,position)[0];assert count<=limit;position+=2
   ids=struct.unpack_from(f'<{count}H',data,position);position+=2*count
   assert all(legacy_to_internal(card,inverse) in indices for card in ids),'Deck uses unavailable cards'
   result.append(ids)
  assert len(result[0])>=40 and position==len(data)
  assert all(count<=3 for count in collections.Counter(card%2000 for group in result for card in group).values()),'More than three copies'
  return result
 themes={'ge1':'城之内均衡 A','ge2':'城之内均衡 B','umi':'水属性','val':'女武神','dec':'牌组破坏','fus':'融合','gam':'骰子与赌博','hik':'光属性','ins':'昆虫','mix':'混合战术','red':'真红眼','too':'卡通','uij':'威加盘','all':'全能','exo':'黑暗大法师','grv':'重力束缚','hnd':'手牌战术','yam':'暗属性'}
 decks=[]
 for entry in entries:
  if not entry['name'].lower().startswith('j\\file\\ful_') or not entry['name'].lower().endswith('.ydc'):continue
  file.seek(entry['offset']);data=file.read(entry['size']);counts=list(map(len,groups(data)))
  identifier=entry['name'].split('\\')[-1][:-4].lower();decks.append({'id':identifier,'label':themes[identifier[5:]]+' · '+identifier[4],'group':'原版主题卡组','main':counts[0],'extra':counts[1],'side':counts[2],'bytes':base64.b64encode(data).decode()})
 assert len(decks)==37
classic_source=root/'.bridge/joey-web/reverse/output/cards-patch/bundled-patch-files.json'
classic_labels={'DeckOut':'牌组破坏','Destiny_Board':'威加盘','Exodia_Deck':'黑暗大法师','Toon_Deck':'卡通'}
classic=[];excluded=[]
for item in json.loads(classic_source.read_text()):
 if not item['name'].lower().endswith('.ydc'):continue
 data=base64.b64decode(item['bytes']);stem=Path(item['name']).stem
 try:counts=list(map(len,groups(data)))
 except (AssertionError,struct.error):excluded.append(stem);continue
 assert stem in classic_labels,'Review the new compatible theme label before bundling'
 classic.append({'id':'classic_'+stem.lower(),'label':classic_labels[stem]+'（经典包）','group':'玩家经典卡组','sourceFile':stem+'.ydc','sourceSHA256':hashlib.sha256(data).hexdigest(),'main':counts[0],'extra':counts[1],'side':counts[2],'bytes':item['bytes']})
assert len(classic)==4 and len(excluded)==32
burn_source=Path(__file__).with_name('classic-burn-decks.json')
burn_recipes=json.loads(burn_source.read_text());burn=[]
for recipe in burn_recipes['decks']:
 cards=[]
 for name,quantity in recipe['cards']:
  matches=named.get(name,[])
  assert len(matches)==1,'Burn card name must resolve uniquely: '+name
  index=matches[0];legacy=struct.unpack_from('<H',legacy_ids,index*2)[0]
  assert legacy_to_internal(legacy,inverse)==index,'Burn card ID round-trip mismatch'
  assert type(quantity) is int and 1<=quantity<=3
  cards.extend([legacy]*quantity)
 assert len(cards)==40 and len(set(name for name,_ in recipe['cards']))==len(recipe['cards'])
 # Profile identity is replaced with the player's own header before import.
 data=bytes(8)+struct.pack('<H40H2H',40,*cards,0,0);counts=list(map(len,groups(data)))
 burn.append({'id':recipe['id'],'label':recipe['label']+'（经典攻略）','group':'玩家经典卡组','sourceURL':burn_recipes['sourceURL'],'sourceTitle':burn_recipes['sourceTitle'],'sourceSHA256':hashlib.sha256(burn_source.read_bytes()).hexdigest(),'main':counts[0],'extra':counts[1],'side':counts[2],'bytes':base64.b64encode(data).decode()})
assert len(burn)==4 and len({deck['id'] for deck in burn+classic+decks})==len(burn+classic+decks)
for number,deck in enumerate(burn+classic+decks,1):
 # The card-load dialog scans loose YDCs in the shared player directory.
 stem=f"{number:02d} "+deck['label'].replace('（经典攻略）','').replace('（经典包）','').replace(' · ',' ')
 assert len((stem+'.ydc').encode('gbk'))<256 and not any(char in stem for char in '/\\:')
 deck['filePath']='/Yu-Gi-Oh! Power of Chaos Common/'+stem+'.ydc'
fixture=root/'.bridge/joey-web/reverse/output/cards-patch/fresh/system.dat'
result={'archiveSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),'cardIndices':indices,'decks':burn+classic+decks,'classicBurnSource':burn_recipes['sourceURL'],'classicBurnCompatible':len(burn),'classicPackSource':'https://www.32r.com/soft/201511023432.html','classicPackArchiveSHA256':'898516e304f6fb629cd37160c7270320f542f275d17ffe3d52ba4c5266976d32','classicPackCompatible':len(classic),'classicPackExcluded':excluded,'freshSystem':base64.b64encode(fixture.read_bytes()).decode(),'freshSystemScope':'Synthetic fresh profile produced by the pinned original program in an isolated browser test; no personal save'}
output=root/'games/joey/original/collection-catalog.mjs';output.write_text('export const collectionCatalog='+json.dumps(result,separators=(',',':'))+';\n')
print(json.dumps({'cards':len(indices),'originalDecks':len(decks),'classicDecks':len(classic),'classicBurnDecks':len(burn),'totalDecks':len(burn)+len(classic)+len(decks),'outputBytes':output.stat().st_size}))
