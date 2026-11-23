import path from "node:path";

import type { CredentialStore } from "../credentials.js";
import type { ContainerMediaProbeResult } from "./ffmpeg.js";
import {
  LinuxFileTimeProvider,
  NodeFileOperationProvider,
} from "./shared.js";
import type {
  AuthorizedVideoRoot,
  CredentialStoreStatus,
  PlatformCapabilities,
  PlatformServices,
  RuntimePaths,
} from "./types.js";

export interface FnosRuntimeDirectories {
  configDir?: string;
  dataDir?: string;
  downloadRoot?: string;
  authorizedDownloadRoots?: AuthorizedVideoRoot[];
  authorizedDownloadRootsFile?: string;
  targetDir?: string;
}

export function createFnosRuntimePaths(
  directories: FnosRuntimeDirectories = {},
): RuntimePaths {
  const configDir = directories.configDir ?? "/config";
  const dataDir = directories.dataDir ?? "/data";
  const downloadRoot = directories.downloadRoot ?? "/videos";
  const authorizedDownloadRoots = directories.authorizedDownloadRoots;
  const authorizedDownloadRootsFile = directories.authorizedDownloadRootsFile;
  return {
    configDir,
    dataDir,
    downloadRoot,
    ...(authorizedDownloadRoots?.length ? { authorizedDownloadRoots } : {}),
    ...(authorizedDownloadRootsFile ? { authorizedDownloadRootsFile } : {}),
    credentialKeyFile: path.posix.join(configDir, "credential.key"),
    credentialFile: path.posix.join(dataDir, "credentials.enc"),
    configFile: path.posix.join(dataDir, "config.json"),
    historyFile: path.posix.join(dataDir, "sync-history.json"),
  };
}

export interface FnosPlatformOptions {
  architecture?: string;
  credentials: CredentialStore;
  credentialStore: CredentialStoreStatus;
  paths: RuntimePaths;
  socketPath: string;
  media: ContainerMediaProbeResult;
}

export function createFnosPlatformServices(
  options: FnosPlatformOptions,
): PlatformServices {
  return {
    runtimeMode: "fnos",
    platform: "linux",
    architecture: options.architecture ?? process.arch,
    credentials: options.credentials,
    credentialStore: options.credentialStore,
    paths: options.paths,
    web: {
      basePath: "/app/xiaomi-camera-daily-story",
      transport: "unix",
      socketPath: options.socketPath,
    },
    mediaTools: options.media.provider,
    fileTimes: new LinuxFileTimeProvider(),
    fileOperations: new NodeFileOperationProvider(0o660),
    issues: [...options.media.issues],
    mediaStatus: options.media.provider.status,
    async capabilities(): Promise<PlatformCapabilities> {
      const status = options.media.provider.status;
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
