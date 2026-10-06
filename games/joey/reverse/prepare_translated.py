"""Prepare a diagnostic crate around tc output, never fake an unsupported API.

Unknown imports panic with their DLL/function name when reached. This enables
compilation and runtime investigation, not gameplay acceptance.
"""
import argparse
import json
import re
from pathlib import Path


def prepare(repo, audit):
    output = repo / 'out/joey_cn'
    generated = output / 'src/generated.rs'
    if not generated.is_file():
        raise RuntimeError('Run the static translator before preparing the crate')
    (output / 'Cargo.toml').write_text('''[package]
name = "joey-original"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["lib", "cdylib"]

[dependencies]
runtime = { workspace = true }
winapi = { workspace = true }
host = { workspace = true }

[target.'cfg(target_family = "wasm")'.dependencies]
wasm-bindgen = { workspace = true }
''')
    (output / 'src/lib.rs').write_text('''#[cfg(target_family = "wasm")]
use wasm_bindgen::prelude::*;
mod generated;
mod imports;

#[cfg_attr(target_family = "wasm", wasm_bindgen)]
pub fn main() {
    let mut ctx = winapi::load(&generated::EXEDATA);
    ctx.memory.ansi_code_page = 936;
    winapi::kernel32::set_command_line(&mut ctx, "joey_pc_cn.exe -win -e");
    winapi::start(&mut ctx, &generated::EXEDATA);
}

// Diagnostic export for an end-to-end archive seek/read check, never a UI path.
#[cfg_attr(target_family = "wasm", wasm_bindgen)]
pub fn file_read_probe(path: &str, offset: u32, length: u32) -> Vec<u8> {
    use std::io::{Read, Seek, SeekFrom};
    assert!(length <= 262144);
    let mut file = host::fs::OpenOptions::new().read(true).open(path).unwrap();
    file.seek(SeekFrom::Start(offset as u64)).unwrap();
    let mut data = vec![0; length as usize];
    let read = file.read(&mut data).unwrap(); data.truncate(read); data
}
''')
    (output / 'src/main.rs').write_text('pub fn main() { joey_original::main(); }\n')
    modules = {}
    for row in json.loads(audit.read_text())['imports']:
        dll = row['dll'].lower().split('.')[0]
        function = row['function']
        if function.startswith('#'):
            function = 'ordinal' + function[1:]
        # Recheck the checkout after each ported API; the initial audit is frozen.
        module = repo / 'win32/winapi/src' / dll
        sources = list(module.rglob('*.rs')) if module.is_dir() else [module.with_suffix('.rs')]
        if any(path.is_file() and re.search(r'pub fn ' + re.escape(function) + r'\s*\(', path.read_text()) for path in sources):
            continue
        modules.setdefault(dll, []).append(function)
    source = ['// Diagnostic import failures; no successful fallback.', 'pub use winapi::*;']
    for dll, functions in modules.items():
        source += [f'pub mod {dll} {{', f'pub use winapi::{dll}::*;' if dll != 'oleaut32' else '']
        for function in functions:
            name = dll + '!' + function
            source += [f'pub fn {function}_stdcall(ctx: &mut runtime::Context) -> runtime::Cont {{',
                       'let esp = ctx.cpu.regs.esp as usize;',
                       'let stack = ctx.memory.bytes.get(esp..esp + 68).map(|bytes| bytes.chunks_exact(4).map(|b| u32::from_le_bytes(b.try_into().unwrap())).collect::<Vec<_>>());']
            if name == 'gdi32!CreateFontA':
                # x86 pointers index guest memory, not the WASM linear-memory
                # allocation. Only retain the bounded font name at this call.
                source += ['let face = stack.as_ref().and_then(|words| words.get(14)).and_then(|&ptr| ctx.memory.bytes.get(ptr as usize..ptr as usize + 64)).map(|bytes| {let end=bytes.iter().position(|&b| b==0).unwrap_or(bytes.len()); bytes[..end].to_vec()});',
                           'panic!("Unsupported original import: gdi32!CreateFontA; stack={:x?}; faceBytes={:x?}", stack, face);', '}']
            else:
                source += ['panic!(' + json.dumps('Unsupported original import: ' + name + '; stack={:x?}') + ', stack);', '}']
        source += ['}']
    (output / 'src/imports.rs').write_text('\n'.join(source) + '\n')
    generated.write_text(generated.read_text().replace('use winapi::*;', 'use crate::imports::*;'))
    workspace = repo / 'Cargo.toml'
    text = workspace.read_text()
    if '"out/joey_cn"' not in text:
        workspace.write_text(text.replace('members = [', 'members = [\n    "out/joey_cn",', 1))
    print(json.dumps({'diagnostic_import_traps': sum(map(len, modules.values())),
                      'output': str(output), 'running_game_verified': False}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('repo', type=Path)
    parser.add_argument('audit', type=Path)
    args = parser.parse_args()
    prepare(args.repo, args.audit)
