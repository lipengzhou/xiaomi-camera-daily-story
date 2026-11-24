import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import { createLocalPlatformServices } from "../src/platform/local.js";
import { mediaProbeOutput } from "./helpers/media.js";
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from "../src/sync/commands.js";
import { MediaDownloader } from "../src/sync/media.js";

class FakeRunner implements CommandRunner {
  calls: Array<{ command: string; args: string[]; options?: CommandOptions }> = [];
  private ffmpegCallCount = 0;

  constructor(
    private readonly includeAudio = true,
    private readonly failFfmpegCall: number | null = null,
  ) {}

  async run(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, ...(options ? { options } : {}) });
    const probeOutput = mediaProbeOutput(args);
    if (probeOutput) return probeOutput;
    if (command.endsWith("ffmpeg")) {
      this.ffmpegCallCount += 1;
      await writeFile(args.at(-1)!, "video", { mode: 0o600 });
      if (this.ffmpegCallCount === this.failFfmpegCall) {
        throw new Error("forced FFmpeg failure");
      }
    }
    if (command.endsWith("ffprobe")) {
      return {
        stdout: JSON.stringify({
          streams: [
            { codec_type: "video", tags: { creation_time: "2026-11-17T15:59:59.000000Z" } },
            ...(this.includeAudio
              ? [
                  {
                    codec_type: "audio",
                    tags: { creation_time: "2026-11-17T15:59:59.000000Z" },
                  },
                ]
              : []),
          ],
          format: { tags: { creation_time: "2026-11-17T15:59:59.000000Z" } },
        }),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  }
}

test("media downloader remuxes HLS into a verified MP4 without a cover", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-media-test-"));
  try {
    const runner = new FakeRunner();
    const platform = await createLocalPlatformServices(runner, {
      credentials: new MemoryCredentialStore(),
    });
    const target = path.join(directory, "2026", "11", "XIAOMI_CAMRA4_20261117.mp4");
    await new MediaDownloader(
      runner,
      platform.mediaTools,
      platform.fileTimes,
      platform.fileOperations,
      [path.join(directory, "unused-root"), directory],
    ).download(Buffer.from("#EXTM3U\n"), target, "2026-11-17");
    assert.equal(await readFile(target, "utf8"), "video");
    const ffmpegCalls = runner.calls.filter((call) => call.command.endsWith("ffmpeg") && call.args.includes("-i"));
    assert.equal(ffmpegCalls.length, 1);
    const remux = ffmpegCalls[0]!;
    assert.equal(remux.args[remux.args.indexOf("-f") + 1], "hls");
    assert.equal(remux.args[remux.args.indexOf("-i") + 1], "pipe:0");
    assert.equal(remux.options?.stdin?.toString("utf8"), "#EXTM3U\n");
    assert.equal(remux.args.includes("file,http,https,tcp,tls,crypto"), false);
    assert.deepEqual(
      remux.args.slice(remux.args.indexOf("-map"), remux.args.indexOf("-c")),
      ["-map", "0:v:0", "-map", "0:a:0?"],
    );
    assert.equal(remux.args[remux.args.indexOf("-c") + 1], "copy");
    assert.equal(remux.args.includes("-vf"), false);
    assert.equal(remux.args.includes("-af"), false);
    assert.ok(remux.args.includes("creation_time=2026-11-17T23:59:59+08:00"));
    assert.ok(remux.args.at(-1)?.endsWith(".partial.mp4"));
    if (process.platform !== "win32") assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.equal(
      runner.calls.filter((call) => call.command.endsWith("ffprobe") && call.args.includes("-show_entries")).length,
      1,
    );
    assert.ok(Math.abs((await stat(target)).mtimeMs - Date.parse("2026-11-17T15:59:59Z")) < 1_000);
    assert.deepEqual(
      (await readdir(path.dirname(target))).filter(
        (name) => name.includes(".source.mp4") || name.includes(".partial.mp4"),
      ),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media downloader supports videos without an audio stream", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-silent-media-test-"));
  try {
    const runner = new FakeRunner(false);
    const platform = await createLocalPlatformServices(runner, {
      credentials: new MemoryCredentialStore(),
    });
    const target = path.join(directory, "silent.mp4");
    await new MediaDownloader(
      runner,
      platform.mediaTools,
      platform.fileTimes,
      platform.fileOperations,
      directory,
    ).download(Buffer.from("#EXTM3U\n"), target, "2026-11-17");
    assert.equal(await readFile(target, "utf8"), "video");
    const remux = runner.calls.find((call) => call.command.endsWith("ffmpeg") && call.args.includes("-i"))!;
    assert.ok(remux.args.includes("0:a:0?"));
    assert.equal(remux.args[remux.args.indexOf("-c") + 1], "copy");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media downloader cleans partial files when remuxing fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-partial-failure-test-"));
  try {
    const runner = new FakeRunner(true, 1);
    const platform = await createLocalPlatformServices(runner, {
      credentials: new MemoryCredentialStore(),
    });
    const target = path.join(directory, "failed.mp4");
    await assert.rejects(
      new MediaDownloader(
        runner,
        platform.mediaTools,
        platform.fileTimes,
        platform.fileOperations,
        directory,
      ).download(Buffer.from("#EXTM3U\n"), target, "2026-11-17"),
      /forced FFmpeg failure/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media downloader rejects lexical and symlink escapes from the video root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-media-root-test-"));
  const videoRoot = path.join(directory, "videos");
  const outside = path.join(directory, "outside");
  await Promise.all([
    mkdir(videoRoot, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  const runner = new FakeRunner();
  const platform = await createLocalPlatformServices(runner, {
    credentials: new MemoryCredentialStore(),
  });
  const downloader = new MediaDownloader(
    runner,
    platform.mediaTools,
    platform.fileTimes,
    platform.fileOperations,
    videoRoot,
  );
  try {
    await assert.rejects(
      () =>
        downloader.download(
          Buffer.from("#EXTM3U\n"),
          path.join(directory, "outside.mp4"),
          "2026-11-17",
        ),
      /超出运行环境声明的归档目录/,
    );

    await symlink(outside, path.join(videoRoot, "escape"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      () =>
        downloader.download(
          Buffer.from("#EXTM3U\n"),
          path.join(videoRoot, "escape", "outside.mp4"),
          "2026-11-17",
        ),
      /符号链接逃逸归档目录/,
    );
    assert.equal(runner.calls.some((call) => call.args.includes("-i")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
