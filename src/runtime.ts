import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";

import type { CredentialStore } from "./credentials.js";
import {
  createLocalPlatformServices,
  createLocalRuntimePaths,
} from "./platform/local.js";
import { EncryptedFileCredentialStore } from "./platform/encrypted-file.js";
import { probeContainerMediaTools } from "./platform/ffmpeg.js";
import {
  createFnosPlatformServices,
  createFnosRuntimePaths,
  type FnosRuntimeDirectories,
} from "./platform/fnos.js";
import type {
  AuthorizedVideoRoot,
  CredentialStoreStatus,
  PlatformServices,
  RuntimeMode,
  RuntimePaths,
} from "./platform/types.js";
import type { CommandRunner } from "./sync/commands.js";

export interface RuntimeFactoryOptions {
  architecture?: string;
  credentials?: CredentialStore;
  environment?: NodeJS.ProcessEnv;
  projectRoot?: string;
  fnosDirectories?: FnosRuntimeDirectories;
}

export function resolveRuntimeMode(
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeMode {
  const value = environment.XIAOMI_STORY_RUNTIME;
  if (value === undefined || value === "") {
    if (environment.NODE_ENV === "production") {
      throw new Error(
        "production 环境必须显式设置 XIAOMI_STORY_RUNTIME=fnos。",
      );
    }
    return "local";
  }
  if (value !== "local" && value !== "fnos") {
    throw new Error("XIAOMI_STORY_RUNTIME 只能是 local 或 fnos。");
  }
  if (value === "local" && environment.NODE_ENV === "production") {
    throw new Error("production 环境不允许使用 local 运行模式。");
  }
  return value;
}

function validateAbsolutePaths(
  platform: NodeJS.Platform,
  paths: RuntimePaths,
): void {
  const isAbsolute = platform === "win32" ? path.win32.isAbsolute : path.posix.isAbsolute;
  for (const [name, value] of Object.entries(paths)) {
    if (name === "authorizedDownloadRoots" || value === undefined) {
      continue;
    }
    if (typeof value !== "string" || !isAbsolute(value)) {
      throw new Error(`${name} 必须是绝对路径。`);
    }
  }
  for (const root of paths.authorizedDownloadRoots ?? []) {
    if (!isAbsolute(root.path)) {
      throw new Error(`授权视频目录 ${root.id} 必须是绝对路径。`);
    }
  }
}

export async function readAuthorizedVideoRoots(
  metadataFile: string,
): Promise<AuthorizedVideoRoot[]> {
  let contents: string;
  try {
    contents = await readFile(metadataFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const roots = contents
    .split("\n")
    .filter(Boolean)
    .map((line, index): AuthorizedVideoRoot => {
      const fields = line.split("\t");
      if (fields.length !== 3) {
        throw new Error(`授权视频目录元数据第 ${index + 1} 行格式无效。`);
      }
      const [id, label, rootPath] = fields as [string, string, string];
      if (
        !/^accessible:[a-f0-9]{12}$/u.test(id) ||
        !label ||
        /[\u0000-\u001f\u007f]/u.test(label) ||
        !/^\/authorized-videos-[a-f0-9]{12}$/u.test(rootPath)
      ) {
        throw new Error(`授权视频目录元数据第 ${index + 1} 行内容无效。`);
      }
      return {
        id: id as AuthorizedVideoRoot["id"],
        label,
        path: rootPath,
        available: false,
      };
    });
  if (new Set(roots.map((root) => root.id)).size !== roots.length) {
    throw new Error("授权视频目录元数据包含重复 ID。");
  }
  return Promise.all(
    roots.map(async (root) => {
      try {
        await access(root.path, constants.R_OK | constants.W_OK);
        return { ...root, available: true };
      } catch {
        return root;
      }
    }),
  );
}

async function resolveFnosDirectories(
  directories: FnosRuntimeDirectories = {},
): Promise<FnosRuntimeDirectories> {
  if (directories.authorizedDownloadRoots) {
    return directories;
  }
  const configDir = directories.configDir ?? "/config";
  const authorizedDownloadRootsFile =
    directories.authorizedDownloadRootsFile ??
    path.posix.join(configDir, "authorized-video-roots.tsv");
  const authorizedDownloadRoots = await readAuthorizedVideoRoots(authorizedDownloadRootsFile);
  return {
    ...directories,
    authorizedDownloadRootsFile,
    ...(authorizedDownloadRoots.length ? { authorizedDownloadRoots } : {}),
  };
}

export async function createRuntimeServices(
  platform: NodeJS.Platform,
  runner: CommandRunner,
  options: RuntimeFactoryOptions = {},
): Promise<PlatformServices> {
  const environment = options.environment ?? process.env;
  const runtimeMode = resolveRuntimeMode(environment);
  if (runtimeMode === "local" && !["win32", "darwin", "linux"].includes(platform)) {
    throw new Error("本地开发支持 Windows、macOS 和 Linux。");
  }
  if (runtimeMode === "fnos" && platform !== "linux") {
    throw new Error("fnos 运行模式只能在 Linux 容器中启动。");
  }

  const fnosDirectories = runtimeMode === "fnos"
    ? await resolveFnosDirectories(options.fnosDirectories)
    : null;
  const paths = runtimeMode === "local"
    ? createLocalRuntimePaths(environment, options.projectRoot, platform)
    : createFnosRuntimePaths(fnosDirectories!);
  validateAbsolutePaths(platform, paths);
  const socketPath = runtimeMode === "fnos"
    ? path.posix.join(fnosDirectories?.targetDir ?? "/app/target", "app.sock")
    : null;
  if (socketPath && !path.posix.isAbsolute(socketPath)) {
    throw new Error("fnOS socketPath 必须是绝对路径。");
  }

  const credentials =
    options.credentials ??
    new EncryptedFileCredentialStore({
      keyFile: paths.credentialKeyFile,
      credentialFile: paths.credentialFile,
    });
  const credentialStore: CredentialStoreStatus = {
    kind: "encrypted-file",
    label: "AES-256-GCM 加密文件",
    available: true,
    persistent: true,
  };

  if (runtimeMode === "local") {
    return createLocalPlatformServices(runner, {
      platform: platform as "win32" | "darwin" | "linux",
      environment,
      ...(options.architecture ? { architecture: options.architecture } : {}),
      credentials,
      credentialStore,
      paths,
    });
  }
  const media = await probeContainerMediaTools(runner);
  return createFnosPlatformServices({
    ...(options.architecture ? { architecture: options.architecture } : {}),
    credentials,
    credentialStore,
    paths,
    socketPath: socketPath!,
    media,
  });
}
