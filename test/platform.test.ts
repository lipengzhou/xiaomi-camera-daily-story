import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import {
  createDarwinPlatformServices,
  createDarwinRuntimePaths,
} from "../src/platform/darwin.js";
import {
  LinuxFileTimeProvider,
  NodeFileOperationProvider,
} from "../src/platform/shared.js";
import type { CommandResult, CommandRunner } from "../src/sync/commands.js";

class NoopRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: "", stderr: "" };
  }
}

test("macOS local runtime resolves explicit private data and video paths", () => {
  const paths = createDarwinRuntimePaths(
    {
      XIAOMI_STORY_CONFIG_DIR: "/tmp/xiaomi-config",
      XIAOMI_STORY_DATA_DIR: "/tmp/xiaomi-data",
      XIAOMI_STORY_DOWNLOAD_ROOT: "/tmp/xiaomi-videos",
    },
    "/Users/tester",
  );
  assert.deepEqual(paths, {
    configDir: "/tmp/xiaomi-config",
    dataDir: "/tmp/xiaomi-data",
    downloadRoot: "/tmp/xiaomi-videos",
    credentialKeyFile: "/tmp/xiaomi-config/credential.key",
    credentialFile: "/tmp/xiaomi-data/credentials.enc",
    configFile: "/tmp/xiaomi-data/config.json",
    historyFile: "/tmp/xiaomi-data/sync-history.json",
  });
});

test("macOS local services expose media tools and capabilities", async () => {
  const services = await createDarwinPlatformServices(new NoopRunner(), {
    architecture: "arm64",
    credentials: new MemoryCredentialStore(),
    environment: {},
    homeDirectory: "/Users/tester",
  });
  assert.equal(services.runtimeMode, "local");
  assert.equal(services.platform, "darwin");
  assert.equal(services.architecture, "arm64");
  assert.equal(
    services.paths.configFile,
    path.join(services.paths.dataDir, "config.json"),
  );
  assert.deepEqual(services.mediaTools.getTools(), {
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
  });
  const capabilities = await services.capabilities();
  assert.deepEqual(Object.keys(capabilities).sort(), [
    "credentials",
    "ffmpeg",
    "ffprobe",
    "fileCreationTime",
    "mediaDownload",
  ]);
  assert.ok(Object.values(capabilities).every((value) => typeof value === "boolean"));
});

test("Linux media providers set mtime and shared file permissions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-linux-media-"));
  const file = path.join(directory, "video.mp4");
  const expected = new Date("2026-11-17T15:59:59.000Z");
  try {
    await writeFile(file, "video", { mode: 0o600 });
    const timeResult = await new LinuxFileTimeProvider().setTimes(file, expected);
    await new NodeFileOperationProvider(0o660).setMediaPermissions(file);
    const result = await stat(file);
    assert.deepEqual(timeResult, {
      creationTimeSupported: false,
      creationTimeSet: false,
      modificationTimeSet: true,
    });
    assert.ok(Math.abs(result.mtimeMs - expected.getTime()) < 1_000);
    assert.equal(result.mode & 0o777, 0o660);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
