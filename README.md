# 米家摄像头每日故事自动同步

> 非官方项目，与小米、米家、飞牛 fnOS 无隶属关系。相关商标归各自权利人所有。

面向飞牛 fnOS 的米家摄像头每日故事归档工具。通过 Web 后台完成小米账号扫码授权、跨家庭选择摄像头、每日故事查询、HLS 下载、FFmpeg 封装和按月归档。

当前已在 x86_64 fnOS 上验证安装、原地升级、授权目录挂载和真实视频同步；ARM64 真机与外部 HTTPS 完整证书链仍待验证。

## 功能

- 小米账号二维码登录，凭证 AES-256-GCM 加密保存。
- 多家庭、多摄像头配置和批量同步。
- 每日故事 HLS 下载并封装为标准 MP4，不重新编码。
- 按 `<家庭>/<摄像头>/YYYY/MM/XIAOMI_CAMRA4_YYYYMMDD.mp4` 归档。
- 已存在且非空的视频跳过；绝不自动删除已有视频。
- 手动同步、每日定时同步、同步互斥。
- 支持应用共享目录和 fnOS 应用设置中授权的多个目录。
- fnOS FPK 安装，Docker 容器运行，通过统一网关访问。

## 环境要求

- Node.js 20.11 或更高版本，npm。
- 本地完整同步：FFmpeg、ffprobe，可通过 PATH 或 `.env.local` 配置路径。
- Docker（构建镜像和容器测试）。
- 飞牛官方 `fnpack`（构建 FPK）。
- fnOS 管理员账号。

## 开发、测试与发布流程

当前应用采用 Docker 运行方式，同时提供本地开发模式。FPK 包含 manifest、生命周期脚本、Compose、权限和桌面入口；程序、Node.js、FFmpeg 和 ffprobe 位于 Docker 镜像中。当前 FPK 不包含镜像 tar，也不会自动导入镜像。

| 阶段 | 主要用途 | 命令与交付 | 是否需要应用中心升级 |
|---|---|---|---|
| 本地开发 | 修改接口、页面、同步逻辑 | `npm run dev`、`npm run check` | 不需要 |
| 容器媒体测试 | 验证容器内 FFmpeg 下载和封装 | `npm run test:media:docker` | 不需要 |
| fnOS 应用测试版 | 验证安装、网关、授权目录和升级 | `npm run fpk:test:build`，生成镜像 tar 和 FPK | 完整应用验收需要 |
| 正式版在线发布 | 发布版本化镜像和正式 FPK | `npm run release:build -- --image <镜像仓库地址>` | 用户手动发起，系统下载指定镜像 |

每次修改业务代码不必走完整 FPK 升级。先在本地和容器中验证；涉及 fnOS 安装脚本、权限、目录声明、桌面入口，或正式发布前的完整验收时，再测试 FPK 安装与升级。

### 版本管理

`package.json` 是应用版本的唯一来源。构建脚本自动同步锁文件、FPK manifest、两份测试版 Compose 的镜像 tag 和前端 JS/CSS 资源版本，产物名称和 NAS 预载脚本也自动使用该版本。

准备一个新的补丁版本：

```bash
npm version patch --no-git-tag-version
```

`postversion` 会自动同步关联文件；该命令不创建 Git 提交或 tag。需要增加其他版本级别时，可将 `patch` 改为 `minor` 或 `major`。应用中心升级要求新版本高于已安装版本，正式镜像版本发布后不能覆盖。

只同步现有版本，不递增：

```bash
npm run version:sync
```

`dev`、`check` 及打包脚本也会同步版本，不需要手动改多个文件。正式打包时只在暂存包中替换镜像仓库地址和 digest，源码中的 Compose 保留本地测试引用。

### 本地开发与环境配置

启动本地开发服务：

```bash
npm ci
npm run dev
```

首次运行 `dev` 会从仓库的 `.env.example` 生成 `.env.local`，在终端提示配置文件和配置项，然后按默认值启动。已有 `.env.local` 不会被覆盖。打开 `http://127.0.0.1:3210`；`tsx watch` 会在源码变化后重启服务。默认只监听回环地址，不要改成 `0.0.0.0`。

在编辑器中修改 `.env.local`：

```dotenv
PORT=3210
XIAOMI_STORY_RUNTIME=local
XIAOMI_STORY_CONFIG_DIR=.dev/local/config
XIAOMI_STORY_DATA_DIR=.dev/local/data
XIAOMI_STORY_DOWNLOAD_ROOT=.dev/local/videos
XIAOMI_STORY_FFMPEG=ffmpeg
XIAOMI_STORY_FFPROBE=ffprobe
```

- 相对目录基于项目根目录解析，绝对目录也可使用。
- FFmpeg、ffprobe 默认从 PATH 查找，也可配置完整可执行文件路径；含空格的路径可加引号。
- 修改端口可直接编辑 `PORT`；修改 `.env` 或 `.env.local` 后重新运行 `npm run dev`。
- 环境变量优先级：进程已有环境变量 > `.env.local` > `.env`。文件使用 UTF-8，不进行 `$VARIABLE` 插值。
- `.env`、`.env.local` 和 `.dev/` 被 Git 和 Docker 构建排除；`.env.example` 是可提交的无真实凭证模板。

小米授权通过页面扫码完成，不需要把密码或 token 填入环境文件。授权后，主密钥默认写入 `.dev/local/config/credential.key`，加密凭证写入 `.dev/local/data/credentials.enc`，配置和历史也写入项目私有目录，重启后恢复登录。目录可通过环境配置调整，自定义存储位置也应保持在 Git 忽略范围内。旧版用户目录中的数据不会被删除；需要继续使用时可配置其目录，或在新默认目录重新扫码授权。

非 production 环境默认使用 `local`；fnOS/production 不读取项目环境文件，Dockerfile 和 Compose 显式设置 `XIAOMI_STORY_RUNTIME=fnos`，继续使用容器持久化目录。

修改完成后运行：

```bash
npm run check
npm run test:container
```

`npm run check` 包含 TypeScript 编译、Node 测试、FPK 和构建流程断言，以及前端和构建脚本语法检查。fnOS 生命周期与 Unix Socket 服务可通过下节的容器完整检查验证；直接执行 shell 测试需要 Bash 和 `sha256sum`。

`npm run test:container` 使用生成的测试视频和本机配置的 FFmpeg/ffprobe，验证 HLS 下载、MP4 封装、媒体时间、权限及临时文件清理。它不会自动启动 Docker，运行时需要本机媒体工具；也可使用下一节的 Docker 测试避免依赖本机 FFmpeg。

### 容器测试

使用 Docker 验证与 fnOS 一致的媒体工具环境，不需要 NAS 或真实小米凭证：

```bash
npm run test:media:docker
```

默认验证 amd64 镜像。验证 ARM64：

```bash
npm run test:media:docker -- --arch arm64
```

脚本自动构建 `build` 目标，以非 root、只读根文件系统运行测试容器，只读挂载 `container-test/`，将测试视频写入容器临时目录。它不覆盖 fnOS 应用中心、统一网关和真实授权目录，模拟架构测试不能代替 NAS 真机验收。

在容器中执行完整检查（含 Bash 生命周期、Unix Socket 和媒体测试）：

```bash
npm run test:docker
```

该脚本构建 `test` 目标并运行媒体测试，默认架构也是 amd64，可通过 `--arch arm64` 调整。Dockerfile 提供 `build`、`test` 和 `runtime` 目标；测试版和正式版构建也会自动执行对应架构的容器媒体测试。

### fnOS 应用测试版

当前测试版使用本地镜像 tag `xiaomi-camera-daily-story:<package.json 版本>`。交付镜像 tar 和 FPK，先导入镜像，再在应用中心上传 FPK。仅把 tar 复制到 NAS，不代表镜像已经导入。

#### 1. 构建测试版

安装 Docker 和 `fnpack` 后，在仓库根目录执行：

```bash
npm run fpk:test:build
```

默认构建 x86_64 NAS 的镜像。ARM64 NAS 使用：

```bash
npm run fpk:test:build -- --arch arm64
```

脚本自动完成版本同步、完整检查、容器媒体测试、运行镜像构建、tar 导出、FPK 打包和 SHA-256 生成。产物位于 `.dev/artifacts/test/<版本>/<架构>/`：

- 带版本和架构的镜像 `.tar`。
- 带版本的 `.fpk`。
- `prepare-nas.sh`：自动读取构建时写入的版本和架构，校验文件并导入镜像。
- `SHA256SUMS` 和 `artifacts.json`：记录产物、镜像引用和校验信息。

这些产物不提交到 Git。只需要重打当前本地镜像引用的 FPK 时，可以运行 `npm run fpk:build`；它执行完整检查后生成 `.dev/artifacts/fpk/<版本>/` 下的 FPK，并保留仓库根目录的 `xiaomi-camera-daily-story.fpk` 兼容输出，不构建或导出镜像。

#### 2. 上传并预载到测试 NAS

可以把上面的产物目录上传到 NAS，进入目录后执行：

```bash
sudo bash prepare-nas.sh
```

脚本先验证 NAS 架构和 `SHA256SUMS`，再执行镜像导入并核对 tag、架构。版本来自产物本身，不需要手动填写。

也可以在构建机自动上传并预载：

```bash
npm run fpk:test:deploy -- --host nas-test
```

`nas-test` 是示例 SSH 配置别名，应替换为实际目标。ARM64 产物同时加 `--arch arm64`。部署脚本只读取当前版本、对应架构的测试产物，先在本地核对 SHA-256，再通过 SSH/SCP 上传到 NAS 的独立临时目录并运行预载脚本。根据 NAS sudo 配置，可能需要在终端输入密码；脚本不存储 SSH 或 sudo 密码。

预载脚本不安装或升级应用。看到镜像预载成功后，在应用中心 Web UI 的“手动安装”中上传对应 FPK，完成首次安装或原地升级。有真实凭证或配置时禁止使用 `appcenter-cli install-local`，它会卸载重装并可能清空私有目录；`appcenter-cli install-fpk` 也不是原地升级入口。不要通过卸载旧应用来更新。

#### 3. 真机验收

- 应用中心显示新版本；Docker 容器使用新镜像，而不是只更新了 FPK 声明。
- 关闭并重新打开应用窗口，确认统一网关、管理员鉴权、登录状态和配置可用。
- 授权目录能够显示和写入；修改授权后，watcher 能重建容器并刷新目录选项。
- 使用独立测试归档目录同步视频，确认无新增封面、无重新编码、拍摄时间正确，并观察 CPU 占用。已有非空目标会被跳过，不需要删除已有视频来测试。
- 确认升级后凭证、配置、历史和视频仍可用；保留旧版本镜像供恢复使用，验收后只清理本次上传的临时文件。

普通停止、启动或 `docker restart` 会复用旧容器，不能代替换镜像后的容器重建。只改业务代码时，可以在独立测试容器中更新镜像并重建，省去 FPK 升级；安装脚本、权限、目录和完整升级行为仍需走 FPK 真机验收。NAS 上通过只读代码挂载进行热重载属于后续开发方案，当前未提供专用配置；测试容器不得共用正式应用的可写凭证和数据目录。

### 正式版在线发布

正式在线版将镜像发布到 NAS 可访问的公开仓库，FPK 锁定该版本的多架构镜像索引 digest。用户只下载 FPK，通过应用中心手动安装或升级；系统下载 FPK 指定版本的镜像，不是自动决定升级到另一个版本，也无需用户执行 `docker load`。

#### 1. 发布前验收

准备新版本并完成 fnOS 真机测试，正式发布前还需完成 ARM64 NAS 和外部 HTTPS 完整证书链验收。脚本中的模拟架构测试不能代替这两项人工验收。

公开代码使用 MIT，检查源文件和构建上下文不含真实凭证、配置、视频或真机调试记录。旧历史可能含个人路径，首次公开发布优先使用干净目录和单次 initial commit。镜像分发还应提供第三方许可证和 FFmpeg 对应源码获取说明。

#### 2. 构建镜像与正式 FPK

构建机先完成镜像仓库登录，并确保仓库允许用户 NAS 下载。下面的 `your-org` 是示例，镜像参数只填写完整仓库地址，版本和摘要由脚本决定：

```bash
npm run release:build -- --image ghcr.io/your-org/xiaomi-camera-daily-story
```

该命令会向指定仓库推送镜像，自动执行：

1. 从 `package.json` 读取版本，检查对应镜像 tag 尚不存在；已有 tag、鉴权失败或仓库访问异常时停止。
2. 同步版本并运行完整检查，以及 amd64、arm64 的容器媒体测试。
3. 构建并推送多架构运行镜像，同时生成 SBOM 和来源证明 attestation。
4. 读取构建结果的 digest，并从仓库核对索引包含 amd64、arm64。
5. 在暂存的两份 Compose 中写入完整镜像地址、版本 tag 和索引 digest，再生成正式 FPK 和 SHA-256。

正式版产物位于 `.dev/artifacts/release/<版本>/`，包含 FPK、`image.json`、`SHA256SUMS` 和 `artifacts.json`，不包含镜像 tar。SBOM 位于发布镜像的 OCI attestation 中。源码模板继续保留测试版镜像引用，无需手动修改 Compose 的仓库地址或摘要。

正式版本不能重复覆盖，仓库也应启用 tag 不可覆盖策略，不使用 `latest`。如果镜像已推送但后续 FPK 构建失败，脚本不会生成成功的正式产物；排查后为下一次发布递增版本。当前尚未配置项目的正式镜像仓库，也未通过该脚本发布公开版本。

#### 3. 发布给用户

在测试 NAS 确认生成的正式 FPK 能下载镜像、安装或升级并保留数据后，再将 FPK、SHA-256、更新说明、支持架构、系统要求和第三方依赖说明发布到下载页或应用中心。保留旧镜像和旧 FPK，后续版本如需配置迁移，应同时验证升级保留用户数据。

`release:build` 发布镜像并生成本地正式 FPK，不会上传 FPK 到发布页，也不会操作用户 NAS。当前 CI 做检查和运行镜像构建，尚未自动运行发布流程。

#### 4. 用户升级

用户在应用中心 Web UI 手动安装新 FPK。系统按 Compose 下载指定镜像并更新容器，配置、凭证和视频继续使用持久化挂载目录。用户无需另外传 tar；NAS 必须能访问所选镜像仓库。升级后重新打开应用，并确认新版本、登录状态和视频归档目录。

### 离线交付与后续方案

离线测试使用 `fpk:test:build` 生成的镜像 tar 和匹配 FPK，再通过 `prepare-nas.sh` 预载。公开仓库镜像引用的 FPK 与本地镜像引用的测试 FPK 不能混用，镜像名称和版本都必须匹配。

把镜像 tar 内置进 FPK、由安装或升级过程自动导入，可以作为单文件离线安装的后续方案，但目前没有实现或真机验证。它需要验证宿主侧导入权限、执行时序和失败恢复，单纯把 tar 放进 FPK 不会自动生效。本项目仍采用 Docker 运行方式，尚未提供 Native FPK。

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
- 家庭名和摄像头名中的路径分隔符、控制字符及文件名非法字符替换为 `_`。
- 不同摄像头清洗后的路径如果完全相同，保存配置会被拒绝，避免互相覆盖。
- 0 字节目标文件不视为完成。
- 最终视频保留源视频的编码（当前米家每日故事为 H.264/AAC）和帧率，不重新编码。
- 封装结果先写入隐藏 `.partial.mp4`，校验通过后才生成最终文件。
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

本地开发（相对于项目根目录，可在 `.env.local` 中调整）：

- 环境配置：`.env`、`.env.local`。
- 主密钥：`.dev/local/config/credential.key`。
- 加密授权凭证：`.dev/local/data/credentials.enc`。
- 配置和历史：`.dev/local/data/config.json`、`.dev/local/data/sync-history.json`。
- 视频：`.dev/local/videos/`。

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

## API

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
- 文件管理器“创建时间”与故事日期不同：文件系统创建时间可能无法回填；应用写入的是 MP4 `creation_time`、`mtime` 和文件名日期。
- 测试版升级出现 Docker Hub 拉取超时：先用 `prepare-nas.sh` 或 `fpk:test:deploy` 完成预载，再确认 FPK 与镜像引用、版本、架构匹配；仅上传 tar 不会导入镜像。正式版需要检查公开镜像仓库是否可访问。
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
