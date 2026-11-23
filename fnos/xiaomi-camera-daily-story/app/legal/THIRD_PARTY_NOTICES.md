# 第三方软件说明

本应用容器使用以下主要第三方软件：

- Node.js，MIT License。
- FFmpeg，按 Debian 发行包实际构建选项适用 LGPL-2.1-or-later 或 GPL-2.0-or-later。
- Debian GNU/Linux 用户空间组件，分别适用其软件包声明的许可证。
- npm 运行依赖，许可证信息以 `package-lock.json` 和发布镜像 SBOM 为准。

分发镜像时请从最终的多架构镜像生成 SBOM 和许可证清单，并随发布归档。FFmpeg 对应源码获取方式及 Debian copyright 文件也应一并提供。
