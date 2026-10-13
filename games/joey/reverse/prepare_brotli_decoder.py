"""Vendor the verified integer decoder and bound its own WASM linear memory."""
import hashlib,json,tarfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[3]
VENDOR=ROOT/'.bridge/joey-web/reverse/output/compression-20261013/vendor'
SOURCE=Path(__file__).resolve().parent
PACKAGE_SHA='5006ea904407e2f44ad6616100de196c39af591b772f764ba66fdd720b5d2ab5'

def leb(value):
    result=bytearray()
    while value>=128:result.append((value&127)|128);value>>=7
    result.append(value);return bytes(result)

def uint(data,position):
    value=0
    for shift in range(0,35,7):
        byte=data[position];position+=1;value|=(byte&127)<<shift
        if not byte&128:return value,position
    raise ValueError('Invalid WASM LEB128')

def bound_memory(data):
    assert data[:8]==b'\0asm\x01\0\0\0'
    result=bytearray(data[:8]);position=8;changed=False
    while position<len(data):
        section=data[position];size,start=uint(data,position+1);end=start+size
        assert end<=len(data);payload=data[start:end]
        if section==5:
            assert not changed
            count,index=uint(payload,0);flags,index=uint(payload,index);minimum,index=uint(payload,index)
            assert count==1 and flags in(0,1) and minimum<=512
            if flags:maximum,index=uint(payload,index);assert maximum>=512
            assert index==len(payload)
            payload=leb(1)+leb(1)+leb(minimum)+leb(512);changed=True
        result.append(section);result.extend(leb(len(payload)));result.extend(payload);position=end
    assert changed
    return bytes(result)

def main():
    archive=VENDOR/'brotli-dec-wasm-2.3.2.tgz';raw=archive.read_bytes()
    assert hashlib.sha256(raw).hexdigest()==PACKAGE_SHA
    with tarfile.open(archive,'r:gz')as package:
        js=package.extractfile('package/pkg/brotli_dec_wasm.js').read()
        original=package.extractfile('package/pkg/brotli_dec_wasm_bg.wasm').read()
        licenses=[package.extractfile('package/'+name).read()for name in ['LICENSE-MIT.txt','LICENSE-Apache.txt']]
    wasm=bound_memory(original)
    (SOURCE/'brotli-decoder.mjs').write_bytes(js)
    (SOURCE/'brotli-decoder.wasm').write_bytes(wasm)
    (SOURCE/'brotli-decoder-NOTICE.txt').write_bytes(b'brotli-dec-wasm 2.3.2, https://github.com/ustclug-dev/brotli-dec-wasm\nThe original WASM memory section was modified to cap linear memory at 32 MiB.\n\n'+b'\n\n'.join(licenses))
    report={'package':'brotli-dec-wasm','version':'2.3.2','packageSHA256':PACKAGE_SHA,'upstreamWasmSHA256':hashlib.sha256(original).hexdigest(),'files':{name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest()for name in ['brotli-decoder.mjs','brotli-decoder.wasm','brotli-decoder-NOTICE.txt']},'linearMemoryLimitBytes':33554432,'wasmBytes':len(wasm)}
    (SOURCE/'brotli-decoder-provenance.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))

if __name__=='__main__':main()
