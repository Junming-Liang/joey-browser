# 运行与部署

服务使用Node.js22及以上，仅绑定127.0.0.1。手机访问由现有反向代理提供HTTPS；游戏路径固定为/joey/original/。

## 配置

构建完成后，在仓库根目录创建config.local.json。JOEY_GAME_PASSWORD应在本地终端安全输入，下面的命令只输出配置文件名，不输出密码：

```sh
read -s -r -p '游戏密码: ' JOEY_GAME_PASSWORD
export JOEY_GAME_PASSWORD
node --input-type=module - <<'JS'
import {randomBytes,scryptSync} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const password=process.env.JOEY_GAME_PASSWORD;
if(!password)throw Error('需要本地设置游戏密码');
const salt=randomBytes(16).toString('hex');
const config={origin:'https://game.example.com',passwordSalt:salt,passwordHash:scryptSync(password,salt,32).toString('hex'),port:18891,filesRoot:resolve('.bridge/joey-web/reverse/output/original-preview'),resourcesRoot:resolve('.bridge/joey-web/reverse/input')};
writeFileSync('config.local.json',JSON.stringify(config,null,2),{mode:0o600,flag:'wx'});
console.log('已生成config.local.json，请将origin改为自己的HTTPS地址');
JS
unset JOEY_GAME_PASSWORD
```

已有配置文件时命令会拒绝覆盖。配置及密码不加入Git；原资源目录仅需包含当前固定版本的data.dat、Voice.dat和Region.dat。

## 启动

```sh
JOEY_ORIGINAL_CONFIG="$PWD/config.local.json" \
  node --max-old-space-size=64 .bridge/joey-web/reverse/output/original-preview/server.mjs
```

通过现有nginx添加deploy/nginx-location.conf.example中的location即可。保留其他location、服务端口和存档；示例不修改现有服务。长期运行可按deploy/joey-original.service.example创建独立systemd服务，并使用没有写游戏资源权限的专用系统用户。

服务响应包含COOP/COEP隔离头。反向代理应保留Range、Content-Range和X-Original-Range，不重写响应压缩与长度。程序分段接口返回gzip文件的原始压缩字节，不能额外标记Content-Encoding:gzip，否则客户端会提前解压而破坏断点偏移。

首次启动默认约50MB压缩下载。“完整资源”选项会准备全部原档案；不勾选时其他素材随原程序读取按需缓存。下载中断后保留网站数据并重新打开、点击启动，即可恢复已保存的部分。
