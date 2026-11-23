import { constants } from "node:fs";
import { access, chmod, lstat, rm, stat } from "node:fs/promises";
import path from "node:path";

async function socketEntryKind(socketPath: string): Promise<"missing" | "socket" | "other"> {
  try {
    const entry = await lstat(socketPath);
    return entry.isSocket() ? "socket" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

export async function prepareUnixSocket(socketPath: string): Promise<void> {
  if (!path.isAbsolute(socketPath)) {
    throw new Error("Unix Socket 路径必须是绝对路径。");
  }
  const directory = path.dirname(socketPath);
  const directoryStat = await stat(directory);
  if (!directoryStat.isDirectory()) {
    throw new Error(`Unix Socket 父路径不是目录：${directory}`);
  }
  await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);

  const kind = await socketEntryKind(socketPath);
  if (kind === "other") {
    throw new Error(`拒绝覆盖非 Socket 文件：${socketPath}`);
  }
  if (kind === "socket") {
    await rm(socketPath);
  }
}

export async function secureUnixSocket(socketPath: string): Promise<void> {
  if (await socketEntryKind(socketPath) !== "socket") {
    throw new Error(`应用未创建预期的 Unix Socket：${socketPath}`);
  }
  await chmod(socketPath, 0o660);
}

export async function cleanupUnixSocket(socketPath: string): Promise<void> {
  if (await socketEntryKind(socketPath) === "socket") {
    await rm(socketPath);
  }
}
