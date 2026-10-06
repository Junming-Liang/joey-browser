#!/usr/bin/env python3
"""Losslessly pack verified native GDI pixels, retaining metrics/cache aliases."""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def checksum(data):
    return hashlib.sha256(data).hexdigest()


def parse(data, legacy=False):
    assert data[:5] == (b'JYGF2' if legacy else b'JYGR3')
    count, = struct.unpack_from('<H', data, 5)
    profiles = 8 if legacy else struct.unpack_from('<H', data, 7)[0]
    cursor = 7 if legacy else 9
    result = []
    for profile in range(profiles):
        if legacy:
            request = (12 if profile % 4 < 2 else 14, 700 if profile < 4 else 400, 3 if profile & 1 else 2)
        else:
            request = struct.unpack_from('<HHB', data, cursor)
            cursor += 5
        metrics = data[cursor:cursor + 60]
        cursor += 60
        glyphs = []
        for _ in range(count):
            header = data[cursor:cursor + 10]
            size = header[8] * header[9]
            levels = data[cursor + 10:cursor + 10 + size]
            assert len(header) == 10 and len(levels) == size
            glyphs.append((header, levels))
            cursor += 10 + size
        result.append((request, metrics, glyphs))
    assert cursor == len(data)
    return count, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native', type=Path)
    parser.add_argument('packed', type=Path)
    parser.add_argument('--prior-eight', type=Path, required=True)
    args = parser.parse_args()
    raw = args.native.read_bytes()
    count, profiles = parse(raw)
    _, prior = parse(args.prior_eight.read_bytes(), legacy=True)
    assert profiles[:8] == prior, 'Prior native glyphs/metrics changed'
    output = bytearray(b'JYGF3' + struct.pack('<HH', count, len(profiles)))
    report = []
    for request, metrics, glyphs in profiles:
        monochrome = request[2] == 3
        bits = 1 if monochrome else 4
        allowed = {0, 16} if monochrome else {0, *range(2, 17)}
        output += struct.pack('<HHBB', *request, bits) + metrics
        levels_seen = set()
        aliases = {}
        for header, levels in glyphs:
            assert set(levels) <= allowed, 'Unexpected native coverage; refuse lossy packing'
            index = struct.unpack_from('<H', header, 2)[0]
            if index in aliases:
                assert aliases[index] == header[4:6], 'Inconsistent native glyph-cache alias'
            aliases[index] = header[4:6]
            levels_seen.update(levels)
            packed = bytearray((len(levels) * bits + 7) // 8)
            for i, level in enumerate(levels):
                code = int(level != 0) if monochrome else level - 1 if level else 0
                packed[i * bits // 8] |= code << (i * bits % 8)
            # Every native pixel is reconstructed independently before writing.
            restored = bytearray()
            for i in range(len(levels)):
                code = (packed[i * bits // 8] >> (i * bits % 8)) & ((1 << bits) - 1)
                restored.append(code * 16 if monochrome else code + 1 if code else 0)
            assert restored == levels
            output += header + packed
        report.append(dict(height=request[0], weight=request[1], quality=request[2], bitsPerPixel=bits,
                           glyphs=len(glyphs), nativeLevels=sorted(levels_seen)))
    args.packed.write_bytes(output)
    evidence = dict(nativeSHA256=checksum(raw), nativeBytes=len(raw), packedSHA256=checksum(output),
                    packedBytes=len(output), priorEightProfilesExactlyMatched=True,
                    allNativePixelsRoundTripExactly=True, profiles=report)
    args.packed.with_suffix('.packing.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))


if __name__ == '__main__':
    main()
