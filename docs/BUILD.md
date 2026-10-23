# Build

本版本固定输入与参考产物见 [version.json](../version.json)。完整构建需要自行准备原游戏文件；源码检查 `npm test` 不需要这些文件。

## 环境

| 用途 | 环境 |
| --- | --- |
| 源码、离线检查 | Node.js ≥ 22、Python 3 |
| 当前资源包参考编码 | Node.js 24.16.0，Brotli 1.2.0 |
| 程序转换与 WASM | Linux x86_64、Rust nightly-2026-10-04、wasm-bindgen 0.2.121 |
| 浏览器验证 | package-lock.json 固定的 Playwright 与 Chromium／WebKit |

Rust 编译器 commit 必须为 `db8f076d2619ce2585b0380dda06e8da25a40da4`；它的 commit-date 是 2026-10-03，与 nightly 名称的日期不同。脚本会检查编译器身份。资源包哈希会随编码器版本变化，应使用参考环境并保留生成报告。

## 1. 提供原始输入

```text
.bridge/joey-web/reverse/input/
├── joey_pc_cn.exe
├── data.dat
├── Voice.dat
└── Region.dat
```

各文件名称、大小和 SHA-256 见 `version.json`。不同 EXE 的转换地址及布局需要重新分析；不能混用本版本入口。

## 2. 获取固定 Theseus 并应用补丁

```sh
mkdir -p .bridge/joey-web/research .bridge/joey-web/reverse/output
git clone https://github.com/evmar/theseus.git .bridge/joey-web/research/theseus
git -C .bridge/joey-web/research/theseus checkout 0fe848f1905a651d843668400f0ad46ed4e212c0
git -C .bridge/joey-web/research/theseus apply --check "$PWD/games/joey/reverse/theseus-joey.patch"
git -C .bridge/joey-web/research/theseus apply "$PWD/games/joey/reverse/theseus-joey.patch"
```

补丁包含兼容代码、代码页／键盘数据和声明来源的字形数据。请使用干净的固定提交，不要覆盖另一个工作目录的改动。

## 3. 准备工具链并转换程序

需要 rustup、C/C++ 构建工具和 pkg-config。脚本使用隔离目录：

```sh
export CARGO_HOME="$PWD/.bridge/joey-web/research/rust/cargo"
export RUSTUP_HOME="$PWD/.bridge/joey-web/research/rust/rustup"
rustup toolchain install nightly-2026-10-04 --component rust-src --target wasm32-unknown-unknown
rustup default nightly-2026-10-04
```

将官方 wasm-bindgen 0.2.121 的 Linux x86_64 musl 可执行文件放到：

```text
.bridge/joey-web/research/wasm-tools/wasm-bindgen-0.2.121-x86_64-unknown-linux-musl/wasm-bindgen
```

随后执行：

```sh
bash games/joey/reverse/translate_original.sh \
  .bridge/joey-web/research/theseus \
  .bridge/joey-web/reverse/input/joey_pc_cn.exe \
  build-inputs/translator-blocks.txt \
  build-inputs/theseus-import-audit.json

JOEY_WASM_PROFILE=fast bash games/joey/reverse/build_original_wasm.sh \
  .bridge/joey-web/research/theseus

cp .bridge/joey-web/research/theseus/out/joey_cn/card-callback-entry-provenance.json \
  .bridge/joey-web/reverse/output/card-callback-entry-provenance.json
```

v0.3.0 已重新构建收藏卡、字幕和联机运行时。产物大小与固定 SHA 见 `version.json`；重建不匹配时应核实工具链与输入。

## 4. 生成三个资源包

这些步骤在本机读取原档案并生成额外构建输出，不会编辑原文件。资源实验依赖前一个步骤的元数据；完整编码需要时间。

```sh
node games/joey/reverse/benchmark_resource_compression.mjs
node games/joey/reverse/benchmark_filtered_compression.mjs
node games/joey/reverse/benchmark_audio_byte_planes.mjs
python3 games/joey/reverse/prepare_compression_geometry.py
node games/joey/reverse/benchmark_structured_compression.mjs --build-pack
node games/joey/reverse/build_brotli_pack.mjs
python3 games/joey/reverse/prepare_light_resources.py
node games/joey/reverse/build_brotli_pack.mjs --light
```

输出：

```text
.bridge/joey-web/reverse/output/
├── resource-compression/structured-pack/          # v1 历史 gzip 包
└── compression-20261013/
    ├── brotli-pack/                              # v2 原画原声
    ├── light-resources/                          # 独立的派生档案及来源报告
    └── light-pack/                              # v3 轻量包
```

浏览器检查使用 `light-pack` 作为主包目录，其同级目录需要两个哈希别名，便于网关同时读取原画与历史包。首次准备可执行：

```sh
node --input-type=module - <<'JS'
import {readFileSync,existsSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
const metadata=JSON.parse(readFileSync('version.json'));
const base=resolve('.bridge/joey-web/reverse/output/compression-20261013');
for(const [index,descriptor] of metadata.legacyPackedResources.entries()){
  const target=resolve(base,descriptor.pack.sha256);
  if(!existsSync(target))symlinkSync(index===0?'brotli-pack':'../resource-compression/structured-pack',target,'dir');
}
JS
```

部署目录的准备另见 [DEPLOY.md](DEPLOY.md)。

保留 v1 用于已有旧缓存和未完成安装的续传。当前服务始终需要 v2 原画包；v3 是默认的新完整安装包。v1 和 v2 的历史索引按原字节保留在源码里，不能重排或重新序列化。

仓库随附已声明许可和 SHA 的 Brotli 解码器。需要重建该第三方文件时，将官方 `brotli-dec-wasm@2.3.2` 发布包保存为：

```text
.bridge/joey-web/reverse/output/compression-20261013/vendor/brotli-dec-wasm-2.3.2.tgz
```

再执行 `python3 games/joey/reverse/prepare_brotli_decoder.py`。该步骤检查发布包 SHA，并解析 WASM 内存段，将解码器线性内存上限设为 32 MiB；它不修改游戏 WASM。

## 5. 生成收藏卡与字幕

仓库附带五张卡的插画、原尺寸 BMP、卡文与校对后的双语台词。修改插画或说明时，可重新运行 `node games/joey/reverse/render_custom_cards.mjs`；需要 Playwright Chromium、Fontconfig、Arial 与 Times New Roman。卡框从固定 data.dat 读取。

```sh
python3 games/joey/reverse/prepare_custom_resources.py
python3 games/joey/reverse/prepare_subtitles.py --voice-dat .bridge/joey-web/reverse/input/Voice.dat --catalog-output games/joey/original/subtitle-catalog.mjs --rust-output .bridge/joey-web/research/theseus/win32/winapi/src/voice_catalog.rs --transcripts games/joey/custom/joey-subtitles.json
```

增量默认生成到 `.bridge/joey-web/reverse/output/custom-resources`。改变 Rust 声音索引后需重新编译 WASM。

## 6. 打包网页运行层

```sh
npm run build:preview
```

输出网页目录、`revision.json`、gzip 程序和代码部署归档。原始档案和三个资源包不进入代码归档，部署时分别提供。

默认固定 SHA 是已接受构建的边界。要支持其他版本或编码环境，需更新来源报告、验证字节／文件偏移、浏览器行为及部署器，不应直接替换常量绕过校验。
