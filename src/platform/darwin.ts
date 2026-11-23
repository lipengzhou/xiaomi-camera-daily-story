import { constants } from "node:fs";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CredentialStore } from "../credentials.js";
import type { CommandRunner } from "../sync/commands.js";
import { NodeFileOperationProvider } from "./shared.js";
import type {
  CredentialStoreStatus,
  FileTimeProvider,
  FileTimeResult,
  MediaToolProvider,
  MediaTools,
  PlatformCapabilities,
  PlatformServices,
  RuntimePaths,
} from "./types.js";

const SET_FILE_COMMAND = "/usr/bin/SetFile";
const DEFAULT_MEDIA_TOOLS: MediaTools = {
  ffmpeg: "/opt/homebrew/bin/ffmpeg",
  ffprobe: "/opt/homebrew/bin/ffprobe",
  hlsInputOptions: [
    "-extension_picky",
    "0",
    "-allowed_segment_extensions",
    "ALL",
    "-protocol_whitelist",
    "pipe,http,https,tcp,tls,crypto",
  ],
};

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function setFileTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const fields = new Map(parts.map((part) => [part.type, part.value]));
  const year = fields.get("year");
  const month = fields.get("month");
  const day = fields.get("day");
  const hour = fields.get("hour");
  const minute = fields.get("minute");
  const second = fields.get("second");
  if (!year || !month || !day || !hour || !minute || !second) {
    throw new Error("无法生成 macOS 文件时间参数。");
  }
  return `${month}/${day}/${year} ${hour}:${minute}:${second}`;
}

export function createDarwinRuntimePaths(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir(),
): RuntimePaths {
  const dataDir =
    environment.XIAOMI_STORY_DATA_DIR ??
    path.join(homeDirectory, "Library", "Application Support", "XiaomiCameraDailyStory");
  const configDir = environment.XIAOMI_STORY_CONFIG_DIR ?? dataDir;
  const downloadRoot =
    environment.XIAOMI_STORY_DOWNLOAD_ROOT ??
    path.join(homeDirectory, "Downloads", "小米摄像头每日故事");
  return {
    configDir,
    dataDir,
    downloadRoot,
    credentialKeyFile:
      environment.XIAOMI_STORY_CREDENTIAL_KEY_FILE ?? path.join(configDir, "credential.key"),
    credentialFile:
      environment.XIAOMI_STORY_CREDENTIAL_FILE ?? path.join(dataDir, "credentials.enc"),
    configFile: path.join(dataDir, "config.json"),
    historyFile: path.join(dataDir, "sync-history.json"),
  };
}

export class DarwinMediaToolProvider implements MediaToolProvider {
  getTools(): MediaTools {
    return { ...DEFAULT_MEDIA_TOOLS };
  }
}

export class DarwinFileTimeProvider implements FileTimeProvider {
  constructor(private readonly runner: CommandRunner) {}

  async setTimes(file: string, date: Date): Promise<FileTimeResult> {
    const timestamp = setFileTimestamp(date);
    await this.runner.run(SET_FILE_COMMAND, ["-d", timestamp, "-m", timestamp, file]);
    return {
      creationTimeSupported: true,
      creationTimeSet: true,
      modificationTimeSet: true,
    };
  }
}

export class DarwinFileOperationProvider extends NodeFileOperationProvider {}

export interface DarwinPlatformOptions {
  architecture?: string;
  credentials: CredentialStore;
  credentialStore?: CredentialStoreStatus;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  paths?: RuntimePaths;
}

export function createDarwinPlatformServices(
  runner: CommandRunner,
  options: DarwinPlatformOptions,
): PlatformServices {
  const mediaTools = new DarwinMediaToolProvider();
  return {
    runtimeMode: "local",
    platform: "darwin",
    architecture: options.architecture ?? process.arch,
    credentials: options.credentials,
    credentialStore: options.credentialStore ?? {
      kind: "encrypted-file",
      label: "AES-256-GCM 加密文件",
      available: true,
      persistent: true,
    },
    paths:
      options.paths ?? createDarwinRuntimePaths(options.environment, options.homeDirectory),
    web: {
      basePath: "",
      transport: "tcp",
    },
    mediaTools,
    fileTimes: new DarwinFileTimeProvider(runner),
    fileOperations: new DarwinFileOperationProvider(),
    issues: [],
    async capabilities(): Promise<PlatformCapabilities> {
      const tools = mediaTools.getTools();
      const [ffmpeg, ffprobe, fileCreationTime] = await Promise.all([
        isExecutable(tools.ffmpeg),
        isExecutable(tools.ffprobe),
        isExecutable(SET_FILE_COMMAND),
      ]);
      return {
        credentials: true,
        ffmpeg,
        ffprobe,
        fileCreationTime,
        mediaDownload: ffmpeg && ffprobe && fileCreationTime,
      };
    },
  };
}
