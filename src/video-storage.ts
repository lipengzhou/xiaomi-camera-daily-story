import { ValidationError } from "./errors.js";
import type { RuntimeMode, RuntimePaths } from "./platform/types.js";
import type { VideoStorage } from "./types.js";

export interface VideoStorageOption {
  id: VideoStorage;
  label: string;
  path: string;
  available: boolean;
}

export function videoStorageOptions(
  paths: RuntimePaths,
  runtimeMode: RuntimeMode = "local",
): VideoStorageOption[] {
  return [
    {
      id: "data-share",
      label: runtimeMode === "fnos"
        ? "应用文件/xiaomi-camera-daily-story/videos"
        : "本地归档目录",
      path: paths.downloadRoot,
      available: true,
    },
    ...(paths.authorizedDownloadRoots ?? []).map((root) => ({
      id: root.id,
      label: root.label,
      path: root.path,
      available: root.available,
    })),
  ];
}

export function resolveVideoRoot(
  paths: RuntimePaths,
  storage: VideoStorage,
): string {
  if (storage === "data-share") {
    return paths.downloadRoot;
  }
  const authorized = paths.authorizedDownloadRoots?.find(
    (root) => root.id === storage && root.available,
  );
  if (authorized) {
    return authorized.path;
  }
  throw new ValidationError(
    "所选 fnOS 授权文件夹当前不可用，请检查应用访问权限并停止、启动应用。",
  );
}
