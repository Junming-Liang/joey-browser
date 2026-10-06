#!/usr/bin/env bash
# Diagnostic build only. Unsupported imports fail explicitly at runtime.
set -euo pipefail
repo=${1:?path to isolated Theseus checkout}
repo=$(cd "$repo" && pwd)
task_tools=$(dirname "$repo")
export CARGO_HOME="$task_tools/rust/cargo"
export RUSTUP_HOME="$task_tools/rust/rustup"
export PATH="$CARGO_HOME/bin:$PATH"
export CARGO_BUILD_JOBS=4
export CARGO_PROFILE_DEV_DEBUG=0
profile=${JOEY_WASM_PROFILE:-dev}
case "$profile" in dev|fast|release) ;; *) printf 'Unsupported build profile\n' >&2; exit 2;; esac
export CARGO_PROFILE_FAST_DEBUG=0
export CARGO_PROFILE_RELEASE_DEBUG=0
export RUSTFLAGS='-Ctarget-feature=+atomics,+bulk-memory -Clink-arg=--shared-memory -Clink-arg=--max-memory=1073741824 -Clink-arg=--import-memory -Clink-arg=--export=__heap_base -Clink-arg=--export=__wasm_init_tls -Clink-arg=--export=__tls_size -Clink-arg=--export=__tls_align -Clink-arg=--export=__tls_base'
cd "$repo"
build_arguments=(--locked --lib -Z build-std=std,panic_abort --target wasm32-unknown-unknown -p joey-original)
artifact_directory=debug
binding_directory="$task_tools/original-wasm"
if [[ "$profile" != dev ]]; then
  build_arguments+=(--profile "$profile")
  artifact_directory=$profile
  binding_directory="$task_tools/original-wasm-$profile"
fi
cargo build "${build_arguments[@]}"
"$task_tools/wasm-tools/wasm-bindgen-0.2.121-x86_64-unknown-linux-musl/wasm-bindgen" \
  --out-dir "$binding_directory" --typescript --target web --reference-types \
  "target/wasm32-unknown-unknown/$artifact_directory/joey_original.wasm"
