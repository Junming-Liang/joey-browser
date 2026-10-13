# Contributing

欢迎提交可复现的问题、文档改进、兼容性补丁和性能分析。当前工作重点是原版程序的完整流程、移动浏览器稳定性和资源读取。

## 开发环境

```sh
npm ci
npm test
```

源码检查使用 Node.js 22 及以上和 Python 3，无需原游戏资源。完整程序与资源包构建使用 [BUILD.md](docs/BUILD.md) 中的固定工具链。

浏览器检查由 Playwright 执行。先准备合法取得且版本匹配的游戏输入和构建输出，再安装检查所需的浏览器：

```sh
npx playwright install --with-deps chromium webkit
npm run test:quality
npm run test:install
```

`JOEY_CHROMIUM_PATH` 可以指定已有 Chromium。测试只能使用专用存档和浏览器上下文；修改持久化数据时请先阅读 `player-files.mjs` 的独占写锁和备份约定。

## 报告问题

请在 [Issues](https://github.com/Junming-Liang/joey-browser/issues) 提供：

- 页面版本、浏览器版本、操作系统以及触发步骤。
- 预期结果和实际结果；卡片、卡组或菜单名称。
- “复制运行信息”得到的相关状态、错误与堆栈。
- 下载问题的网络类型、缓存状态及是否可重复。

报告前请移除令牌、服务器配置、私人存档和个人信息。安全问题请参阅 [SECURITY.md](SECURITY.md)。

## 提交 Pull Request

1. 从当前 `main` 建立工作分支，让每个 PR 对应一个具体问题。
2. 在领域逻辑的负责模块修改，保持原版文件偏移、输入顺序、缓存身份和存档隔离。
3. 运行 `npm test`，补充与行为变化直接相关的检查。
4. 描述触发条件、修复后的行为、验证命令与未验证范围。
5. 新增第三方代码时保留来源、版本、完整许可文本及必要的哈希。

原游戏 EXE/DAT、生成后的游戏 WASM、资源包、浏览器配置目录和账号凭据不能加入提交。仓库仅允许已声明并校验的第三方 Brotli 解码器 WASM。

性能数据应注明版本、场景、缓存冷热、浏览器和采样范围。同一场景和配置才可以比较；桌面触控模拟结果应明确标注，不能代表所有实体手机。

## 许可

本项目自有代码与文档采用 [MIT License](LICENSE)。提交贡献时，请确保你有权以此许可提供新增代码；第三方内容仍须附上原许可与来源，边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。不要为未确认许可的上游代码添加统一许可证，也不要提交未取得分发权的素材。
