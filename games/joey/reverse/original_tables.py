"""Extract verified static tables from the original Joey executable, never execute it."""
import argparse
import hashlib
import json
from pathlib import Path
import struct


def extract_card_callbacks(executable):
    """Only callback tables with verified original bounds and indirect callers."""
    blob = executable.read_bytes()
    digest = hashlib.sha256(blob).hexdigest()
    if digest != '2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77':
        raise ValueError('Card callbacks apply only to the analyzed original executable')
    pe = struct.unpack_from('<I', blob, 0x3c)[0]
    section_count, = struct.unpack_from('<H', blob, pe + 6)
    optional_size, = struct.unpack_from('<H', blob, pe + 20)
    image_base, = struct.unpack_from('<I', blob, pe + 24 + 28)
    sections = []
    for index in range(section_count):
        header = pe + 24 + optional_size + 40 * index
        _, rva, length, offset = struct.unpack_from('<IIII', blob, header + 8)
        flags, = struct.unpack_from('<I', blob, header + 36)
        sections.append((image_base + rva, length, offset, flags))

    def read(address, length, code=False):
        for start, size, offset, flags in sections:
            if start <= address and address + length <= start + size:
                if code and not flags & 0x20000000:
                    raise ValueError('Callback outside executable section')
                return blob[offset + address - start:offset + address - start + length]
        raise ValueError('Callback evidence outside file-backed image')

    # 59dbe0 searches index 0..442. The initial middle is 221. Every caller
    # loads one of five DWORD fields in a 24-byte record and invokes that field.
    evidence = {
        0x59dbea: 'bfba010000', 0x59dc01: 'b9dd000000',
        0x59dc32: '668b04d5a8d05e00', 0x59dc70: '8d0c40',
        0x59decc: '8b04cdacd05e00', 0x59dedf: 'ffd0',
        0x59dc73: '8b04cdb0d05e00', 0x59dc91: 'ffd0',
        0x59dda9: '8d0440c1e003', 0x59ddaf: '8b88b4d05e00', 0x59ddca: 'ffd1',
        0x59de4f: '8b04cdb8d05e00', 0x59de67: 'ffd0',
        0x59de8f: '8b04cdbcd05e00', 0x59dea7: 'ffd0',
    }
    for address, expected in evidence.items():
        if read(address, len(bytes.fromhex(expected)), code=True).hex() != expected:
            raise ValueError('Original callback call-site bytes differ')
    table = read(0x5ed0a8, 443 * 24)
    records = [struct.unpack_from('<6I', table, index * 24) for index in range(443)]
    if any(row[0] > 0xffff for row in records) or any(a[0] >= b[0] for a, b in zip(records, records[1:])):
        raise ValueError('Original callback IDs are not strictly sorted')
    entries = {}
    for index, row in enumerate(records):
        for field, address in enumerate(row[1:], 1):
            if not address:
                continue
            if address % 16:
                raise ValueError('Unexpected unaligned original callback')
            entry = entries.setdefault(address, dict(address=f'{address:08x}', bytes=read(address, 10, code=True).hex(), references=[]))
            entry['references'].append(dict(record=index, cardID=row[0], fieldOffset=field * 4))
    # These five priority loops pass eight-byte rows to 5b5e00. That helper
    # reads the original card ID at offset zero, then calls row[+4]. They are
    # separate from the 443-row effect table above; never scan arbitrary data.
    activation_evidence = {
        0x5b6326: 'bec8d35d00', 0x5b632d: 'e8cefaffff',
        0x5b633d: '83c60881fec0d45d007ce3',
        0x5b6636: 'bec0d45d00', 0x5b663d: 'e8bef7ffff',
        0x5b6649: '83c60881fe50d85d007ce7',
        0x5b6666: 'be50d85d00', 0x5b666d: 'e88ef7ffff',
        0x5b6679: '83c60881fe58d85d007ce7',
        0x5b669b: 'be58d85d00', 0x5b66a2: 'e859f7ffff',
        0x5b66b2: '83c60881fed0d85d007ce3',
        0x5b6bac: 'bed0d85d00', 0x5b6bb3: 'e848f2ffff',
        0x5b6bc3: '83c60881fe80d95d007ce3',
        0x5b5e07: '668b08', 0x5b5efd: '8b4c24348d4424186a0050ff5104',
    }
    for address, expected in activation_evidence.items():
        if read(address, len(bytes.fromhex(expected)), code=True).hex() != expected:
            raise ValueError('Original activation priority call-site bytes differ')
    activation_tables = []
    boundaries = (0x5dd3c8, 0x5dd4c0, 0x5dd850, 0x5dd858, 0x5dd8d0, 0x5dd980)
    for start, end in zip(boundaries, boundaries[1:]):
        data = read(start, end - start)
        for index, (card_id, address) in enumerate(struct.iter_unpack('<II', data)):
            if card_id > 0xffff or not address or address % 16:
                raise ValueError('Invalid original activation priority row')
            entry = entries.setdefault(address, dict(address=f'{address:08x}', bytes=read(address, 10, code=True).hex(), references=[]))
            entry['references'].append(dict(tableAddress=f'{start:08x}', record=index, cardID=card_id, fieldOffset=4))
        activation_tables.append(dict(tableAddress=f'{start:08x}', endAddress=f'{end:08x}', recordCount=len(data) // 8,
                                      recordBytes=8, tableSHA256=hashlib.sha256(data).hexdigest()))
    return dict(executableSHA256=digest, tableAddress='005ed0a8', recordCount=443, recordBytes=24,
                tableSHA256=hashlib.sha256(table).hexdigest(),
                verifiedInstructions={f'{address:08x}': value for address, value in evidence.items()},
                activationPriorityTables=activation_tables,
                activationVerifiedInstructions={f'{address:08x}': value for address, value in activation_evidence.items()},
                entries=[entries[address] for address in sorted(entries)])


def extract(executable, cards):
    blob = executable.read_bytes()
    if hashlib.sha256(blob).hexdigest() != '2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77':
        raise ValueError('These verified addresses apply only to the analyzed executable')
    by_legacy = {c['legacy']: c for c in cards}

    def read(address, fmt):
        return struct.unpack_from('<' + fmt, blob, address - 0x400000)

    def string(address):
        offset = address - 0x400000
        return blob[offset:offset+64].split(b'\0')[0].decode('ascii')

    pointer = 0x5dd9b4
    starter = {}
    for group in ('main', 'extra', 'side'):
        count, = read(pointer, 'I')
        pointer += 4
        if count > 80:
            raise ValueError('Invalid starter count')
        identifiers = read(pointer, str(count) + 'I')
        starter[group] = [by_legacy[i]['code'] for i in identifiers]
        pointer += 4 * count

    limits = []
    for pointer in range(0x5efbcc, 0x5efc64, 4):
        legacy, limit = read(pointer, 'HH')
        card = by_legacy[legacy]
        limits.append(dict(legacy=legacy, code=card['code'], name=card['name'], limit=limit))

    normal = [[f'cpu_{read(0x5db158+4*(level*5+i), "I")[0]:03d}' for i in range(5)]
              for level in range(1, 8)]
    full = {}
    for level in range(3, 10):
        count, = read(0x5db080 + 4*level, 'I')
        full[str(level)] = ['ful_' + string(read(0x5db0a8+4*((level-3)*7+i), 'I')[0]).lower()
                            for i in range(count)]
    thresholds=dict(up={str(n):read(0x5daf40+4*n,'I')[0] for n in range(1,9)},
                    down={str(n):read(0x5daf64+4*n,'I')[0] for n in range(2,10)})
    audio = {}
    for group, base, count in [('effects', 0x5efd40, 110), ('music', 0x5f0a28, 14)]:
        rows = []
        for index in range(count):
            kind, volume, pointer, loop = read(base + 16*index, 'IIII')
            name = string(pointer)
            if not name.lower().endswith('.wav'):
                raise ValueError('Invalid original audio table')
            rows.append(dict(index=index, name=name, volume=volume, loop=bool(loop)))
        audio[group] = rows
    return dict(starter=starter, limits=limits, cpuNormal=normal, cpuFull=full,levelThresholds=thresholds,audio=audio,
                evidence=dict(executableSHA256=hashlib.sha256(blob).hexdigest(),
                              starterFunction='005bdc50', starterTable='005dd9b4',
                              limitsFunction='005be190', limitsTable='005efbcc',
                              cpuSelectionFunction='0044bbe0',
                              effectsTable='005efd40', musicTable='005f0a28',
                              musicSelectionFunction='0044c320', summonReactionFunction='00403800'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('executable', type=Path)
    parser.add_argument('cards', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    result = extract(args.executable, json.loads(args.cards.read_text()))
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps(dict(starter={g: len(v) for g,v in result['starter'].items()}, limits=len(result['limits']),
                         cpuNormal=len(result['cpuNormal']), cpuFull=len(result['cpuFull']))))
