import { chmod, rename, rm, utimes } from "node:fs/promises";

import type {
  FileOperationProvider,
  FileTimeProvider,
  FileTimeResult,
} from "./types.js";

export class NodeFileOperationProvider implements FileOperationProvider {
  constructor(private readonly mediaFileMode = 0o600) {}

  async setMediaPermissions(file: string): Promise<void> {
    await chmod(file, this.mediaFileMode);
  }

  async replaceFile(partial: string, target: string): Promise<void> {
    await rename(partial, target);
  }

  async removeTemporary(file: string): Promise<void> {
    await rm(file, { recursive: true, force: true });
  }
}

export class LinuxFileTimeProvider implements FileTimeProvider {
  async setTimes(file: string, date: Date): Promise<FileTimeResult> {
    await utimes(file, date, date);
    return {
      creationTimeSupported: false,
      creationTimeSet: false,
      modificationTimeSet: true,
    };
  }
}
