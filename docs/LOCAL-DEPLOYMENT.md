# Local complete deployment

完整部署包包含原版 EXE、完整资源字节、预编译程序、网页运行层及两档资源包，安装无需 Rust 编译或 npm 依赖。原档案采用 v2 无损包保存，安装后还原为原始 DAT，并逐块、逐档案校验 SHA-256。

MIT 只授权本项目自有代码和文档；原游戏和第三方组件保留各自权利，见 [游戏内容声明](../GAME-CONTENT-NOTICE.md)。完整游戏字节作为 Release 附件提供，Git 源码仍保持独立。

## 下载现成部署包

从 [v0.2.1 Release](https://github.com/Junming-Liang/joey-browser/releases/tag/v0.2.1) 下载 `joey-browser-v0.2.1-complete.tar.gz` 和同名 `.sha256` 文件，随后执行下方安装步骤。

```sh
sha256sum -c joey-browser-v0.2.1-complete.tar.gz.sha256
tar -xzf joey-browser-v0.2.1-complete.tar.gz
cd joey-browser-v0.2.1-local
node site/setup-deployment.mjs --origin https://game.example.com
JOEY_ORIGINAL_CONFIG="$PWD/config.local.json" \
  node --max-old-space-size=64 site/server.mjs
```

这条路径无需另找游戏文件或准备编译工具链。手机公网访问仍需配置 HTTPS 代理。

## 生成部署包

在完成 [BUILD.md](BUILD.md) 并准备有权使用的原游戏输入后运行：

```sh
python3 scripts/package-deployment.py --output .bridge/joey-browser-v0.2.1-local.tar.gz
```

可通过 `--program-root`、`--input-root`、`--light-pack-root`、`--original-pack-root` 指定现有产物。打包前核对固定输入、程序、网页文件、资源包和索引，不读取服务器私有配置或浏览器存档。原档案与普通 WASM 不重复保存，安装时从无损包及程序 gzip 还原。包与同名 `.sha256` 存在时拒绝覆盖。

## 自建包的安装和运行

目标 Linux 机器仅需 Node.js 22 及以上、tar 和 sha256sum。先核对文件，再解包到一个新的目录：

```sh
sha256sum -c joey-browser-v0.2.1-local.tar.gz.sha256
tar -xzf joey-browser-v0.2.1-local.tar.gz
cd joey-browser-v0.2.1-local
node site/setup-deployment.mjs --origin https://game.example.com
JOEY_ORIGINAL_CONFIG="$PWD/config.local.json" \
  node --max-old-space-size=64 site/server.mjs
```

本机测试可以不传 `--origin`，默认使用 `http://127.0.0.1:18891`。`--port` 可更改回环端口；公网由 HTTPS 反向代理转发，页面路径为 `/joey/original/`。代理和响应头见 [DEPLOY.md](DEPLOY.md)。安装器生成专用配置；已存在的配置或校验不符的文件会保留并报错。

此包用于新建独立服务；更新已有服务仍按 [DEPLOY.md](DEPLOY.md) 的升级与回滚流程操作，保留被旧浏览器缓存引用的历史资源包。

完整部署包存放的是服务器运行内容，不等于手机的资源安装下载。手机仍默认按需读取，完整轻量安装和原画原声的下载范围保持原样。
