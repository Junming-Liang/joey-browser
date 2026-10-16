# 第三方来源与许可说明

本项目自有代码与文档采用 [MIT License](LICENSE)。第三方代码、补丁中的上游上下文、字形数据、卡组配方及原游戏内容保留各自的版权和许可；根目录 MIT 许可只适用于本项目有权授权的内容。

## Theseus

来源：<https://github.com/evmar/theseus>

作者/维护者：evmar。固定提交：`0fe848f1905a651d843668400f0ad46ed4e212c0`。

Theseus提供DOS/Windows32位程序到Rust的静态转换和部分API兼容实现。本仓库保留来源和固定提交，发布本项目的兼容补丁；不把上游完整仓库重新打包。该固定提交根目录未包含LICENSE文件，因此本项目不自行宣称上游代码采用MIT或其他许可证。

## WenQuanYi Micro Hei字形数据

兼容补丁中的字形数据来自实际安装的文泉驿微米黑，在隔离Wine6.0.3环境按原程序已观察到的12种字体参数捕获，使用无损打包。字体实际版权文件提供双许可选择；本版本采用Apache-2.0选项。

- [实际字体版权说明](games/joey/reverse/font-atlas-copyright.txt)
- [Apache-2.0完整文本](games/joey/reverse/font-atlas-Apache-2.0.txt)
- 固定打包字形SHA256：`46c4254841927f04888cf3dce97b3e1baa639bdf7b55cdb57d53b229c6d4bc64`。

## 原游戏

原游戏程序、卡牌图像、音乐、语音和商标属于各自权利人，原游戏内容不适用本项目的 MIT 许可。Git 源码不包含原游戏 EXE、DAT 或转换后的游戏程序；完整部署包采用 Release 附件的独立分发形式，可用附件以各发布版本列表为准。完整包包含原版 EXE、以无损包保存的完整资源及预编译浏览器程序。输入版本用 version.json 中的 SHA-256 严格核对。

维护者确认的附件发布授权及边界见 [GAME-CONTENT-NOTICE.md](GAME-CONTENT-NOTICE.md)。

文档截图展示原游戏界面，图中的图像与商标保留原权利人的权利，不适用本项目的 MIT 许可。截图来自独立测试配置，来源与校验值见 [docs/images/README.md](docs/images/README.md)。

## Playwright

浏览器检查使用Microsoft Playwright，固定版本1.63.0，按其Apache-2.0许可通过npm安装。不将其浏览器或node_modules加入Git版本库。

## brotli-dec-wasm

来源：<https://github.com/ustclug-dev/brotli-dec-wasm>，固定 npm 版本 2.3.2。

采用上游提供的 MIT／Apache-2.0 许可。随附整数解码器 ESM、WASM、完整许可和修改说明：

- [brotli-decoder-NOTICE.txt](games/joey/reverse/brotli-decoder-NOTICE.txt)
- [来源与校验值](games/joey/reverse/brotli-decoder-provenance.json)

WASM 内存段增加 32 MiB 线性内存上限；ESM 保持上游内容。该第三方 WASM 只解压资源，与原游戏转换后的程序不同；后者不随源码发布。

## 预设卡组

目录包含原版兼容主题配置、经当前卡池校验的玩家经典配置和经典攻略配方。来源 URL、配方或 SHA 保留在 `collection-catalog.mjs`、`classic-burn-decks.json` 中。初始 profile 来自专用原程序测试生成的合成存档，不含真实玩家进度。原游戏内容仍属于各自权利人，不为第三方配置指定新的统一许可证。

第三方内容的分发须遵循对应声明，不因本项目采用 MIT 而改变。
