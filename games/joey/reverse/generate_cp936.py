"""Generate Windows CP936/CP932 tables from Microsoft's historical public mapping.

Input: https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WindowsBestFit/bestfit936.txt
Canonical composition uses Python's explicitly frozen Unicode 3.2 database,
matching the Windows XP-era experiment instead of an unpinned current table.
"""
import argparse
import hashlib
import json
import re
import struct
import unicodedata
from pathlib import Path

SOURCE_SHA256 = 'e5070a2d6ad26619f5872ddbe64d3381c11620af5adbb04cda0f0abb1a91fdae'
SOURCES = {936: (SOURCE_SHA256,128),
           932: ('2614cfea35c3c86c41d33198793a84ca44edee3cf0ee0013a61a43fba4ece331',62)}


def generate(source, repo, code_page=936):
    raw = source.read_bytes()
    source_hash, section_count = SOURCES[code_page]
    if hashlib.sha256(raw).hexdigest() != source_hash:
        raise RuntimeError(f'Historical CP{code_page} source hash differs; investigate before changing the pin')
    text = raw.decode('latin1')
    assert re.search(r'^CODEPAGE\s+' + str(code_page) + r'\s',text)
    defaults = re.search(r'^CPINFO\s+2\s+(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)',text,re.M)
    assert defaults
    default_mb, default_unicode = [int(v,16) for v in defaults.groups()]
    mb, wc = [default_unicode] * 65536, [default_mb] * 65536
    sections = []
    current = None
    for line in text.splitlines():
        body = line.split(';', 1)[0].strip()
        match = re.match(r'(MBTABLE|DBCSTABLE|WCTABLE)\s+(\d+)', body)
        if match:
            if current and current['read'] != current['count']:
                raise RuntimeError('Incomplete table: ' + str(current))
            lead = re.search(r'LeadByte\s*=\s*(0x[0-9a-fA-F]+)', line)
            current = {'kind': match[1], 'count': int(match[2]), 'read': 0,
                       'lead': int(lead[1], 16) if lead else None}
            sections.append(current)
        elif current and current['read'] < current['count']:
            values = re.match(r'^(0x[0-9a-fA-F]+)\s+(0x[0-9a-fA-F]+)', body)
            if not values:
                continue
            key, value = (int(x, 16) for x in values.groups())
            if current['kind'] == 'WCTABLE':
                wc[key] = value
            else:
                mb[key | ((current['lead'] or 0) << 8)] = value
            current['read'] += 1
    if len(sections) != section_count or any(s['count'] != s['read'] for s in sections):
        raise RuntimeError('Incomplete Microsoft mapping tables')
    pairs = []
    frozen = unicodedata.ucd_3_2_0
    for value in range(65536):
        decomposition = frozen.decomposition(chr(value)).split()
        if len(decomposition) != 2 or decomposition[0].startswith('<'):
            continue
        a, b = (int(x, 16) for x in decomposition)
        if a <= 65535 and b <= 65535 and frozen.normalize('NFC', chr(a) + chr(b)) == chr(value):
            pairs.append(((a << 16) | b, value))
    target = repo / 'runtime/src'
    data = struct.pack('<131072H', *(mb + wc))
    (target / f'cp{code_page}.bin').write_bytes(data)
    (target / 'cp936_composition.rs').write_text(
        '// Generated from Python ucd_3_2_0; do not substitute current Unicode data.\n'
        'pub const COMPOSITION: &[(u32,u16)] = &[\n' +
        ''.join(f'    (0x{key:08x},0x{value:04x}),\n' for key, value in sorted(pairs)) + '];\n')
    report = {'source_url': f'https://www.unicode.org/Public/MAPPINGS/VENDORS/MICSFT/WindowsBestFit/bestfit{code_page}.txt', 'source_sha256': source_hash,
              'code_page': code_page,'default_mb': default_mb,'default_unicode': default_unicode,
              'sections': len(sections), 'single_byte_entries': sections[0]['count'],
              'double_byte_entries': sum(s['count'] for s in sections if s['kind'] == 'DBCSTABLE'),
              'wide_entries': sections[-1]['count'], 'composition_unicode': frozen.unidata_version,
              'composition_pairs': len(pairs), 'binary_sha256': hashlib.sha256(data).hexdigest()}
    print(json.dumps(report))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('repo', type=Path)
    parser.add_argument('--code-page',type=int,choices=[932,936],default=936)
    args = parser.parse_args()
    generate(args.source, args.repo,args.code_page)
