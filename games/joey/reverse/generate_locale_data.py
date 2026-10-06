#!/usr/bin/env python3
"""Freeze canonical values read from the isolated reference Wine environment.

Only the three supported locale profiles and explicitly probed field ranges are
represented. Every stored payload preserves the original bytes, including NUL,
binary font signatures and numeric results. This is not a full Windows NLS DB.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('snapshot', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--provenance', required=True, type=Path)
args = parser.parse_args()
raw = args.snapshot.read_bytes()
lines = raw.decode('ascii').splitlines()
assert lines[0] == '# 000003a8', 'The captured system ACP must be 936'
locales = [0x0409, 0x0411, 0x0804]
kinds = list(range(1, 0xa9)) + list(range(0x1001, 0x1036))
modes = 'WACND'
rows = {}
for line in lines[1:]:
    mode, locale, kind, count, error, *values = line.split()
    locale, kind, count, error = [int(v, 16) for v in (locale, kind, count, error)]
    assert mode in modes and locale in locales and kind in kinds
    values = [int(v, 16) for v in values]
    assert count == len(values) and bool(count) != bool(error)
    assert error in (0, 1004)
    width = 2 if mode in 'WN' else 1
    assert all(0 <= v < 1 << (width * 8) for v in values)
    payload = b''.join(v.to_bytes(width, 'little') for v in values)
    key = (locale, kind, mode)
    assert key not in rows
    rows[key] = (payload, error)
assert len(rows) == len(locales) * len(kinds) * len(modes)
count = len(locales) * len(kinds)
payload_start = 8 + count * 44
index, payloads = bytearray(), bytearray()
for locale in locales:
    for kind in kinds:
        index.extend(struct.pack('<I', (locale << 16) | kind))
        for mode in modes:
            data, error = rows[locale, kind, mode]
            index.extend(struct.pack('<IHH', payload_start + len(payloads), len(data), error))
            payloads.extend(data)
        numeric, error = rows[locale, kind, 'N']
        assert rows[locale, kind, 'D'] == (numeric, error)
        assert not numeric or len(numeric) == 4
blob = b'JLC1' + struct.pack('<I', count) + index + payloads
args.output.write_bytes(blob)
metadata = {
    'reference': 'Canonical LOCALE_NOUSEROVERRIDE values from the task-owned Wine reference session; no personal locale overrides or user files',
    'snapshot_sha256': hashlib.sha256(raw).hexdigest(),
    'snapshot_bytes': len(raw), 'system_acp': 936, 'locales': locales,
    'field_ranges': [[1, 0xa8], [0x1001, 0x1035]],
    'modes': dict(W='UTF-16', A='locale ANSI codepage', C='system ACP 936', N='numeric UTF-16', D='numeric ANSI'),
    'records': len(rows), 'binary_sha256': hashlib.sha256(blob).hexdigest(),
    'binary_bytes': len(blob),
    'probe_source_sha256': hashlib.sha256(Path(__file__).with_name('locale_probe.c').read_bytes()).hexdigest(),
    'limitations': ['Three profiles only; no user overrides', 'Reference is Wine, not a physical Windows XP installation'],
}
args.provenance.write_text(json.dumps(metadata, indent=2) + '\n')
print(json.dumps({k: metadata[k] for k in ('records', 'binary_bytes', 'binary_sha256')}))
