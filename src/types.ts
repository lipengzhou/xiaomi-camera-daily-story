export interface XiaomiSession {
  userId: string;
  cUserId: string;
  passToken: string;
  ssecurity: string;
  serviceToken: string;
  userAgent: string;
  createdAt: number;
  refreshedAt: number;
}

export interface CameraDevice {
  did: string;
  model: string;
  name: string;
  homeId: string;
  homeName: string;
  ownerId: string;
}

export type ConfiguredCamera = Pick<
  CameraDevice,
  "did" | "model" | "name" | "homeId" | "homeName"
>;

export interface DailyStory {
  fileId: string;
  createTime: number;
  duration?: number;
  expireTime?: number;
  category?: number;
}

export type VideoStorage = "data-share" | `accessible:${string}`;

export interface AppConfig {
  schemaVersion: 1;
  videoStorage: VideoStorage;
  devices: ConfiguredCamera[];
  story: {
    region: "CN";
    timezone: "Asia/Shanghai";
  };
  schedule: {
    enabled: boolean;
    time: string;
    timezone: "Asia/Shanghai";
    catchUpOnStart: boolean;
  };
}

export type SyncTrigger = "manual" | "schedule";

export interface SyncFileResult {
  date: string;
  fileId: string;
  path: string;
  status: "downloaded" | "skipped" | "failed";
  message?: string;
}

export interface SyncRecord {
  id: string;
  trigger: SyncTrigger;
  startedAt: string;
  finishedAt: string;
  status: "success" | "partial" | "failed";
  downloaded: number;
  skipped: number;
  failed: number;
  files: SyncFileResult[];
  message?: string;
}

export interface SyncRuntimeState {
  running: boolean;
  trigger: SyncTrigger | null;
  startedAt: string | null;
  currentFile: string | null;
  completed: number;
  total: number;
  lastRecord: SyncRecord | null;
}
