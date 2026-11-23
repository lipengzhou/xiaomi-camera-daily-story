import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { ConfigStore, HistoryStore } from "../storage.js";
import { AppError, SyncBusyError, ValidationError } from "../errors.js";
import type {
  AppConfig,
  ConfiguredCamera,
  DailyStory,
  SyncFileResult,
  SyncRecord,
  SyncRuntimeState,
  SyncTrigger,
  XiaomiSession,
} from "../types.js";
import { XiaomiCloudClient } from "../xiaomi/cloud.js";
import type { SessionProvider } from "../xiaomi/auth.js";
import { compactDate, storyDateFromCreateTime } from "./date.js";
import type { MediaDownloader } from "./media.js";
import { safePathSegment } from "./path.js";

export { safePathSegment } from "./path.js";

async function existsAndNonEmpty(file: string): Promise<boolean> {
  try {
    const result = await stat(file);
    return result.isFile() && result.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function targetFor(
  downloadRoot: string,
  device: ConfiguredCamera,
  story: DailyStory,
): { date: string; file: string } {
  const date = storyDateFromCreateTime(story.createTime);
  const [year, month] = date.split("-");
  return {
    date,
    file: path.join(
      downloadRoot,
      safePathSegment(device.homeName, `家庭-${device.homeId}`),
      safePathSegment(device.name, `摄像头-${device.did}`),
      year ?? "unknown",
      month ?? "unknown",
      `XIAOMI_CAMRA4_${compactDate(date)}.mp4`,
    ),
  };
}

export type CloudFactory = (session: XiaomiSession) => XiaomiCloudClient;
export type DownloadRootResolver =
  | string
  | ((config: AppConfig) => string | Promise<string>);

export class SyncService {
  private state: SyncRuntimeState = {
    running: false,
    trigger: null,
    startedAt: null,
    currentFile: null,
    completed: 0,
    total: 0,
    lastRecord: null,
  };

  constructor(
    private readonly configStore: ConfigStore,
    private readonly historyStore: HistoryStore,
    private readonly sessions: SessionProvider,
    private readonly downloader: MediaDownloader,
    private readonly downloadRoot: DownloadRootResolver,
    private readonly cloudFactory: CloudFactory = (session) => new XiaomiCloudClient(session),
  ) {}

  getState(): SyncRuntimeState {
    return structuredClone(this.state);
  }

  async run(trigger: SyncTrigger): Promise<SyncRecord> {
    if (this.state.running) {
      throw new SyncBusyError();
    }
    const started = new Date();
    this.state = {
      running: true,
      trigger,
      startedAt: started.toISOString(),
      currentFile: null,
      completed: 0,
      total: 0,
      lastRecord: this.state.lastRecord,
    };
    const files: SyncFileResult[] = [];
    try {
      const config = await this.configStore.load();
      const downloadRoot = typeof this.downloadRoot === "function"
        ? await this.downloadRoot(config)
        : this.downloadRoot;
      if (config.devices.length === 0) {
        throw new ValidationError("请先扫码登录并至少添加一个要同步的摄像头。");
      }
      const plans: Array<{
        device: ConfiguredCamera;
        story: DailyStory;
        date: string;
        file: string;
      }> = [];
      for (const device of config.devices) {
        try {
          const stories = await this.sessions.run((session) =>
            this.cloudFactory(session).listDailyStories(device),
          );
          plans.push(
            ...stories
              .filter((story) => story.fileId && Number.isFinite(story.createTime))
              .map((story) => ({
                device,
                story,
                ...targetFor(downloadRoot, device, story),
              })),
          );
        } catch (error) {
          files.push({
            date: "",
            fileId: "",
            path: path.join(
              downloadRoot,
              safePathSegment(device.homeName, `家庭-${device.homeId}`),
              safePathSegment(device.name, `摄像头-${device.did}`),
            ),
            status: "failed",
            message: `${device.homeName} / ${device.name}：${
              error instanceof Error ? error.message : "读取每日故事失败"
            }`,
          });
        }
      }
      plans.sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.device.homeName.localeCompare(right.device.homeName, "zh-CN") ||
          left.device.name.localeCompare(right.device.name, "zh-CN"),
      );
      this.state.total = plans.length + files.length;
      this.state.completed = files.length;

      for (const plan of plans) {
        this.state.currentFile = `${plan.device.name} / ${path.basename(plan.file)}`;
        if (await existsAndNonEmpty(plan.file)) {
          files.push({
            date: plan.date,
            fileId: plan.story.fileId,
            path: plan.file,
            status: "skipped",
          });
          this.state.completed += 1;
          continue;
        }
        try {
          const playlist = await this.sessions.run((session) =>
            this.cloudFactory(session).getDailyStoryPlaylist(plan.device, plan.story.fileId),
          );
          await this.downloader.download(playlist, plan.file, plan.date);
          files.push({
            date: plan.date,
            fileId: plan.story.fileId,
            path: plan.file,
            status: "downloaded",
          });
        } catch (error) {
          files.push({
            date: plan.date,
            fileId: plan.story.fileId,
            path: plan.file,
            status: "failed",
            message: error instanceof Error ? error.message : "未知下载错误",
          });
        }
        this.state.completed += 1;
      }

      const failed = files.filter((file) => file.status === "failed").length;
      const record: SyncRecord = {
        id: randomUUID(),
        trigger,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        status: failed === 0 ? "success" : failed === files.length ? "failed" : "partial",
        downloaded: files.filter((file) => file.status === "downloaded").length,
        skipped: files.filter((file) => file.status === "skipped").length,
        failed,
        files,
      };
      await this.historyStore.prepend(record);
      this.state.lastRecord = record;
      return record;
    } catch (error) {
      const record: SyncRecord = {
        id: randomUUID(),
        trigger,
        startedAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed",
        downloaded: 0,
        skipped: 0,
        failed: Math.max(1, files.filter((file) => file.status === "failed").length),
        files,
        message: error instanceof Error ? error.message : "未知同步错误",
      };
      await this.historyStore.prepend(record);
      this.state.lastRecord = record;
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(record.message ?? "同步失败", "SYNC_FAILED", 500);
    } finally {
      this.state.running = false;
      this.state.trigger = null;
      this.state.currentFile = null;
    }
  }
}
