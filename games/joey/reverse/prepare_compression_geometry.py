"""Task-local bitmap metadata for same-grid reversible predictor experiments."""
import hashlib
import json
import pathlib
import struct

from poc_data import archive_index

root = pathlib.Path('.bridge/joey-web/reverse')
baseline = json.loads((root / 'output/resource-compression/lossless-codecs.json').read_text())
file = next(f for f in baseline['archives'] if f['name'] == 'data.dat')
raw = (root / 'input/data.dat').read_bytes()
assert len(raw) == file['originalBytes'] and hashlib.sha256(raw).hexdigest() == file['originalSHA256']
images = []
for entry in archive_index(raw, len(raw)):
    start, size = entry['offset'], entry['size']
    if not entry['name'].lower().endswith('.bmp') or size < 54:
        continue
    assert raw[start:start+2] == b'BM'
    pixel_offset = struct.unpack_from('<I', raw, start+10)[0]
    width, height = struct.unpack_from('<ii', raw, start+18)
    bits, compression = struct.unpack_from('<HI', raw, start+28)
    assert compression == 0 and bits in (1, 8, 24) and width > 0 and height != 0
    row_bytes = (width*bits+7)//8
    stride = (row_bytes+3)//4*4
    length = stride*abs(height)
    assert pixel_offset+length <= size
    images.append([start+pixel_offset, length, stride, row_bytes, 3 if bits == 24 else 1])
result = dict(originalSHA256=file['originalSHA256'], originalBytes=len(raw), images=images)
(root / 'output/resource-compression/bitmap-geometry.json').write_text(json.dumps(result, separators=(',', ':'))+'\n')
print(json.dumps(dict(images=len(images), pixelBytes=sum(i[1] for i in images))))
