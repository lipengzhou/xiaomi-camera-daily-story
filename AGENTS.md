# AGENTS.md

本文件只记录无法从代码直接看出的约束和 fnOS 行为。用户/开发者文档统一放在 `README.md`。

## 项目约束

- 这是 fnOS Docker 应用，同时支持 Windows、macOS、Linux 本地开发；不要把本机路径或工具配置写死到 fnOS 运行时。
- 默认视频目录是应用 data-share（容器内 `/videos`）。用户授权目录只能通过稳定 ID 选择，不能接受 API 或配置传入任意宿主机路径。
- 容器必须保持：非 root、只读根文件系统、无 Docker socket、无 privileged、无 host network。
- 不要把真实小米凭证、fnOS Cookie、二维码 ID、NAS 域名、SSH 密码、真实用户目录或视频提交到仓库。
- 本地开发从 `.env`、`.env.local` 加载配置，默认加密凭证和数据存放在项目 `.dev/local/`。这些文件必须被 Git 和 Docker 构建排除；只提交无真实凭证的 `.env.example`。fnOS/production 不加载项目环境文件。
- 公开仓库使用 MIT；`README.md` 是唯一用户/开发者文档，不要新增重复 docs。

## fnOS 生命周期（代码里看不出来）

- 应用中心对 Docker 应用通常只调用 `cmd/main status`，不会调用 `cmd/main start`。
- `cmd/main status` 以 root 执行；`config_init`、`config_callback` 以应用用户执行。需要 Docker/root 的逻辑只能放在 `status` 或宿主侧 helper。
- `config/resource` 里的 `force_recreate` 是未公开字段，真机验证不会在权限变更时触发容器重建，不要依赖它。
- 普通停止/启动会复用已有容器，不会因为 Compose 文件变化而重建。
- 修改访问权限时，fnOS 更新 appcenter 数据库和 `TRIM_DATA_ACCESSIBLE_PATHS`，但不会自动把新目录挂进容器。
- `TRIM_DATA_ACCESSIBLE_PATHS` 是冒号分隔的宿主机路径；Docker Compose 不能直接把它展开成多条 volume。
- 当前方案：`cmd/main status` 确保 `cmd/authorized-mounts-watcher` 存活；watcher 以 root 读取 appcenter 数据库 `app_authorization_path`，路径变化或容器挂载不一致时执行 `docker compose up -d --force-recreate`。
- watcher 不使用容器可写的 TSV 作为挂载决策来源；TSV 只用于应用展示。容器内 `${TRIM_APPDEST}/docker` 必须保持只读，防止容器改写 Compose。
- watcher 重建期间写 `/run/xiaomi-camera-daily-story-recreating`；`cmd/main status` 看到该标记时继续返回运行中，避免应用中心误判停止。
- `cmd/main start` 的强制重建逻辑只作为兼容路径保留，不能假设它会被调用。
- watcher 依赖 appcenter 数据库 schema 和 `status` 调用；fnOS 大版本升级后必须重新真机验证。

## 构建与升级

- `package-lock.json` 必须使用公共 npm 源；不能包含内部 npm 镜像地址。
- 测试版 FPK 使用本地镜像 tag `xiaomi-camera-daily-story:<package.json 版本>`；安装前必须在 NAS 预载同名镜像。正式版在暂存包中使用公开镜像地址和多架构索引 digest，源码模板保留测试版引用。
- 有真实凭证/配置时禁止 `appcenter-cli install-local`；它会卸载重装并可能清空应用私有目录。
- `appcenter-cli install-fpk` 不是原地升级；升级必须走应用中心 Web UI 手动安装。
- 已用 `fnpack 1.2.3` 验证；FPK 测试会检查 manifest、Compose、版本和资源声明一致性。

## 测试约束

- 测试在 macOS 的 bash 3.2 下运行；shell 代码不要使用关联数组等 bash 4+ 特性。
- FPK 测试使用假 `docker`、`psql`、`runuser`；生命周期脚本必须允许这些命令被 PATH 覆盖。
- 授权目录渲染依赖 `sha256sum`；测试环境需保证可用。
- 修改生命周期、挂载、存储选择或 watcher 时，必须同时更新 `test/fpk.test.ts` 和 `test/runtime.test.ts`/`test/server.test.ts` 的相关断言。

## 发布规则

- 公开仓库不要包含真实真机调试记录、真实路径、用户名、UID、域名或时间线；这些内容放在仓库外私有 notes。
- 当前 Git 历史可能包含旧的个人路径；发布 public 仓库时优先新建干净目录并做单次 initial commit，不要直接推送旧历史。
- 正式发布前必须替换本地镜像 tag 为公开、不可覆盖的多架构镜像地址，并补 ARM64 真机和外部 HTTPS 证书链验收。
