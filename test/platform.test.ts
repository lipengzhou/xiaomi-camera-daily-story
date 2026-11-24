import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import { createLocalPlatformServices, createLocalRuntimePaths } from "../src/platform/local.js";
import { NodeFileTimeProvider, NodeFileOperationProvider } from "../src/platform/shared.js";
import { MediaProbeRunner } from "./helpers/media.js";

test("local runtime uses project-private defaults and resolves configured paths on all desktop platforms", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const root = platform === "win32" ? "C:\\projects\\camera" : "/projects/camera";
    const defaults = createLocalRuntimePaths({}, root, platform);
    assert.equal(defaults.configDir, paths.join(root, ".dev/local/config"));
    assert.equal(defaults.dataDir, paths.join(root, ".dev/local/data"));
    assert.equal(defaults.downloadRoot, paths.join(root, ".dev/local/videos"));
    assert.equal(defaults.credentialFile, paths.join(defaults.dataDir, "credentials.enc"));
    const configured = createLocalRuntimePaths({
      XIAOMI_STORY_CONFIG_DIR: "private/config",
      XIAOMI_STORY_DATA_DIR: "private/data",
      XIAOMI_STORY_DOWNLOAD_ROOT: paths.join(root, "archive"),
    }, root, platform);
    assert.equal(configured.configDir, paths.join(root, "private/config"));
    assert.equal(configured.dataDir, paths.join(root, "private/data"));
    assert.equal(configured.downloadRoot, paths.join(root, "archive"));
  }
});

test("local services find configurable media commands without macOS tools or filesystem birth-time support", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const services = await createLocalPlatformServices(new MediaProbeRunner(), {
      platform,
      credentials: new MemoryCredentialStore(),
      environment: { XIAOMI_STORY_FFMPEG: "custom-ffmpeg", XIAOMI_STORY_FFPROBE: "custom-ffprobe" },
      projectRoot: platform === "win32" ? "C:\\projects\\camera" : "/projects/camera",
    });
    assert.equal(services.runtimeMode, "local");
    assert.equal(services.platform, platform);
    const tools = services.mediaTools.getTools();
    assert.equal(tools.ffmpeg, "custom-ffmpeg");
    assert.equal(tools.ffprobe, "custom-ffprobe");
    assert.ok(tools.hlsInputOptions.includes("-allowed_segment_extensions"));
    const capabilities = await services.capabilities();
    assert.equal(capabilities.mediaDownload, true);
    assert.equal(capabilities.fileCreationTime, false);
  }
});

test("local media provider sets filesystem time through Node on the native platform", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-local-media-"));
  const file = path.join(directory, "video.mp4");
  const expected = new Date("2026-11-17T15:59:59.000Z");
  try {
    await writeFile(file, "video", { mode: 0o600 });
    const timeResult = await new NodeFileTimeProvider().setTimes(file, expected);
    await new NodeFileOperationProvider(0o660).setMediaPermissions(file);
    const result = await stat(file);
    assert.equal(timeResult.modificationTimeSet, true);
    assert.equal(timeResult.creationTimeSet, false);
    assert.ok(Math.abs(result.mtimeMs - expected.getTime()) < 1_000);
    if (process.platform !== "win32") assert.equal(result.mode & 0o777, 0o660);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
