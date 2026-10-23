#!/usr/bin/env python3
"""Add five cards through a small virtual DAT overlay; retain existing cached archives."""
import argparse, gzip, hashlib, json, struct
from pathlib import Path
from poc_data import archive_index

ROOT = Path(__file__).resolve().parents[3]
SOURCE_SHA = 'a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f'

def digest(data): return hashlib.sha256(data).hexdigest()

def prepare(source, spec_path, cards_root, output):
    raw = source.read_bytes()
    if digest(raw) != SOURCE_SHA: raise ValueError('Unexpected original data.dat')
    spec = json.loads(spec_path.read_text())
    cards = spec['cards']
    if [c['internal'] for c in cards] != list(range(1115,1120)) or [c['legacy'] for c in cards] != list(range(1950,1955)):
        raise ValueError('Custom card identity mismatch')
    entries = archive_index(raw,len(raw))
    by_name = {e['name']:e for e in entries}
    def read(name):
        e=by_name[name];return raw[e['offset']:e['offset']+e['size']]
    changes={}
    def table(name): return read('bin#\\'+name+'.bin')
    def put(name,data): changes['bin#\\'+name+'.bin']=bytes(data)
    for name,fmt,values in [('card_id','H',[c['legacy'] for c in cards]),('card_pack','H',[4]*5),
                           ('card_pass','4s',[bytes.fromhex(c['password']) for c in cards])]:
        old=table(name)
        if len(old)!=1115*struct.calcsize('<'+fmt): raise ValueError('Unexpected table dimensions')
        put(name,old+b''.join(struct.pack('<'+fmt,v) for v in values))
    races={'aqua':14,'plant':13,'beast':11};attributes={'earth':5,'wind':6}
    props=[]
    for c in cards:
        prop=0x1600000 if c['kind']=='spell' else (attributes[c['attribute']]<<29)|(c['level']<<25)|(races[c['race']]<<20)|(1<<18)|(c['attack']//10<<9)|(c['defense']//10)
        props.append(prop)
    put('card_prop',table('card_prop')+struct.pack('<5I',*props))
    inverse=bytearray(table('card_intid'))
    old_ids=set(struct.unpack('<1115H',table('card_id')))
    old_passwords={table('card_pass')[i:i+4] for i in range(0,4460,4)}
    for c in cards:
        if c['legacy'] in old_ids or struct.unpack_from('<H',inverse,c['legacy']*2)[0] or bytes.fromhex(c['password']) in old_passwords:
            raise ValueError('Custom identity collides with an original card')
        struct.pack_into('<H',inverse,c['legacy']*2,c['internal'])
    put('card_intid',inverse)
    for lang in ('eng','fra','ger','ita','jpn','spa'):
        names=bytearray(table('card_name'+lang));desc=bytearray(table('card_desc'+lang))
        indices=bytearray(table('card_indx'+lang));sort=bytearray(table('card_sort'+lang))
        encoding='gbk' if lang=='jpn' else 'latin1'
        for c in cards:
            name=c['name'] if lang=='jpn' else c['nameEn']
            effect=c['effect'] if lang=='jpn' else c['effectEn']
            encoded=name.encode(encoding)
            if len(encoded)>=64: raise ValueError('Custom card name too long')
            names.extend(encoded+bytes(64-len(encoded)))
            struct.pack_into('<I',indices,c['internal']*4,len(desc));desc.extend(effect.encode(encoding)+b'\0')
            struct.pack_into('<H',sort,c['internal']*2,c['internal'])
        for name,data in [('card_name',names),('card_desc',desc),('card_indx',indices),('card_sort',sort)]: put(name+lang,data)
    for folder in ('card','mini'):
        listing=read(folder+'\\list_card.txt')
        for c in cards:
            filename='custom_'+c['art'].replace('-','_')+'.bmp'
            listing+=('//\t'+c['nameEn']+'\r\n//\t%04d:[%d]\r\n%s\r\n\r\n'%(c['internal'],c['legacy'],filename)).encode('ascii')
            image=(cards_root/(c['art']+('.mini.bmp' if folder=='mini' else '.bmp'))).read_bytes()
            width,height=struct.unpack_from('<ii',image,18)
            if image[:2]!=b'BM' or (width,height)!=( (50,72) if folder=='mini' else (200,290)) or struct.unpack_from('<H',image,28)[0]!=24:
                raise ValueError('Invalid custom BMP: '+filename)
            changes[folder+'\\'+filename]=image
        changes[folder+'\\list_card.txt']=listing
    old_header=12+268*len(entries)
    names=sorted(set(by_name)|set(changes));header_length=12+268*len(names)
    shift=header_length-old_header;next_offset=len(raw)+shift
    replacement_rows={};appended=bytearray()
    for name,data in changes.items():
        replacement_rows[name]={'offset':next_offset,'size':len(data),'extra':len(data)}
        next_offset+=len(data);appended.extend(data)
    header=bytearray(b'KCEJYUGI'+struct.pack('<I',len(names)))
    for name in names:
        encoded=name.encode('shift_jis')
        if len(encoded)>=256: raise ValueError('DAT filename too long')
        encoded=encoded+bytes(256-len(encoded))
        row=replacement_rows.get(name)
        if row is None: row={**by_name[name],'offset':by_name[name]['offset']+shift}
        header.extend(bytes((b>>4)|((b&15)<<4) for b in encoded));header.extend(struct.pack('<III',row['offset'],row['size'],row['extra']))
    blob=bytes(header+appended)
    metadata={'format':'joey-custom-dat-v1','rulesVersion':spec['rulesVersion'],'path':'/data.dat',
              'sourceLength':len(raw),'sourceSHA256':SOURCE_SHA,'length':next_offset,
              'blob':{'url':'custom-resources.bin','length':len(blob),'sha256':digest(blob)},
              'spans':[[0,header_length,'overlay',0],[header_length,len(raw)-old_header,'original',old_header],
                       [len(raw)+shift,len(appended),'overlay',header_length]],
              'cards':[{k:c[k] for k in ('internal','legacy','name','nameEn','effect','effectEn')} for c in cards]}
    output.mkdir(parents=True,exist_ok=True)
    (output/'custom-resources.bin').write_bytes(blob)
    compressed=gzip.compress(blob,compresslevel=9,mtime=0)
    (output/'custom-resources.bin.gz').write_bytes(compressed)
    metadata['compressed']={'url':'custom-resource-bytes','path':'/__joey_custom_resources_v1','length':len(compressed),'sha256':digest(compressed)}
    (output/'custom-resources.json').write_text(json.dumps(metadata,ensure_ascii=False,separators=(',',':'))+'\n')
    # Verify the logical directory and all replacement bytes, without copying 334 MB.
    parsed=archive_index(header,next_offset)
    assert len(parsed)==len(entries)+10
    for row in parsed:
        if row['name'] in changes:
            p=row['offset']-(len(raw)+shift)+header_length
            assert blob[p:p+row['size']]==changes[row['name']]
        else:
            old=by_name[row['name']];assert row['offset']-shift==old['offset'] and row['size']==old['size'] and row['extra']==old['extra']
    report={'cards':len(cards),'replacedEntries':len(changes)-10,'newEntries':10,'overlayBytes':len(blob),
            'overlayGzipBytes':(output/'custom-resources.bin.gz').stat().st_size,'sourceSHA256':SOURCE_SHA,
            'cardSpecSHA256':digest(spec_path.read_bytes()),'sourceTablePrefixesUnchanged':True}
    (output/'custom-resources-provenance.json').write_text(json.dumps(report,indent=2)+'\n')
    return report

if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,default=ROOT/'.bridge/joey-web/reverse/input/data.dat')
    parser.add_argument('--spec',type=Path,default=ROOT/'games/joey/custom/cards.json')
    parser.add_argument('--cards',type=Path,default=ROOT/'games/joey/custom/cards')
    parser.add_argument('--output',type=Path,default=ROOT/'.bridge/joey-web/reverse/output/custom-resources')
    args=parser.parse_args();print(json.dumps(prepare(args.source,args.spec,args.cards,args.output)))
