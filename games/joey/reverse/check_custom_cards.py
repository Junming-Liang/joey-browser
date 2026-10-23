#!/usr/bin/env python3
"""Build a small differential test crate from actual translated blocks (no game build)."""
import argparse
from pathlib import Path
import re
import struct
import specialize_custom_cards as custom


def prepare(repo, executable, resources, output):
    custom.install(repo, check=True)
    src = output / 'src'
    src.mkdir(parents=True, exist_ok=True)
    blocks = {m[1]: m[0] for p in (repo / 'out/joey_cn/src/generated').glob('part_*.rs')
              for m in custom.FUNCTION.finditer(p.read_text())}
    ranges = [(0x4022e0, 0x402340), (0x5b8210, 0x5b88a0), (0x5b0f40, 0x5b1310), (0x56bfd0, 0x56c0a4),
              (0x584d00, 0x584de0), (0x59dbe0, 0x59dc50), (0x445640, 0x445940),
              (0x55c0e0, 0x55c250), (0x5be820, 0x5be880), (0x47dce0, 0x47ddc0),
              (0x5b5e00, 0x5b62f0), (0x5b48d0, 0x5b48f0),
              (0x5ab820, 0x5abca8), (0x5bbf70, 0x5bc3bb), (0x5bdb40, 0x5bdbca),
              (0x5b9f50, 0x5b9f90), (0x5ac9af, 0x5ac9d5),
              (0x4475d1, 0x44764b), (0x4476b6, 0x4476cb), (0x44b980, 0x44b990)]
    chosen = {a: b for a, b in blocks.items() if any(lo <= int(a, 16) < hi for lo, hi in ranges)}
    external = sorted({x for b in chosen.values() for x in re.findall(r'\bx([0-9a-f]+)\b', b)} - chosen.keys())
    for name, reference in [('reference', True), ('generated', False)]:
        content = '#![allow(unreachable_code,unused_variables,unused_parens)]\nuse runtime::*;\n'
        content += '\n'.join(custom.original(b, a) if reference else b for a, b in sorted(chosen.items()))
        content += '\n' + '\n'.join(f'pub fn x{a}(ctx:&mut Context)->Cont {{crate::stub(ctx,0x{a})}}' for a in external)
        entries = sorted(chosen.keys() | set(external), key=lambda x: int(x, 16))
        content += '\npub const BLOCKS:&[(u32,ContFn)]=&['
        content += ','.join(f'(0x{a},x{a})' for a in entries)
        content += ',(0xfffffffe,Context::return_from_x86)];\n'
        (src / (name + '.rs')).write_text(content)
    (src / 'custom_cards.rs').write_text(Path(__file__).with_name('custom_cards.rs').read_text())
    (src / 'lib.rs').write_text(Path(__file__).with_name('custom_cards_differential.rs').read_text())
    (output / 'Cargo.toml').write_text('[package]\nname="joey-custom-card-differential"\nversion="0.1.0"\nedition="2024"\n'
        '[dependencies]\nruntime={path="' + str((repo / 'runtime').resolve()) + '"}\n[workspace]\n')
    blob = executable.read_bytes()
    if custom.hashlib.sha256(blob).hexdigest() != custom.PINNED_EXE:
        raise ValueError('Unexpected original executable')
    pe = struct.unpack_from('<I', blob, 0x3c)[0]
    count, optional = struct.unpack_from('<H', blob, pe + 6)[0], struct.unpack_from('<H', blob, pe + 20)[0]
    chunks = bytearray(struct.pack('<I', count))
    for i in range(count):
        section = pe + 24 + optional + i * 40
        rva, size, offset = struct.unpack_from('<III', blob, section + 12)
        chunks.extend(struct.pack('<II', 0x400000 + rva, size))
        chunks.extend(blob[offset:offset + size])
    (output / 'image-sections.bin').write_bytes(chunks)
    for name in ['card_id.bin', 'card_pack.bin']:
        (output / name).write_bytes((resources / 'bin#' / name).read_bytes())
    print(output)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('repo', type=Path)
    p.add_argument('executable', type=Path)
    p.add_argument('resources', type=Path)
    p.add_argument('output', type=Path)
    args = p.parse_args()
    prepare(args.repo, args.executable, args.resources, args.output)
