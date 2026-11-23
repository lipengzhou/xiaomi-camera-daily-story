import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import { DarwinFileOperationProvider } from "../src/platform/darwin.js";
import { ConfigStore, HistoryStore } from "../src/storage.js";
import type { MediaDownloader } from "../src/sync/media.js";
import { safePathSegment, SyncService } from "../src/sync/service.js";
import type { XiaomiSession } from "../src/types.js";
import { SessionProvider } from "../src/xiaomi/auth.js";
import type { XiaomiCloudClient } from "../src/xiaomi/cloud.js";

const session: XiaomiSession = {
  userId: "1",
  cUserId: "2",
  passToken: "pass",
  ssecurity: "MDEyMzQ1Njc4OWFiY2RlZg==",
  serviceToken: "service",
  userAgent: "test",
  createdAt: 1,
  refreshedAt: 1,
};

test("sync processes configured cameras across homes and skips existing targets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-sync-test-"));
  try {
    const paths = {
      configDir: path.join(directory, "config"),
      dataDir: path.join(directory, "data"),
      downloadRoot: path.join(directory, "downloads"),
      credentialKeyFile: path.join(directory, "config", "credential.key"),
      credentialFile: path.join(directory, "data", "credentials.enc"),
      configFile: path.join(directory, "data", "config.json"),
      historyFile: path.join(directory, "data", "history.json"),
    };
    const downloadRoot = paths.downloadRoot;
    const existingDirectory = path.join(downloadRoot, "温馨的家", "客厅摄像头", "2026", "11");
    const existingTarget = path.join(existingDirectory, "XIAOMI_CAMRA4_20261117.mp4");
    const secondTarget = path.join(
      downloadRoot,
      "父母家",
      "门口摄像头",
      "2026",
      "11",
      "XIAOMI_CAMRA4_20261117.mp4",
    );
    await mkdir(existingDirectory, { recursive: true });
    await writeFile(existingTarget, "existing");

    const fileOperations = new DarwinFileOperationProvider();
    const configStore = new ConfigStore(paths, fileOperations);
    await configStore.save({
      schemaVersion: 1,
      devices: [
        {
          did: "camera-1",
          model: "chuangmi.camera.079ac1",
          name: "客厅摄像头",
          homeId: "101",
          homeName: "温馨的家",
        },
        {
          did: "camera-2",
          model: "chuangmi.camera.079ac1",
          name: "门口摄像头",
          homeId: "202",
          homeName: "父母家",
        },
        {
          did: "camera-broken",
          model: "chuangmi.camera.079ac1",
          name: "书房摄像头",
          homeId: "202",
          homeName: "父母家",
        },
      ],
      story: { region: "CN", timezone: "Asia/Shanghai" },
      schedule: {
        enabled: false,
        time: "08:17",
        timezone: "Asia/Shanghai",
        catchUpOnStart: false,
      },
    });
    const credentials = new MemoryCredentialStore();
    await credentials.set(session);
    let playlistCalls = 0;
    let downloadCalls = 0;
    const listedDevices: string[] = [];
    const playlistDevices: string[] = [];
    const downloadTargets: string[] = [];
    const fakeCloud = {
      listDailyStories: async (device: { did: string }) => {
        listedDevices.push(device.did);
        if (device.did === "camera-broken") {
          throw new Error("设备离线");
        }
        return [{ fileId: `story-${device.did}`, createTime: 1_794_956_975_950 }];
      },
      getDailyStoryPlaylist: async (device: { did: string }) => {
        playlistCalls += 1;
        playlistDevices.push(device.did);
        return Buffer.from("#EXTM3U\n");
      },
    } as unknown as XiaomiCloudClient;
    const fakeDownloader = {
      download: async (_playlist: Buffer, target: string) => {
        downloadCalls += 1;
        downloadTargets.push(target);
      },
    } as unknown as MediaDownloader;
    const history = new HistoryStore(paths, fileOperations);
    const service = new SyncService(
      configStore,
      history,
      new SessionProvider(credentials),
      fakeDownloader,
      (loadedConfig) => {
        assert.equal(loadedConfig.videoStorage, "data-share");
        return downloadRoot;
      },
      () => fakeCloud,
    );

    const result = await service.run("manual");
    assert.equal(result.status, "partial");
    assert.equal(result.skipped, 1);
    assert.equal(result.downloaded, 1);
    assert.equal(result.failed, 1);
    assert.deepEqual(listedDevices, ["camera-1", "camera-2", "camera-broken"]);
    assert.equal(playlistCalls, 1);
    assert.deepEqual(playlistDevices, ["camera-2"]);
    assert.equal(downloadCalls, 1);
    assert.deepEqual(downloadTargets, [secondTarget]);
    assert.equal((await history.list())[0]?.skipped, 1);
    assert.match(result.files.find((file) => file.status === "failed")?.message ?? "", /设备离线/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("family and camera names are safe path segments", () => {
  assert.equal(safePathSegment(" 我的/家庭 ", "家庭-1"), "我的_家庭");
  assert.equal(safePathSegment("../摄像头", "摄像头-1"), ".._摄像头");
  assert.equal(safePathSegment("..", "摄像头-1"), "摄像头-1");
  assert.equal(safePathSegment("..", "家庭-../1"), "家庭-.._1");
  assert.equal(safePathSegment("CON", "摄像头-1"), "_CON");
});
