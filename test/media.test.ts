import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import { createDarwinPlatformServices } from "../src/platform/darwin.js";
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
    if (command.endsWith("ffmpeg")) {
      this.ffmpegCallCount += 1;
      if (this.ffmpegCallCount === this.failFfmpegCall) {
        throw new Error("forced FFmpeg failure");
      }
      await writeFile(args.at(-1)!, "video", { mode: 0o600 });
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

test("media downloader prepends a two-second cover and atomically writes the verified MP4", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-media-test-"));
  try {
    const runner = new FakeRunner();
    const platform = await createDarwinPlatformServices(runner, {
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
    const ffmpegCalls = runner.calls.filter((call) => call.command.endsWith("ffmpeg"));
    assert.equal(ffmpegCalls.length, 3);
    const download = ffmpegCalls[0]!;
    assert.equal(download.args[download.args.indexOf("-i") + 1], "pipe:0");
    assert.equal(download.options?.stdin?.toString("utf8"), "#EXTM3U\n");
    assert.equal(download.args.includes("file,http,https,tcp,tls,crypto"), false);
    assert.deepEqual(download.args.slice(download.args.indexOf("-map"), download.args.indexOf("-c")), [
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
    ]);
    assert.ok(download.args.at(-1)?.endsWith(".source.mp4"));
    assert.equal((await stat(target)).mode & 0o777, 0o600);

    const extract = ffmpegCalls[1]!;
    assert.equal(extract.args[extract.args.indexOf("-ss") + 1], "2");
    assert.equal(extract.args[extract.args.indexOf("-frames:v") + 1], "1");
    assert.ok(extract.args.at(-1)?.endsWith("cover.png"));

    const compose = ffmpegCalls[2]!;
    const filter = compose.args[compose.args.indexOf("-filter_complex") + 1] ?? "";
    assert.match(filter, /trim=duration=2/);
    assert.match(filter, /adelay=2000:all=1/);
    assert.ok(compose.args.includes("libx264"));
    assert.ok(compose.args.includes("creation_time=2026-11-17T23:59:59+08:00"));
    assert.equal(
      runner.calls.filter((call) => call.command.endsWith("ffprobe")).length,
      2,
    );
    const setFile = runner.calls.find((call) => call.command.endsWith("SetFile"));
    assert.deepEqual(setFile?.args.slice(0, 4), [
      "-d",
      "11/17/2026 23:59:59",
      "-m",
      "11/17/2026 23:59:59",
    ]);
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
    const platform = await createDarwinPlatformServices(runner, {
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
    const compose = runner.calls.filter((call) => call.command.endsWith("ffmpeg"))[2]!;
    const filter = compose.args[compose.args.indexOf("-filter_complex") + 1] ?? "";
    assert.doesNotMatch(filter, /adelay/);
    assert.equal(compose.args.includes("[audio]"), false);
    assert.equal(compose.args.includes("-c:a"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media downloader cleans source and partial files when cover extraction fails", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-cover-failure-test-"));
  try {
    const runner = new FakeRunner(true, 2);
    const platform = await createDarwinPlatformServices(runner, {
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
  const platform = await createDarwinPlatformServices(runner, {
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

    await symlink(outside, path.join(videoRoot, "escape"));
    await assert.rejects(
      () =>
        downloader.download(
          Buffer.from("#EXTM3U\n"),
          path.join(videoRoot, "escape", "outside.mp4"),
          "2026-11-17",
        ),
      /符号链接逃逸归档目录/,
    );
    assert.equal(runner.calls.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
