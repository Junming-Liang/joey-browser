"""Freeze the task-owned reference keyboard calls, never browser key guesses.

The source snapshot is pinned. It covers ToAscii(scan=0,flags=0) and the
installed Wine layout's five MapVirtualKeyA modes, not all Windows layouts.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

REFERENCE_SHA256 = 'bd7efd439e79dd0bc5bbf1d35faf6d2cbfcd98c7f950e8ab81bfc9360cf9a478'


def generate(source: Path, output: Path, probe_exe: Path):
    raw = source.read_bytes()
    if hashlib.sha256(raw).hexdigest() != REFERENCE_SHA256:
        raise ValueError('Reference keyboard snapshot changed')
    lines = raw.decode('ascii').splitlines()
    assert lines.pop(0) == 'H e0010804'
    ascii_cells = [None] * 4096
    map_cells = [None] * 3840
    writes = {0: 0, 1: 0, 2: 0}
    for line in lines:
        fields = line.split()
        if fields[0] == 'A':
            modifiers, key, result, word = (int(value, 16) for value in fields[1:])
            assert 0 <= modifiers < 16 and 0 <= key < 256 and result in (0, 1)
            if result == 0:
                assert word == 0xa55a
                length, word = 0, 0
            elif word >> 8 == 0xa5:
                # In this pinned snapshot these are all single-byte ASCII;
                # the only double-byte result is the reference's VK_ICO_CLEAR.
                assert word & 255 < 128
                length, word = 1, word & 255
            else:
                assert word == 0xc0a1 and key == 0xe6
                length = 2
            index = modifiers * 256 + key
            assert ascii_cells[index] is None
            ascii_cells[index] = struct.pack('<HBB', word, length, result)
            writes[length] += 1
        elif fields[0] == 'M':
            mode, key, value = (int(value, 16) for value in fields[1:])
            assert 0 <= mode < 5
            group = {0: 0, 0xe000: 1, 0xe100: 2}[key & ~255]
            index = (group * 5 + mode) * 256 + (key & 255)
            assert map_cells[index] is None
            map_cells[index] = struct.pack('<I', value)
        else:
            raise ValueError('Unexpected reference record')
    assert all(cell is not None for cell in ascii_cells + map_cells)
    assert writes == {0: 3442, 1: 646, 2: 8}
    output.mkdir(parents=True, exist_ok=True)
    tables = {'keyboard_data.bin': b''.join(ascii_cells), 'keymap_data.bin': b''.join(map_cells)}
    files = {}
    for name, content in tables.items():
        (output / name).write_bytes(content)
        files[name] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    report = {
        'layout': 'e0010804', 'source': 'fresh task-owned Wine winxp desktop with zh_CN locale',
        'scan_code': 0, 'flags': 0, 'modifier_states': 16, 'virtual_keys': 256,
        'cases': 4096, 'write_byte_counts': writes, 'map_cases': 3840,
        'map_types': [0, 1, 2, 3, 4], 'map_code_prefixes': [0, 0xe000, 0xe100],
        'buffer_rule': 'A single ANSI byte preserves the caller WORD high byte; one character may occupy two CP936 bytes.',
        'personal_data': False,
        'limitations': 'Fixed installed Wine Chinese layout and ToAscii scan=0/flags=0 only. Other layouts, dead keys, Alt+numpad and IME remain unimplemented. Wine winxp is not physical Windows XP.',
        'files': dict(files),
    }
    for name, path in [('source', Path(__file__).with_name('keyboard_probe.c')),
                       ('exe', probe_exe), ('reference', source)]:
        content = path.read_bytes()
        report['files'][name] = {'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
    (output / 'keyboard-provenance.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ascii_cases': 4096, 'map_cases': 3840, 'tables': files}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--probe-exe', type=Path, required=True)
    args = parser.parse_args()
    generate(args.input, args.output_dir, args.probe_exe)
