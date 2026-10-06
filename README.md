# Joey Browser · v0.1.0

《游戏王：混沌力量 城之内篇》的原版浏览器兼容运行环境。原程序转换为 WebAssembly，在浏览器中执行原有界面、决斗逻辑和 AI；服务器提供登录和游戏资源字节。

这是我们第一个版本，对应已部署版本 `20261005-234225-b8043abd`。用户在 iPhone Safari 上反馈目前已比较流畅。

## 当前功能

- 原程序绘图、鼠标/触屏输入及常用按键，800×600 原画面按屏幕缩放。
- 浏览器本地 WebAssembly 运行、后台线程、共享内存和 PCM 音频输出。
- 原资源按需读取；默认先准备常用资源，首次压缩传输约50MB。
- 完整资源安装可选，原始档案478,398,969字节。
- 资源及程序持久缓存、下载断点保存、短暂断网自动重试。
- 刷新后复用已保存的部分，显示“已恢复本机缓存”。
- 浏览器存档独立保存，资源缓存恢复不会清除玩家文件。

## 获取与构建

本仓库保存运行环境源码、Theseus兼容补丁和构建说明。游戏安装文件、图片/音频档案、转换后的游戏程序及玩家存档由使用者自行准备，不打包到GitHub。

- [构建说明](docs/BUILD.md)
- [运行与部署](docs/DEPLOY.md)
- [首版验证记录](docs/VERIFICATION.md)
- [版本说明](releases/v0.1.0.md)
- [第三方来源与许可](THIRD_PARTY_NOTICES.md)
- [固定输入及参考构建哈希](version.json)

## 开发检查

Node.js22及以上、Python3。仅运行环境源码检查不需要原游戏文件：

```sh
npm ci
npm test
```

使用自己的原游戏文件完成构建后，可运行完整浏览器检查：

```sh
npx playwright install --with-deps chromium webkit
npm run test:downloads
npm run test:startup
npm run test:game
```

测试使用独立浏览器上下文和它自己新建的存档。`JOEY_CHROMIUM_PATH`可指定现有Chromium可执行文件；默认使用Playwright安装的浏览器。

## 适用范围

手机访问需要HTTPS和跨源隔离，浏览器需要支持WebAssembly共享内存与AudioWorklet。现代Safari/Chromium使用同一套实现；程序分段缓存使用原生DecompressionStream。浏览器存储不可用时可以联网读取，但跨刷新断点需保留网站数据。旧浏览器缺少原生解压接口时程序仍走原来的整文件下载兼容路径。

已经验证启动、原对话、猜拳、首张卡牌流程、声音与自有存档保存/重开。完整玩家胜利、奖励、全部卡牌效果、重放命名和文字输入仍需继续验证；本次首版不代表所有流程和所有设备都已通过验收。

## 上游

静态转换器和基础DOS/Win32兼容实现来自[evmar/theseus](https://github.com/evmar/theseus)，固定提交`0fe848f1905a651d843668400f0ad46ed4e212c0`。本仓库提供针对当前游戏的兼容补丁、网页运行层和验证工具。
