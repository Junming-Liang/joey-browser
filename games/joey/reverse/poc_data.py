"""Read original Power of Chaos resources without executing or modifying the game."""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import struct


def archive_index(data: bytes, archive_size: int) -> list[dict]:
    if len(data) < 12 or data[:8] != b"KCEJYUGI":
        raise ValueError("Invalid DAT header")
    count = struct.unpack_from("<I", data, 8)[0]
    if count > 100000 or len(data) < 12 + count * 268:
        raise ValueError("Truncated DAT index")
    result = []
    for i in range(count):
        record = data[12 + i * 268:12 + (i + 1) * 268]
        name = bytes((b >> 4) | ((b & 15) << 4) for b in record[:256]).split(b"\0")[0].decode("shift_jis")
        path = pathlib.PurePosixPath(name.replace("\\", "/"))
        offset, size, extra = struct.unpack_from("<III", record, 256)
        if path.is_absolute() or ".." in path.parts or ":" in name or offset + size > archive_size:
            raise ValueError("Unsafe DAT entry")
        result.append(dict(name=name, offset=offset, size=size, extra=extra))
    return result


def lzss(data: bytes, size: int) -> bytes:
    if not 0 <= size <= 64 * 1024 * 1024:
        raise ValueError("Invalid output size")
    ring, cursor, position, output = bytearray(4096), 0xFEE, 0, bytearray()
    while len(output) < size:
        if position >= len(data):
            raise ValueError("Truncated flags")
        flags = data[position]
        position += 1
        for bit in range(8):
            if len(output) == size:
                break
            if flags & (1 << bit):
                if position >= len(data):
                    raise ValueError("Truncated literal")
                value = data[position]
                position += 1
                output.append(value)
                ring[cursor] = value
                cursor = (cursor + 1) & 4095
            else:
                if position + 2 > len(data):
                    raise ValueError("Truncated reference")
                lo, hi = data[position:position + 2]
                position += 2
                offset, length = lo | ((hi & 0xF0) << 4), (hi & 15) + 3
                if len(output) + length > size:
                    raise ValueError("Reference exceeds output size")
                for j in range(length):
                    value = ring[(offset + j) & 4095]
                    output.append(value)
                    ring[cursor] = value
                    cursor = (cursor + 1) & 4095
    return bytes(output)


def image(data: bytes):
    from PIL import Image
    import io
    if data[:4] != b"yga\0":
        return Image.open(io.BytesIO(data)).convert("RGBA")
    width, height, mode, raw_size, compressed_size = struct.unpack_from("<5I", data, 4)
    if width * height * 4 != raw_size or raw_size > 64 * 1024 * 1024 or mode not in (0, 1):
        raise ValueError("Invalid YGA header")
    if compressed_size > len(data) - 24:
        raise ValueError("Truncated YGA data")
    pixels = lzss(data[24:24 + compressed_size], raw_size) if mode else data[24:24 + raw_size]
    if len(pixels) != raw_size:
        raise ValueError("Truncated YGA pixels")
    return Image.frombytes("RGBA", (width, height), pixels, "raw", "BGRA")


def legacy_to_internal(legacy: int, inverse: bytes) -> int:
    if not 0 <= legacy < 4000:
        return 0
    return struct.unpack_from("<H", inverse, (legacy % 2000) * 2)[0] + (legacy >= 2000)


def deck(data: bytes, inverse: bytes, cards: list[dict]) -> dict:
    if len(data) < 14:
        raise ValueError("Truncated YDC")
    result, offset = {}, 8
    for group in ("main", "extra", "side"):
        if offset + 2 > len(data):
            raise ValueError("Truncated deck count")
        count = struct.unpack_from("<H", data, offset)[0]
        offset += 2
        if count > 200 or offset + count * 2 > len(data):
            raise ValueError("Invalid deck count")
        ids = struct.unpack_from(f"<{count}H", data, offset)
        indices = [legacy_to_internal(c, inverse) for c in ids]
        if any(i == 0 or i >= len(cards) or not cards[i]["pack"] for i in indices):
            raise ValueError("Deck references disabled/unknown card")
        result[group] = [cards[i]["code"] for i in indices]
        offset += count * 2
    if offset != len(data):
        raise ValueError("Trailing deck data")
    return result


def catalog(root: pathlib.Path) -> list[dict]:
    tables = root / "bin#"
    read = lambda name: (tables / (name + ".bin")).read_bytes()
    props, packs, ids, passwords = (read(n) for n in ("card_prop", "card_pack", "card_id", "card_pass"))
    count = len(props) // 4
    if len(props) % 4 or len(packs) != count * 2 or len(ids) != count * 2 or len(passwords) != count * 4:
        raise ValueError("Inconsistent card tables")
    names = {lang: read("card_name" + lang) for lang in ("eng", "jpn")}
    descriptions = {lang: read("card_desc" + lang) for lang in names}
    indices = {lang: read("card_indx" + lang) for lang in names}
    art = dict((int(i), name) for i, name in re.findall(r"//\s*(\d{4}):\[\d+\]\s*\r?\n([^\r\n]+)", (root / "card/list_card.txt").read_text("latin1")))
    cards = []
    for i in range(count):
        prop = struct.unpack_from("<I", props, i * 4)[0]
        race = (prop >> 20) & 31
        bcd = passwords[i * 4:i * 4 + 4].hex()
        code = int(bcd) if bcd.isdecimal() else 0
        card = dict(internal=i, legacy=struct.unpack_from("<H", ids, i * 2)[0], code=code,
                    pack=struct.unpack_from("<H", packs, i * 2)[0], prop=prop, raceIndex=race,
                    attributeIndex=prop >> 29, level=(prop >> 25) & 15,
                    attack=((prop >> 9) & 511) * 10, defense=(prop & 511) * 10,
                    subtype=(prop >> 17) & 7, monsterType=(prop >> 18) & 3,
                    art=art.get(i))
        if race in (21, 22, 23):
            card.update(attack=0, defense=0, level=0)
        for lang, suffix, encoding in (("eng", "En", "latin1"), ("jpn", "", "gbk")):
            card["name" + suffix] = names[lang][i * 64:(i + 1) * 64].split(b"\0")[0].decode(encoding)
            position = struct.unpack_from("<I", indices[lang], i * 4)[0]
            if position >= len(descriptions[lang]):
                raise ValueError("Description offset out of bounds")
            card["description" + suffix] = descriptions[lang][position:].split(b"\0")[0].decode(encoding)
        cards.append(card)
    return cards


def export(root: pathlib.Path, output: pathlib.Path) -> dict:
    cards = catalog(root)
    output.mkdir(parents=True, exist_ok=True)
    (output / "cards-original.json").write_text(json.dumps([c for c in cards if c["pack"]], ensure_ascii=False), "utf8")
    inverse = (root / "bin#/card_intid.bin").read_bytes()
    decks = {p.stem.lower(): deck(p.read_bytes(), inverse, cards) for p in sorted(root.rglob("*.ydc"))}
    (output / "cpu-decks.json").write_text(json.dumps(decks), "utf8")
    summary = dict(tableEntries=len(cards), enabled=sum(bool(c["pack"]) for c in cards),
                   joey=sum(bool(c["pack"] & 4) for c in cards), decks=len(decks))
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("resources", type=pathlib.Path)
    parser.add_argument("output", type=pathlib.Path)
    args = parser.parse_args()
    print(json.dumps(export(args.resources, args.output)))
