import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CredentialStore } from "../credentials.js";
import type { CommandRunner } from "../sync/commands.js";
import { probeLocalMediaTools } from "./ffmpeg.js";
import { NodeFileOperationProvider, NodeFileTimeProvider } from "./shared.js";
import type { CredentialStoreStatus, PlatformServices, RuntimePaths, SupportedPlatform } from "./types.js";

export function createLocalRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
  projectRoot: string = fileURLToPath(new URL("../../", import.meta.url)),
  platform: NodeJS.Platform = process.platform,
): RuntimePaths {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const resolve = (value: string): string => paths.resolve(projectRoot, value);
  const dataDir = resolve(environment.XIAOMI_STORY_DATA_DIR || ".dev/local/data");
  const configDir = resolve(environment.XIAOMI_STORY_CONFIG_DIR || ".dev/local/config");
  return {
    configDir,
    dataDir,
    downloadRoot: resolve(environment.XIAOMI_STORY_DOWNLOAD_ROOT || ".dev/local/videos"),
    credentialKeyFile: environment.XIAOMI_STORY_CREDENTIAL_KEY_FILE
      ? resolve(environment.XIAOMI_STORY_CREDENTIAL_KEY_FILE) : paths.join(configDir, "credential.key"),
    credentialFile: environment.XIAOMI_STORY_CREDENTIAL_FILE
      ? resolve(environment.XIAOMI_STORY_CREDENTIAL_FILE) : paths.join(dataDir, "credentials.enc"),
    configFile: paths.join(dataDir, "config.json"),
    historyFile: paths.join(dataDir, "sync-history.json"),
  };
}

export interface LocalPlatformOptions {
  platform?: SupportedPlatform;
  architecture?: string;
  credentials: CredentialStore;
  credentialStore?: CredentialStoreStatus;
  environment?: NodeJS.ProcessEnv;
  projectRoot?: string;
  paths?: RuntimePaths;
}

export async function createLocalPlatformServices(
  runner: CommandRunner,
  options: LocalPlatformOptions,
): Promise<PlatformServices> {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32" && platform !== "darwin" && platform !== "linux") {
    throw new Error("本地开发支持 Windows、macOS 和 Linux。");
  }
  const environment = options.environment ?? process.env;
  const media = await probeLocalMediaTools(runner, {
    ffmpeg: environment.XIAOMI_STORY_FFMPEG || "ffmpeg",
    ffprobe: environment.XIAOMI_STORY_FFPROBE || "ffprobe",
  });
  const status = media.provider.status;
  return {
    runtimeMode: "local",
    platform,
    architecture: options.architecture ?? process.arch,
    credentials: options.credentials,
    credentialStore: options.credentialStore ?? {
      kind: "encrypted-file", label: "AES-256-GCM 加密文件", available: true, persistent: true,
    },
    paths: options.paths ?? createLocalRuntimePaths(environment, options.projectRoot, platform),
    web: { basePath: "", transport: "tcp" },
    mediaTools: media.provider,
    mediaStatus: status,
    fileTimes: new NodeFileTimeProvider(),
    fileOperations: new NodeFileOperationProvider(),
    issues: media.issues,
    async capabilities() {
      return {
        credentials: true,
        ffmpeg: status.ffmpegVersion !== null,
        ffprobe: status.ffprobeVersion !== null,
        fileCreationTime: false,
        mediaDownload: status.available,
      };
    },
  };
}
