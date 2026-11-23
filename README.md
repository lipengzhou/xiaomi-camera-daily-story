# 米家摄像头每日故事自动同步

> 非官方项目，与小米、米家、飞牛 fnOS 无隶属关系。相关商标归各自权利人所有。

面向飞牛 fnOS 的米家摄像头每日故事归档工具。通过 Web 后台完成小米账号扫码授权、跨家庭选择摄像头、每日故事查询、HLS 下载、FFmpeg 封面合成和按月归档。

当前已在 x86_64 fnOS 上验证安装、原地升级、授权目录挂载和真实视频同步；ARM64 真机与外部 HTTPS 完整证书链仍待验证。

## 功能

- 小米账号二维码登录，凭证 AES-256-GCM 加密保存。
- 多家庭、多摄像头配置和批量同步。
- 每日故事 HLS 下载，视频开头加入 2 秒静帧封面。
- 按 `<家庭>/<摄像头>/YYYY/MM/XIAOMI_CAMRA4_YYYYMMDD.mp4` 归档。
- 已存在且非空的视频跳过；绝不自动删除已有视频。
- 手动同步、每日定时同步、同步互斥。
- 支持应用共享目录和 fnOS 应用设置中授权的多个目录。
- fnOS FPK 安装，Docker 容器运行，通过统一网关访问。

## 环境要求

- Node.js 20.11 或更高版本，npm。
- Mac 本地完整同步：FFmpeg、ffprobe、`SetFile`。
- Docker Desktop（构建镜像）。
- 飞牛官方 `fnpack`（构建 FPK）。
- fnOS 管理员账号。

## 快速开始

### Mac 本地开发

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:3210`。默认只监听回环地址，不要改成 `0.0.0.0`。

修改端口：

```bash
PORT=4321 npm run dev
```

非 production 环境默认使用 `local` 运行时；production 必须显式设置：

```bash
XIAOMI_STORY_RUNTIME=fnos
```

### fnOS 安装

1. 构建并预载镜像：

   ```bash
   docker buildx build \
     --platform linux/amd64 \
     --target runtime \
     --tag xiaomi-camera-daily-story:0.1.7 \
     --load .

   docker save \
     -o xiaomi-camera-daily-story-0.1.7-amd64.tar \
     xiaomi-camera-daily-story:0.1.7
   ```

2. 在 NAS 上加载镜像，并确认 tag 完全一致：

   ```bash
   docker load -i xiaomi-camera-daily-story-0.1.7-amd64.tar
   docker image inspect xiaomi-camera-daily-story:0.1.7
   ```

3. 构建 FPK：

   ```bash
   npm run fpk:build
   ```

4. 通过应用中心 Web UI 的“手动安装”安装 FPK。

升级同样使用应用中心 Web UI 原地安装新 FPK。不要在有真实凭证或配置的安装上使用 `appcenter-cli install-local`，它可能执行卸载重装并清空应用私有目录。

## 使用

1. 点击“生成登录二维码”，用手机扫码并确认小米账号授权。
2. 读取设备，选择家庭和摄像头，点击“添加摄像头”；可以切换多个家庭继续添加。
3. 选择视频归档目录：
   - 默认“应用文件/xiaomi-camera-daily-story/videos”；
   - 或 fnOS 应用设置中授权的任一读写目录。
4. 按需启用每日定时同步并保存配置。
5. 点击“立即同步缺失视频”。

修改 fnOS 应用访问权限后，授权目录会作为独立选项出现；应用会自动重建容器并刷新下拉项。若仍显示“未授权”，检查应用是否运行以及应用日志。

## 存储与文件规则

- 目标路径：`<归档目录>/<家庭名称>/<摄像头名称>/YYYY/MM/XIAOMI_CAMRA4_YYYYMMDD.mp4`。
- 家庭名和摄像头名中的路径分隔符、控制字符及跨平台非法字符替换为 `_`。
- 不同摄像头清洗后的路径如果完全相同，保存配置会被拒绝，避免互相覆盖。
- 0 字节目标文件不视为完成。
- HLS 先写入同目录隐藏 `.source.mp4`，用于截取第 2 秒画面。
- 最终视频开头为 2 秒静帧封面，封面期间静音，原音频延后 2 秒。
- 最终视频使用 H.264 CRF 18、30 fps、AAC 128 kbps。
- 合成结果先写入隐藏 `.partial.mp4`，校验通过后才生成最终文件。
- MP4 容器、视频轨和音频轨时间写为故事日期 `23:59:59 +08:00`。
- 成功或失败后清理本次临时文件；不删除已有非空视频。

故事日期规则：

```text
故事日期 = createTime 在 Asia/Shanghai 的自然日 - 1 天
```

主要米家接口：

- 每日故事列表：`GET https://business.smartcamera.api.io.mi.com/miot/camera/app/v1/dailyStory/playlist`
- 故事 HLS 清单：`GET https://business.smartcamera.api.io.mi.com/miot/camera/app/v1/dailyStory/m3u8`
- HLS 密钥与分片：`https://app.processor.smartcamera.api.io.mi.com/miot/camera/app/play/v1/...`

请求使用米家 RC4-Drop1024、nonce、signed nonce 和双阶段 SHA-1 签名。

## 数据与凭证

Mac 本地开发：

- 配置和历史：`~/Library/Application Support/XiaomiCameraDailyStory/`
- 主密钥：`~/Library/Application Support/XiaomiCameraDailyStory/credential.key`
- 加密凭证：`~/Library/Application Support/XiaomiCameraDailyStory/credentials.enc`

fnOS 容器：

| 用途 | 容器路径 | fnOS 来源 |
|---|---|---|
| 主密钥和安装配置 | `/config` | `TRIM_PKGETC` |
| 配置、历史和加密凭证 | `/data` | `TRIM_PKGVAR` |
| 应用共享视频目录 | `/videos` | `data-share` |
| 可选授权目录 | `/authorized-videos-<路径哈希>` | `TRIM_DATA_ACCESSIBLE_PATHS` 的每一项 |
| 网关 Socket | `/app/target/app.sock` | `TRIM_APPDEST` |

凭证不会进入镜像、Git、API、日志或视频目录。应用只连接小米接口和安装时配置的镜像仓库，不上传账号、摄像头、历史或视频到开发者服务器。

## fnOS 运行方式

- FPK 由应用中心管理，容器以 fnOS 应用用户运行。
- 容器根文件系统只读，删除全部不需要的 capabilities，不使用 privileged、host network 或 Docker socket。
- Web 页面和 API 只通过 `/app/xiaomi-camera-daily-story` 的统一网关访问，仅管理员可用。
- 授权目录不会自动进入容器；生命周期脚本为每个目录生成稳定 ID 和独立 bind mount，配置只保存稳定 ID。
- 修改应用访问权限后，宿主侧 watcher 会读取 fnOS 授权记录并重建容器；容器内的 Compose 目录为只读，避免被容器改写。

## 开发与测试

```bash
npm ci
npm run check
npm test
npm run test:container
npm run fpk:build
```

- `npm run check`：TypeScript 编译、Node 测试、前端脚本语法检查。
- `npm run test:container`：生成式 HLS 和真实 FFmpeg 容器测试。
- `npm run fpk:build`：需要本机安装 `fnpack`。
- Docker 构建目标：`runtime`、`test`。

主要 API：

```text
GET    /api/status
POST   /api/auth/qr
GET    /api/auth/qr/status
GET    /api/auth/qr/:id.png
DELETE /api/auth/session
GET    /api/profile/avatar
GET    /api/devices
PUT    /api/config
POST   /api/sync
GET    /api/sync/history
```

## 故障处理

- 二维码过期：重新生成二维码。
- 页面提示重新扫码：当前凭证无法刷新，需要重新授权。
- 授权目录显示未授权：确认应用正在运行、目录仍在 fnOS 应用设置中；等待 watcher 重建，必要时查看应用日志。
- 外部 HTTPS 报 `unable to get local issuer certificate`：反向代理证书链不完整，不是应用 Socket 问题。
- 文件管理器“创建时间”与故事日期不同：Linux/fnOS 不能可靠回填 birth time；应用写入的是 MP4 `creation_time`、`mtime` 和文件名日期。
- `fnpack`、Docker、FFmpeg 缺失：先确认对应工具已安装并在 PATH 中。

## 限制

- ARM64 fnOS 真机尚未验证。
- 外部 HTTPS 完整证书链尚未验收。
- 不提供公网部署、未认证局域网访问或多租户。
- 不支持在容器运行时下载 FFmpeg。
- fnOS 卸载可能删除应用私有目录，即使向导选择“保留”；视频目录应保留，具体以 fnOS 行为为准。
- 当前 FPK 使用本地开发镜像 tag，正式发布前必须替换为公开、不可覆盖的多架构镜像地址。

## 许可证

- 许可证：[MIT License](LICENSE)

## 参考

- 飞牛 Docker 应用案例：<https://developer.fnnas.com/docs/examples/docker/>
- 飞牛统一网关：<https://developer.fnnas.com/docs/core-concepts/gateway-registration/>
- `fnpack`：<https://developer.fnnas.com/docs/cli/fnpack/>
- `appcenter-cli`：<https://developer.fnnas.com/docs/cli/appcentercli/>
- `PiotrMachowski/Xiaomi-cloud-tokens-extractor`：小米二维码登录和 RC4 请求格式。
- `moguennouni/homebridge-xiaomi-go2rtc`：摄像头业务域和加密 GET 请求。
