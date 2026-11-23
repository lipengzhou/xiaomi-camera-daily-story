import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { ValidationError } from "./errors.js";
import type { FileOperationProvider, RuntimePaths } from "./platform/types.js";
import { safePathSegment } from "./sync/path.js";
import type { AppConfig, ConfiguredCamera, SyncRecord, VideoStorage } from "./types.js";

interface ConfigCandidate {
  schemaVersion?: unknown;
  videoStorage?: unknown;
  devices?: unknown;
  story?: unknown;
  schedule?: unknown;
}

function defaultConfig(): AppConfig {
  return {
    schemaVersion: 1,
    videoStorage: "data-share",
    devices: [],
    story: {
      region: "CN",
      timezone: "Asia/Shanghai",
    },
    schedule: {
      enabled: false,
      time: "08:17",
      timezone: "Asia/Shanghai",
      catchUpOnStart: false,
    },
  };
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function atomicWriteJson(
  file: string,
  value: unknown,
  fileOperations: FileOperationProvider,
): Promise<void> {
  await ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await fileOperations.replaceFile(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await fileOperations.removeTemporary(temporary);
    throw error;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function validateDevices(input: unknown): ConfiguredCamera[] {
  if (!Array.isArray(input)) {
    throw new ValidationError("摄像头配置必须是数组。");
  }
  const devices = input.map((value, index): ConfiguredCamera => {
    if (!value || typeof value !== "object") {
      throw new ValidationError(`第 ${index + 1} 个摄像头配置不完整。`);
    }
    const device = value as Partial<ConfiguredCamera>;
    if (
      typeof device.did !== "string" ||
      typeof device.model !== "string" ||
      typeof device.name !== "string" ||
      typeof device.homeId !== "string" ||
      typeof device.homeName !== "string" ||
      !device.did.trim() ||
      !device.model.trim() ||
      !device.name.trim() ||
      !device.homeId.trim() ||
      !device.homeName.trim()
    ) {
      throw new ValidationError(`第 ${index + 1} 个家庭或摄像头配置不完整，请重新选择。`);
    }
    return {
      did: device.did.trim(),
      model: device.model.trim(),
      name: device.name.trim(),
      homeId: device.homeId.trim(),
      homeName: device.homeName.trim(),
    };
  });
  const uniqueDevices = new Set(devices.map((device) => `${device.homeId}\u0000${device.did}`));
  if (uniqueDevices.size !== devices.length) {
    throw new ValidationError("摄像头配置中存在重复设备。");
  }
  const targetDirectories = new Set(
    devices.map((device) =>
      [
        safePathSegment(device.homeName, `家庭-${device.homeId}`),
        safePathSegment(device.name, `摄像头-${device.did}`),
      ]
        .join("\u0000")
        .toLocaleLowerCase("zh-CN"),
    ),
  );
  if (targetDirectories.size !== devices.length) {
    throw new ValidationError(
      "多个摄像头会写入同一目录，请先在米家中设置不同的家庭名称或摄像头名称。",
    );
  }
  return devices;
}

export function validateConfig(input: unknown): AppConfig {
  if (!input || typeof input !== "object") {
    throw new ValidationError("配置必须是 JSON 对象。");
  }
  const candidate = input as ConfigCandidate;
  if (candidate.schemaVersion !== 1) {
    throw new ValidationError("配置 schemaVersion 必须是 1。");
  }
  const storedVideoStorage = candidate.videoStorage ?? "data-share";
  const videoStorage = storedVideoStorage === "accessible-folder"
    ? "data-share"
    : storedVideoStorage;
  if (
    videoStorage !== "data-share" &&
    !(typeof videoStorage === "string" && /^accessible:[a-f0-9]{12}$/u.test(videoStorage))
  ) {
    throw new ValidationError("视频归档目录选项无效。");
  }
  if (!candidate.story || typeof candidate.story !== "object") {
    throw new ValidationError("缺少故事区域和时区配置。");
  }
  const story = candidate.story as { region?: unknown; timezone?: unknown };
  if (story.region !== "CN" || story.timezone !== "Asia/Shanghai") {
    throw new ValidationError("当前版本仅支持 CN 区域和 Asia/Shanghai 时区。");
  }
  if (!candidate.schedule || typeof candidate.schedule !== "object") {
    throw new ValidationError("缺少定时同步配置。");
  }
  const schedule = candidate.schedule as {
    enabled?: unknown;
    time?: unknown;
    timezone?: unknown;
    catchUpOnStart?: unknown;
  };
  if (typeof schedule.enabled !== "boolean") {
    throw new ValidationError("定时同步开关必须是布尔值。");
  }
  if (typeof schedule.time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time)) {
    throw new ValidationError("同步时间必须是 HH:mm 格式。");
  }
  if (schedule.timezone !== "Asia/Shanghai") {
    throw new ValidationError("当前版本仅支持 Asia/Shanghai 时区。");
  }
  if (typeof schedule.catchUpOnStart !== "boolean") {
    throw new ValidationError("启动补偿开关必须是布尔值。");
  }
  const devices = validateDevices(candidate.devices);
  if (schedule.enabled && devices.length === 0) {
    throw new ValidationError("启用定时同步前必须至少添加一个摄像头。");
  }
  return {
    schemaVersion: 1,
    videoStorage: videoStorage as VideoStorage,
    devices,
    story: {
      region: "CN",
      timezone: "Asia/Shanghai",
    },
    schedule: {
      enabled: schedule.enabled,
      time: schedule.time,
      timezone: "Asia/Shanghai",
      catchUpOnStart: schedule.catchUpOnStart,
    },
  };
}

export class ConfigStore {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly fileOperations: FileOperationProvider,
  ) {}

  async load(): Promise<AppConfig> {
    await ensurePrivateDirectory(this.paths.dataDir);
    const stored = await readJson<unknown>(this.paths.configFile);
    if (!stored) {
      const config = defaultConfig();
      await this.save(config);
      return config;
    }
    return validateConfig(stored);
  }

  async save(config: AppConfig): Promise<void> {
    await atomicWriteJson(this.paths.configFile, validateConfig(config), this.fileOperations);
  }
}

export class HistoryStore {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly fileOperations: FileOperationProvider,
    private readonly limit = 50,
  ) {}

  async list(): Promise<SyncRecord[]> {
    const history = await readJson<SyncRecord[]>(this.paths.historyFile);
    return Array.isArray(history) ? history.slice(0, this.limit) : [];
  }

  async prepend(record: SyncRecord): Promise<void> {
    const history = await this.list();
    await atomicWriteJson(
      this.paths.historyFile,
      [record, ...history].slice(0, this.limit),
      this.fileOperations,
    );
  }
}
