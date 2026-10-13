# Deployment

当前服务只提供浏览器运行所需的程序与资源，绑定 `127.0.0.1`，公网路径固定为 `/joey/original/`。完成 [构建](BUILD.md) 后，由反向代理提供 HTTPS。

## 资源目录

先将生成的资源包放到同一个父目录中的哈希目录：

```text
.bridge/joey-web/reverse/output/installed-packs/
├── 5554c09969b2bc03233198843b977174f4b3468cae19cb6c9f3d0b0da10275dc/
│   └── resources.gzip.pack                 # 当前轻量包
├── 722216f76a656d878246f6cd4337fde2f9f37895670e54e3a02639c35d6e6ef9/
│   └── resources.gzip.pack                 # 必需的原画原声包
└── 42d626a804979565e5dabe976975c8f5db88b0c4314b9811e44ba4eec2091f49/
    └── resources.gzip.pack                 # 历史 gzip 包，有旧用户时保留
```

文件名因历史接口保持 `resources.gzip.pack`，当前两档包实际按块选择 Brotli 或 gzip。可以复制构建输出，或在本机测试使用指向相应目录的符号链接；固定发布脚本会拒绝资源包自身的符号链接。

## 本机运行

在仓库根目录创建只属于当前部署的配置。以下示例拒绝覆盖已有配置：

```sh
node --input-type=module - <<'JS'
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const config={
  origin:'http://127.0.0.1:18891',
  port:18891,
  filesRoot:resolve('.bridge/joey-web/reverse/output/original-preview'),
  resourcesRoot:resolve('.bridge/joey-web/reverse/input'),
  packedResourcesRoot:resolve('.bridge/joey-web/reverse/output/installed-packs/5554c09969b2bc03233198843b977174f4b3468cae19cb6c9f3d0b0da10275dc')
};
writeFileSync('config.local.json',JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
JS
JOEY_ORIGINAL_CONFIG="$PWD/config.local.json" \
  node --max-old-space-size=64 .bridge/joey-web/reverse/output/original-preview/server.mjs
```

本机回环地址用于开发；手机公网访问需将 `origin` 改为自己的 HTTPS 地址，并配置代理。当前原版入口无需内置密码；需要额外访问控制时请在代理层设置。配置文件不提交到仓库。

`resourcesRoot` 提供原始 `data.dat`、`Voice.dat`、`Region.dat`。按需／common 模式使用这些源文件；已完成轻量安装只从独立的压缩缓存恢复派生字节，不能将轻量档案覆盖到原始目录。

## HTTPS 与反向代理

参考 [nginx-location.conf.example](../deploy/nginx-location.conf.example)，保留其他业务路由。服务返回 COOP／COEP／CORP；代理必须保留这些头和 `Range`、`Content-Range`、`X-Original-Range`。

程序分段接口和压缩资源包接口返回**压缩文件自身的字节偏移**。这些接口不能额外添加 `Content-Encoding`，否则浏览器自动解压会破坏续传。已有响应压缩与长度也不能在代理中重新编码。

长期运行可参考 [joey-original.service.example](../deploy/joey-original.service.example)，使用独立用户、回环端口和资源限制。示例目录与账号由部署者按实际环境配置。

## 已有服务器的受控发布工具

`deploy_preview.py` 和 `update_preview.py` 是当前项目部署布局的固定工具：

- `/opt/joey-web/`，独立 `joey-original.service`，回环端口 `18891`。
- 原始资源在 `/var/lib/joey-web/game/`，使用既有 `joeyweb` 用户。
- 首次部署要求已有 `/etc/joey-web/config.json`、共享 Nginx include 和相关服务。
- 工具通过 `wrist-relay.service` 获取其 PID／启动时间，校验发布前后既有业务没有变化。

因此这些工具只适用于该既有布局，新的自托管环境应按前面的配置和服务示例建立。不要直接在不匹配的主机上运行固定发布脚本。

在该布局下，两档主资源分别保存在 `/opt/joey-web/original-resource-packs/<SHA>/resources.gzip.pack`；原画 v2 必须预先存在且通过校验。当前轻量包使用专用暂存路径：

```text
/opt/joey-web/original-resource-packs/.incoming-resources.gzip.pack
```

将两个 Python 文件和构建归档放在同一目录，然后运行：

```sh
python3 update_preview.py /path/to/code-preview.tgz CODE_ARCHIVE_SHA256 \
  --resource-pack /opt/joey-web/original-resource-packs/.incoming-resources.gzip.pack
```

首次追加原版入口使用 `deploy_preview.py`。工具严格检查代码成员、程序、两个旧索引、解码器、源档案和包的固定哈希；代码包 SHA 可以从构建报告取得。已安装且校验通过的轻量包可省略 `--resource-pack`。

## 升级与回滚

升级仅切换独立原版服务；v2、v1 保留原文件与 URL。部署失败时恢复旧配置及 service 内容。回滚代码时也要保留被旧代码引用的包目录与旧 release。

浏览器玩家存档属于当前站点的独立数据库，与服务器资源目录不同。不要通过清除网站数据处理普通缓存升级；这样会同时影响当前浏览器存档。
