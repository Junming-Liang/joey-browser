#!/usr/bin/env bash
# Rebuild the translator and regenerate from original code, without data scans.
set -euo pipefail
repo=${1:?isolated Theseus checkout}
exe_file=${2:?original joey_pc_cn.exe}
blocks=${3:?Ghidra basic-block entry list}
audit=${4:?original static import audit JSON}
script_dir=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$repo" && pwd)
task_tools=$(dirname "$repo")
export CARGO_HOME="$task_tools/rust/cargo"
export RUSTUP_HOME="$task_tools/rust/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_BUILD_JOBS=4
export CARGO_PROFILE_DEV_DEBUG=0
python3 - "$exe_file" "$repo" "$blocks" "$script_dir/runtime-entries.json" "$script_dir" <<'PY'
import hashlib,sys,json,struct
from pathlib import Path
sys.path.insert(0,sys.argv[5])
from original_tables import extract_card_callbacks
exe=Path(sys.argv[1]); repo=Path(sys.argv[2])
assert hashlib.sha256(exe.read_bytes()).hexdigest() == '2f54f0542faf72c4de90ca5e0d9dcf14922cc183f1027215d3dd421d127bce77'
raw=exe.read_bytes(); pe=struct.unpack_from('<I',raw,0x3c)[0]
count=struct.unpack_from('<H',raw,pe+6)[0]; opt=struct.unpack_from('<H',raw,pe+20)[0]
image_base=struct.unpack_from('<I',raw,pe+24+28)[0]
entries={int(line,16) for line in Path(sys.argv[3]).read_text().splitlines() if line.strip()}
for entry in json.loads(Path(sys.argv[4]).read_text()):
 address=int(entry['address'],16); expected=bytes.fromhex(entry['bytes']); verified=False
 for i in range(count):
  header=pe+24+opt+40*i; size,rva,raw_size,offset=struct.unpack_from('<IIII',raw,header+8)
  if image_base+rva<=address<image_base+rva+raw_size:
   index=offset+address-image_base-rva
   assert raw[index:index+len(expected)]==expected, 'Runtime entry bytes differ'
   verified=True; break
 assert verified,'Runtime entry outside file-backed code';entries.add(address)
# The patch adds a workspace member. Give cargo a minimal manifest before the
# generated sources exist; tc is the only package built at this stage.
crate=repo/'out/joey_cn'; (crate/'src').mkdir(parents=True,exist_ok=True)
callbacks=extract_card_callbacks(exe)
before=len(entries)
entries.update(int(entry['address'],16) for entry in callbacks['entries'])
callbacks['additionalEntryCount']=len(entries)-before
callbacks['mergedEntryCount']=len(entries)
(crate/'card-callback-entry-provenance.json').write_text(json.dumps(callbacks,indent=2)+'\n')
print(json.dumps(dict(verifiedCardCallbacks=len(callbacks['entries']),additionalEntries=len(entries)-before,mergedEntries=len(entries))))
(crate/'runtime-entries-combined.txt').write_text(''.join(f'{entry:08x}\n' for entry in sorted(entries)))
if not (crate/'Cargo.toml').exists():
 (crate/'Cargo.toml').write_text('''[package]
name="joey-original"
version="0.1.0"
edition="2024"
[lib]
crate-type=["lib","cdylib"]
[dependencies]
runtime={workspace=true}
winapi={workspace=true}
host={workspace=true}
[target.'cfg(target_family = "wasm")'.dependencies]
wasm-bindgen={workspace=true}
''')
 (crate/'src/lib.rs').write_text('// Bootstrap only; replaced after original translation.\n')
PY
cargo build --locked --manifest-path "$repo/Cargo.toml" -p tc
"$repo/target/debug/tc" --exe "$exe_file" --out "$repo/out/joey_cn" --entry-points-file "$repo/out/joey_cn/runtime-entries-combined.txt"
python3 "$script_dir/prepare_translated.py" "$repo" "$audit"
