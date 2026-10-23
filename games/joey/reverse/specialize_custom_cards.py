#!/usr/bin/env python3
"""Install five additive cards into the pinned generated Joey blocks, reproducibly."""
import argparse
import hashlib
import json
from pathlib import Path
import re

FUNCTION = re.compile(r'pub fn x([0-9a-f]+)\(ctx: &mut Context\) -> Cont \{.*?\n\}', re.S)
PINNED_EXE = '2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77'
RULES_VERSION = 'joey-five-collectible-cards-v2'
PATCHES = {'402310': {'edits': [['0x45bu16', '0x45fu16']],
            'sha256': 'facfee22eb9786ead54d93665a3f77d0530772f26c7b9c28abb79b7171f87186'},
 '43a9b1': {'edits': [['0x45bu32', '0x460u32']],
            'sha256': '4cfa23cb047f3443d4836a0f5f0c3b868d96853bf9a248b103b90e50ce967071'},
 '43aa9c': {'edits': [['0x45bu32', '0x460u32']],
            'sha256': 'dd6a2f43891195914d84b1e114eef027a1ce3c8675c75c5c757396bb5348ac04'},
 '44566c': {'edits': [['pub fn x44566c(ctx: &mut Context) -> Cont {',
                       'pub fn x44566c(ctx: &mut Context) -> Cont {\n'
                       '    crate::custom_cards::reward_statistics(ctx);']],
            'sha256': 'b69241cf0d32a447d03b793c51d1f1b6e522ff863459b4dff462bbe2d7366a3c'},
 '4456dc': {'edits': [['Cont(x4456e3)', 'crate::custom_cards::reward_choice(ctx)']],
            'sha256': '8564669cfb0abd587765e2f31c56623e573923098f437b7fd997f655a3e2d52b'},
 '4475f0': {'edits': [['ctx.jne(Cont(x4475f8), Cont(x4476eb))',
                       'Cont(x4475f8) // Network winners use the same reward UI after the existing win/abort '
                       'gates.']],
            'sha256': '9dad537924b8538579ef5732ff0b69df7e515e055f58ddc134d23c2d61d50a48'},
 '463f15': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': '29f70e51f277c81a5aa81c009beadd1beddd2b5d41d11ab2579ea8a67a1894a4'},
 '463f87': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': '215ac0e7df4f35e2d411af18cae76654f9087f3d092aae365d8be2a2e6171f0c'},
 '46e5b3': {'edits': [['0x45bu32', '0x460u32']],
            'sha256': 'dccce1730d57c8a88efdeed18cf3d5e06a3e465b44e28897817d8c7d88cb2ec0'},
 '46e5c7': {'edits': [['0x45au32', '0x45fu32']],
            'sha256': '0042eafce51051abd47b32bb69c9957b8b030efc30a97f2fc5ba9c0465d74e92'},
 '46e5ce': {'edits': [['0x45au32', '0x45fu32']],
            'sha256': '1e903f4e50edc81ddce55df144cfbbd08192a3e968392da619ddc2c5b23a9631'},
 '476327': {'edits': [['0x45bu32', '0x460u32']],
            'sha256': '5b77d7adb79070ae87a941bc36ffbac53e41c5d93c2b0d72a4ac1721b3a8e147'},
 '476339': {'edits': [['0x45au32', '0x45fu32']],
            'sha256': 'a0f45a08af18ad60530fb068d8cd897a0fd599e3f95e3e537b7fe76cd048a43e'},
 '476340': {'edits': [['0x45au32', '0x45fu32']],
            'sha256': '1a5bb7b209727d7de439ce1078326b1ab2af576dd66d36c050bb0807a904a2b0'},
 '47da71': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': 'dd7c8d92d6cede0c1c304979a0b2e8be3ed2cbee371309e586a43cd7421426ec'},
 '47dbfc': {'edits': [['0x45bu32', '0x460u32']],
            'sha256': '0fd7dfe0d83c8a756f33fc8bdf94288b7831b47d40ec28ce38f297502a32daa1'},
 '47dc79': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': 'a8fc18e3b436b6b458818812ffa5b5ba5b08b1bf1096c18ff58a919296526a76'},
 '47dce0': {'edits': [['    // 0047dd00 call 0054D420h',
                       '    crate::custom_cards::save_seen(ctx);\n    // 0047dd00 call 0054D420h']],
            'sha256': '977d3dd8201856035a5ed2a28af69337663c6949090a736a95b7dab6bb41726f'},
 '47dd90': {'edits': [['pub fn x47dd90(ctx: &mut Context) -> Cont {',
                       'pub fn x47dd90(ctx: &mut Context) -> Cont {\n'
                       '    crate::custom_cards::restore_seen(ctx);']],
            'sha256': 'd679a7d9452e01bdbc9265748da5848a9def3db8f711f8dfa5afaacdc9245d06'},
 '584d25': {'edits': [['    // 00584d2d cmp eax,3EEh',
                       '    if ctx.cpu.regs.eax == 1950 {\n'
                       '        crate::custom_cards::resolved_tea(ctx);\n'
                       '        return Cont(x584dc3);\n'
                       '    }\n'
                       '    // 00584d2d cmp eax,3EEh']],
            'sha256': '3dfb2a1f71d624b254e1bd3926eb090d5f2a21d5175d6334ea3f1c95056f3554'},
 '59dbe0': {'edits': [['pub fn x59dbe0(ctx: &mut Context) -> Cont {',
                       'pub fn x59dbe0(ctx: &mut Context) -> Cont {\n'
                       '    if ctx.memory.read::<u16>(ctx.cpu.regs.esp + 4) == crate::custom_cards::TEA {\n'
                       '        ctx.cpu.regs.eax = 65;\n'
                       '        return ctx.ret32(0);\n'
                       '    }']],
            'sha256': 'f2faa8cff9bdeb2af7250e28fff64c1612ceb038d306912a23d964c67bac2680'},
 '5abc48': {'edits': [['pub fn x5abc48(ctx: &mut Context) -> Cont {',
                       'pub fn x5abc48(ctx: &mut Context) -> Cont {\n'
                       '    crate::custom_cards::resolved_summon(ctx);']],
            'sha256': '8c71bd20a3d03c0523f0ad34d3accb65c4fe080f53452483d64459515dfcf86f'},
 '5ac9af': {'edits': [['pub fn x5ac9af(ctx: &mut Context) -> Cont {',
                       'pub fn x5ac9af(ctx: &mut Context) -> Cont {\n'
                       '    crate::custom_cards::begin_flip(ctx);']],
            'sha256': '8d6d7e1432bd5c550d1517fe7a89c9d9def19e031c09dcf30d7f4d7f583941cf'},
 '5b5f31': {'edits': [['pub fn x5b5f31(ctx: &mut Context) -> Cont {',
                       'pub fn x5b5f31(ctx: &mut Context) -> Cont {\n'
                       '    let tea = crate::custom_cards::ai_tea_fallback(ctx);'],
                      ['ctx.ret32(0)', 'if tea { ctx.cpu.regs.eax = 1; }\n    ctx.ret32(0)']],
            'sha256': 'd082f88d4bbb9751bfd138f7ddbe5427e7d3c34ab4259f87b0eaf99135482b5f'},
 '5b9f50': {'edits': [['pub fn x5b9f50(ctx: &mut Context) -> Cont {',
                       'pub fn x5b9f50(ctx: &mut Context) -> Cont {\n'
                       '    crate::custom_cards::reset_duel(ctx);']],
            'sha256': 'fa9a1ddd37981379c3933404d7768443eaf9d7f823a2fd01fef394612fa6a587'},
 '5bc050': {'edits': [['pub fn x5bc050(ctx: &mut Context) -> Cont {',
                       'pub fn x5bc050(ctx: &mut Context) -> Cont {\n'
                       '    if crate::custom_cards::resolve_victory(ctx) {\n'
                       '        ctx.cpu.regs.eax = 1;\n'
                       '        return ctx.ret32(0);\n'
                       '    }']],
            'sha256': 'dd0f4e20484e6cd0326e1102c61702c1cd416b9deebc73fef3fef7b39026e6aa'},
 '5bdb40': {'edits': [['pub fn x5bdb40(ctx: &mut Context) -> Cont {',
                       'pub fn x5bdb40(ctx: &mut Context) -> Cont {\n'
                       '    if crate::custom_cards::reject_network_deck(ctx) {\n'
                       '        ctx.cpu.regs.eax = 1;\n'
                       '        return ctx.ret32(0);\n'
                       '    }']],
            'sha256': 'ed77054740bef1ab2895e8ed6471ec76f16c57875606319b885a00ab2e25c341'},
 '5bed05': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': '44cba8a6413c14aa6eb6ef5c14d8c6d3c265808060b2fb8c622b64692f5d6802'},
 '5bee12': {'edits': [['0xa54582u32', '0xa5458cu32']],
            'sha256': 'e0ac9345473493ab27ae81f18b55bd56bfec07adffcd62a339de3fd581d913e7'}}


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def original(body, address):
    spec = PATCHES.get(address)
    if spec is None or digest(body) == spec['sha256']:
        return body
    for before, after in reversed(spec['edits']):
        if body.count(after) != 1:
            raise ValueError(f'Unknown translated block {address}: missing unique custom fragment')
        body = body.replace(after, before, 1)
    if digest(body) != spec['sha256']:
        raise ValueError(f'Unknown translated block {address}: pinned source differs')
    return body


def patched(body, address):
    body = original(body, address)
    for before, after in PATCHES[address]['edits']:
        if body.count(before) != 1:
            raise ValueError(f'Expected one source fragment in {address}')
        body = body.replace(before, after, 1)
    return body


def install(repo, check=False):
    source = repo / 'out/joey_cn/src'
    changed, seen, report = {}, set(), []
    for path in sorted((source / 'generated').glob('part_*.rs')):
        text = path.read_text()

        def transform(match):
            address, body = match[1], match[0]
            if address not in PATCHES:
                return body
            if address in seen:
                raise ValueError(f'Duplicate block {address}')
            seen.add(address)
            result = patched(body, address)
            report.append(dict(address=address, original=PATCHES[address]['sha256'], custom=digest(result)))
            return result

        result = FUNCTION.sub(transform, text)
        if result != text:
            changed[path] = result
    if seen != PATCHES.keys():
        raise ValueError(f'Missing translated blocks: {PATCHES.keys() - seen}')
    module = Path(__file__).with_name('custom_cards.rs').read_text()
    target = source / 'custom_cards.rs'
    if not target.exists() or target.read_text() != module:
        changed[target] = module
    lib = source / 'lib.rs'
    text = lib.read_text()
    if 'mod custom_cards;' not in text:
        if text.count('mod imports;') != 1:
            raise ValueError('Unknown translated library entry')
        changed[lib] = text.replace('mod imports;', 'mod imports;\nmod custom_cards;', 1)
    if check and changed:
        raise ValueError('Custom cards are not current: ' + ', '.join(str(p) for p in changed))
    provenance = dict(rulesVersion=RULES_VERSION, pinnedExecutableSHA256=PINNED_EXE,
                      firstInternal=1115, firstLegacy=1950, count=5, cardCount=1120,
                      moduleSHA256=digest(module), blocks=report)
    if not check:
        # Validate every block before writing any generated source.
        for path, text in changed.items():
            path.write_text(text)
        (source.parent / 'custom-cards-provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    print(json.dumps(dict(rulesVersion=RULES_VERSION, blocks=len(report), changedFiles=len(changed), check=check)))
    return provenance


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    install(args.repo, args.check)
