# 第三方来源与许可说明

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

原游戏程序、卡牌图像、音乐、语音和商标属于各自权利人。本仓库不附带原游戏EXE、DAT资源档案、转换后的原游戏程序或游戏资源下载器。构建所需文件由使用者自行提供，输入版本用version.json中的SHA256严格核对。

## Playwright

浏览器检查使用Microsoft Playwright，固定版本1.63.0，按其Apache-2.0许可通过npm安装。不将其浏览器或node_modules加入Git版本库。

本仓库未对所有内容统一附加新的开源许可证；第三方内容保留其来源和适用许可。
