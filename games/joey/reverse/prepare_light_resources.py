"""Create a separate light variant; original source archives are never edited.

Only card artwork's 24-bit BMP pixels and RIFF PCM data are changed. UI BMPs,
fonts, YGA/alpha, palette indices, archive directories and all padding stay exact.
"""
import hashlib
import json
import math
from pathlib import Path
import struct

from array import array
import sys
assert sys.byteorder == 'little'
PIXEL_LUT=bytes(v if v in (0,255) else (v&252)+2 for v in range(256))
assert all((v>>2)==(q>>2) and (v==0)==(q==0) and (v==255)==(q==255) and abs(v-q)<=2 for v,q in enumerate(PIXEL_LUT))
from poc_data import archive_index

ROOT=Path('.bridge/joey-web/reverse')
OUT=ROOT/'output/compression-20261013/light-resources'
PINS={'data.dat':'a76107c5e848ad20edf08ff868f065379ef33c365f03049572943dce8aa0192f',
      'Voice.dat':'b23a7158d19f99d0a1a7013a2fbc291ad019768a166ce93cd15d90bca04dcc72',
      'Region.dat':'e77b9a9ae9e30b0dbdb6f510a264ef9de781501d7b6b92ae89eb059c5ab743db'}
sha=lambda b:hashlib.sha256(b).hexdigest()

def main():
    OUT.mkdir(parents=True,exist_ok=True)
    archives=[];images=[];audio=[];image_error=audio_error=0
    for name,pin in PINS.items():
        source=(ROOT/'input'/name).read_bytes()
        assert sha(source)==pin
        derived=bytearray(source);mutable=[]
        entries=archive_index(source,len(source)) if name!='Region.dat' else []
        for entry in entries:
            start,size=entry['offset'],entry['size'];label=entry['name'].lower()
            if name=='data.dat' and label.startswith('card\\') and label.endswith('.bmp') and label!='card\\card_ura.bmp':
                assert source[start:start+2]==b'BM'
                offset=struct.unpack_from('<I',source,start+10)[0]
                width,height=struct.unpack_from('<ii',source,start+18)
                bits,compression=struct.unpack_from('<HI',source,start+28)
                assert compression==0 and width>0 and height!=0
                if bits!=24:continue
                row_bytes=width*3;stride=(row_bytes+3)//4*4;length=stride*abs(height)
                assert offset>=54 and offset+length<=size
                error=0
                for row in range(abs(height)):
                    first=start+offset+row*stride;last=first+row_bytes
                    original=source[first:last];quant=original.translate(PIXEL_LUT)
                    derived[first:last]=quant;mutable.append((first,last))
                    if quant!=original:error=2
                image_error=max(image_error,error)
                images.append(dict(name=entry['name'],pixelBytes=row_bytes*abs(height),maxChannelErrorBound=error))
            if name=='Voice.dat' and label.endswith('.wav'):
                assert source[start:start+4]==b'RIFF' and source[start+8:start+12]==b'WAVE'
                limit=start+8+struct.unpack_from('<I',source,start+4)[0];assert limit<=start+size
                position=start+12;fmt=None;chunks=[]
                while position+8<=limit:
                    kind=source[position:position+4];length=struct.unpack_from('<I',source,position+4)[0];position+=8
                    assert position+length<=limit
                    if kind==b'fmt ':fmt=struct.unpack_from('<HHIIHH',source,position)
                    if kind==b'data':chunks.append((position,length))
                    position+=length+(length&1)
                assert fmt and fmt[0]==1 and fmt[1] in (1,2) and fmt[5]==16 and fmt[4]==fmt[1]*2 and chunks
                signal=error_energy=0;count=0;peak_error=0
                for position,length in chunks:
                    assert length%fmt[4]==0
                    samples=array('h');samples.frombytes(source[position:position+length]);quant=array('h')
                    for sample in samples:
                        value=max(-32768,min(32767,((sample+4)//8)*8));quant.append(value)
                        error=sample-value;signal+=sample*sample;error_energy+=error*error;peak_error=max(peak_error,abs(error))
                    assert peak_error<=4;audio_error=max(audio_error,peak_error);count+=len(samples)
                    derived[position:position+length]=quant.tobytes();mutable.append((position,position+length))
                audio.append(dict(name=entry['name'],channels=fmt[1],sampleRate=fmt[2],samples=count,maxSampleError=peak_error,
                                  snrDb=10*math.log10(signal/error_energy) if signal and error_energy else None))
        # Hash all immutable intervals, independently of the transformation.
        before=hashlib.sha256();after=hashlib.sha256();position=0
        for start,end in sorted(mutable):
            assert position<=start<end<=len(source)
            before.update(source[position:start]);after.update(derived[position:start]);position=end
        before.update(source[position:]);after.update(derived[position:]);assert before.digest()==after.digest()
        assert len(derived)==len(source)
        if entries:assert archive_index(derived,len(derived))==entries
        destination=OUT/name
        with destination.open('wb') as target:target.write(derived)
        archives.append(dict(path='/'+name,length=len(source),sha256=pin,derivedSHA256=sha(derived),immutableSHA256=before.hexdigest(),immutableIntervalsExact=True))
        print(json.dumps(dict(archive=name,derivedSHA256=archives[-1]['derivedSHA256'],immutableIntervalsExact=True)),flush=True)
    report=dict(profile={'name':'light-rgb6-pcm13','cardArtworkChannelBits':6,'pcmEffectiveBits':13,'maxCardChannelError':image_error,'maxPCMSampleError':audio_error,
                         'scope':'24bit card artwork only; UI, backgrounds, masks, alpha and fonts unchanged; RIFF PCM payload only, sample rates/channels/lengths unchanged'},
                archives=archives,images=images,audio=audio)
    (OUT/'provenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(dict(images=len(images),audio=len(audio),imageError=image_error,audioError=audio_error)),flush=True)

if __name__=='__main__':main()
