import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { ValidationError } from "../src/errors.js";
import { DarwinFileOperationProvider } from "../src/platform/darwin.js";
import type { RuntimePaths } from "../src/platform/types.js";
import { ConfigStore, validateConfig } from "../src/storage.js";

function pathsFor(directory: string): RuntimePaths {
  return {
    configDir: path.join(directory, "private-config"),
    dataDir: path.join(directory, "data"),
    downloadRoot: path.join(directory, "videos"),
    credentialKeyFile: path.join(directory, "private-config", "credential.key"),
    credentialFile: path.join(directory, "data", "credentials.enc"),
    configFile: path.join(directory, "data", "config.json"),
    historyFile: path.join(directory, "data", "history.json"),
  };
}

function config(devices: unknown[] = [], enabled = false): unknown {
  return {
    schemaVersion: 1,
    devices,
    story: { region: "CN", timezone: "Asia/Shanghai" },
    schedule: {
      enabled,
      time: "08:17",
      timezone: "Asia/Shanghai",
      catchUpOnStart: false,
    },
  };
}

test("config validation rejects invalid schemas, cameras, and empty enabled schedules", () => {
  assert.throws(
    () =>
      validateConfig({
        version: 1,
        downloadRoot: "/tmp/videos",
        devices: [],
        schedule: { enabled: false, time: "08:17", timezone: "Asia/Shanghai" },
      }),
    /schemaVersion 必须是 1/,
  );
  assert.throws(() => validateConfig(config([], true)), /至少添加一个摄像头/);
  assert.throws(
    () =>
      validateConfig(
        config([{ did: "1", model: "camera.model", name: "客厅" }]),
      ),
    /家庭或摄像头配置不完整/,
  );
  assert.throws(
    () =>
      validateConfig(
        config([
          { did: "1", model: "camera.model", name: "客厅", homeId: "1", homeName: "家" },
          { did: "1", model: "camera.model", name: "客厅", homeId: "1", homeName: "家" },
        ]),
      ),
    /重复设备/,
  );
  assert.throws(
    () =>
      validateConfig(
        config([
          { did: "1", model: "camera.model", name: "摄像头", homeId: "1", homeName: "家" },
          { did: "2", model: "camera.model", name: "摄像头", homeId: "2", homeName: "家" },
        ]),
      ),
    /写入同一目录/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...(config() as object),
        story: { region: "US", timezone: "Asia/Shanghai" },
      }),
    ValidationError,
  );
  assert.throws(
    () => validateConfig({ ...(config() as object), videoStorage: "host-path" }),
    /视频归档目录选项无效/,
  );
  assert.equal(
    validateConfig({ ...(config() as object), videoStorage: "accessible-folder" }).videoStorage,
    "data-share",
  );
  assert.equal(
    validateConfig({
      ...(config() as object),
      videoStorage: "accessible:123456789abc",
    }).videoStorage,
    "accessible:123456789abc",
  );
});

test("config store writes the private schema without a download path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-config-test-"));
  try {
    const paths = pathsFor(directory);
    const store = new ConfigStore(paths, new DarwinFileOperationProvider());
    const loaded = await store.load();
    const persisted = JSON.parse(await readFile(paths.configFile, "utf8")) as Record<string, unknown>;
    assert.equal(loaded.schemaVersion, 1);
    assert.equal(loaded.videoStorage, "data-share");
    assert.equal(loaded.schedule.catchUpOnStart, false);
    assert.equal((await stat(paths.configFile)).mode & 0o777, 0o600);
    assert.equal(persisted.schemaVersion, 1);
    assert.equal(persisted.videoStorage, "data-share");
    assert.equal("downloadRoot" in persisted, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
