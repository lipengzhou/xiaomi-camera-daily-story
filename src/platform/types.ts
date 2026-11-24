import type { CredentialStore } from "../credentials.js";

export type SupportedPlatform = "darwin" | "linux" | "win32";
export type RuntimeMode = "local" | "fnos";

export interface AuthorizedVideoRoot {
  id: `accessible:${string}`;
  label: string;
  path: string;
  available: boolean;
}

export interface RuntimePaths {
  configDir: string;
  dataDir: string;
  downloadRoot: string;
  authorizedDownloadRoots?: AuthorizedVideoRoot[];
  authorizedDownloadRootsFile?: string;
  credentialKeyFile: string;
  credentialFile: string;
  configFile: string;
  historyFile: string;
}

export interface MediaTools {
  ffmpeg: string;
  ffprobe: string;
  hlsInputOptions: string[];
}

export interface MediaToolProvider {
  getTools(): MediaTools;
}

export interface FileTimeResult {
  creationTimeSupported: boolean;
  creationTimeSet: boolean;
  modificationTimeSet: boolean;
}

export interface FileTimeProvider {
  setTimes(file: string, date: Date): Promise<FileTimeResult>;
}

export interface FileOperationProvider {
  setMediaPermissions(file: string): Promise<void>;
  replaceFile(partial: string, target: string): Promise<void>;
  removeTemporary(file: string): Promise<void>;
}

export interface PlatformCapabilities {
  credentials: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  fileCreationTime: boolean;
  mediaDownload: boolean;
}

export type CredentialStoreKind = "encrypted-file";

export interface CredentialStoreStatus {
  kind: CredentialStoreKind;
  label: string;
  available: boolean;
  persistent: boolean;
}

export interface PlatformIssue {
  code: string;
  message: string;
  blocking: boolean;
}

export interface MediaRuntimeStatus {
  available: boolean;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  hls: boolean;
  protocols: string[];
  hlsOptions: string[];
  missing: string[];
}

export type RuntimeWebConfig =
  | {
      basePath: "";
      transport: "tcp";
    }
  | {
      basePath: "/app/xiaomi-camera-daily-story";
      transport: "unix";
      socketPath: string;
    };

export interface PlatformServices {
  runtimeMode: RuntimeMode;
  platform: SupportedPlatform;
  architecture: string;
  credentials: CredentialStore;
  credentialStore: CredentialStoreStatus;
  paths: RuntimePaths;
  web: RuntimeWebConfig;
  mediaTools: MediaToolProvider;
  fileTimes: FileTimeProvider;
  fileOperations: FileOperationProvider;
  issues: PlatformIssue[];
  mediaStatus?: MediaRuntimeStatus;
  capabilities(): Promise<PlatformCapabilities>;
}
