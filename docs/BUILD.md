# 构建首版

本版本固定Linux x86_64构建环境：Theseus提交`0fe848f1905a651d843668400f0ad46ed4e212c0`、Rust nightly-2026-10-04、wasm-bindgen0.2.121、fast配置（opt-level2、关闭调试信息）、4个Cargo构建任务。

## 1. 准备原文件

自行提供version.json中固定SHA256的4个文件，放入：

```text
.bridge/joey-web/reverse/input/joey_pc_cn.exe
.bridge/joey-web/reverse/input/data.dat
.bridge/joey-web/reverse/input/Voice.dat
.bridge/joey-web/reverse/input/Region.dat
```

文件不会加入Git。不同EXE版本不可以直接复用本版的分析入口和补丁，需要重新分析。build-inputs/translator-blocks.txt是当前已分析的基本块地址清单；theseus-import-audit.json是静态导入名称清单，不表示所有API行为已经实现。

## 2. 获取固定上游并应用补丁

在仓库根目录执行：

```sh
mkdir -p .bridge/joey-web/research
mkdir -p .bridge/joey-web/reverse/output
git clone https://github.com/evmar/theseus.git .bridge/joey-web/research/theseus
git -C .bridge/joey-web/research/theseus checkout 0fe848f1905a651d843668400f0ad46ed4e212c0
git -C .bridge/joey-web/research/theseus apply --check "$PWD/games/joey/reverse/theseus-joey.patch"
git -C .bridge/joey-web/research/theseus apply "$PWD/games/joey/reverse/theseus-joey.patch"
```

补丁包含本项目的Win32兼容改动、代码页/键盘数据和Apache-2.0字形数据，不包含原游戏生成代码。不要在有其他改动的上游工作目录中强行应用补丁。

## 3. 准备固定工具链

需要已经安装rustup，以及C/C++编译工具和pkg-config。构建脚本使用本仓库的隔离工具目录：

```sh
export CARGO_HOME="$PWD/.bridge/joey-web/research/rust/cargo"
export RUSTUP_HOME="$PWD/.bridge/joey-web/research/rust/rustup"
rustup toolchain install nightly-2026-10-04 --component rust-src --target wasm32-unknown-unknown
rustup default nightly-2026-10-04
```

将官方wasm-bindgen0.2.121的Linux x86_64 musl构建放到：

```text
.bridge/joey-web/research/wasm-tools/wasm-bindgen-0.2.121-x86_64-unknown-linux-musl/wasm-bindgen
```

## 4. 转换原程序并构建

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

npm run build:preview
```

输出位于.bridge/joey-web/reverse/output/original-preview/。build_preview.py会核验原档案、原程序参考SHA256和字形来源，生成资源目录、gzip程序、版本元数据和部署包。

v0.1.0参考WASM为83,780,104字节，SHA256：

```text
d7c17b7b888208181cf6235eac1cc07e9c6a013cf59d84aa889d3d20652c46bc
```

gzip程序为16,084,277字节。参考哈希保存在version.json。源码快照未重新执行一遍完整Rust转换/编译；如构建不匹配，应核实工具链与生成输入，禁止静默替换参考哈希后当作已验证的首版。
