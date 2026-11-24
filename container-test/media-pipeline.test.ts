import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadEnvironmentFiles } from "../src/environment.js";
import { probeContainerMediaTools } from "../src/platform/ffmpeg.js";
import {
  LinuxFileTimeProvider,
  NodeFileOperationProvider,
} from "../src/platform/shared.js";
import { SpawnCommandRunner } from "../src/sync/commands.js";
import { MediaDownloader } from "../src/sync/media.js";

await loadEnvironmentFiles();
const ffmpeg = process.env.XIAOMI_STORY_FFMPEG || "ffmpeg";
const ffprobe = process.env.XIAOMI_STORY_FFPROBE || "ffprobe";

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function frameSimilarity(
  runner: SpawnCommandRunner,
  leftFile: string,
  leftSecond: string,
  rightFile: string,
  rightSecond: string,
): Promise<number> {
  const result = await runner.run(ffmpeg, [
    "-v",
    "info",
    "-ss",
    leftSecond,
    "-i",
    leftFile,
    "-ss",
    rightSecond,
    "-i",
    rightFile,
    "-lavfi",
    "ssim",
    "-frames:v",
    "1",
    "-f",
    "null",
    "-",
  ]);
  const similarity = /All:([0-9.]+)/u.exec(result.stderr)?.[1];
  assert.ok(similarity, "FFmpeg SSIM filter did not return a similarity score");
  return Number(similarity);
}

test("container media pipeline streams HLS and produces a verified shared MP4", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-container-media-"));
  const hlsDirectory = path.join(directory, "hls");
  const videoRoot = path.join(directory, "videos");
  const source = path.join(directory, "source.mp4");
  const playlistFile = path.join(hlsDirectory, "playlist.m3u8");
  const target = path.join(videoRoot, "家庭", "摄像头", "2026", "11", "output.mp4");
  const runner = new SpawnCommandRunner();
  let segmentRequests = 0;
  let server: Server | null = null;
  try {
    await mkdir(hlsDirectory, { recursive: true });
    await runner.run(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x180:rate=30",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000",
      "-t",
      "4",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-keyint_min",
      "30",
      "-sc_threshold",
      "0",
      "-c:a",
      "aac",
      source,
    ]);
    await runner.run(ffmpeg, [
      "-y",
      "-v",
      "error",
      "-i",
      source,
      "-c",
      "copy",
      "-hls_time",
      "1",
      "-hls_list_size",
      "0",
      "-hls_segment_filename",
      path.join(hlsDirectory, "segment%03d.ts"),
      playlistFile,
    ]);

    server = createServer((request, response) => {
      const name = path.basename(new URL(request.url ?? "/", "http://localhost").pathname);
      if (!/^segment\d+\.ts$/u.test(name)) {
        response.writeHead(404).end();
        return;
      }
      segmentRequests += 1;
      void readFile(path.join(hlsDirectory, name))
        .then((contents) => response.writeHead(200, { "Content-Type": "video/mp2t" }).end(contents))
        .catch(() => response.writeHead(404).end());
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const playlist = (await readFile(playlistFile, "utf8"))
      .split(/\r?\n/u)
      .map((line) =>
        line && !line.startsWith("#")
          ? `http://127.0.0.1:${address.port}/${path.basename(line)}`
          : line,
      )
      .join("\n");

    const media = await probeContainerMediaTools(runner, { ffmpeg, ffprobe });
    assert.equal(media.provider.status.available, true, media.issues[0]?.message);
    await new MediaDownloader(
      runner,
      media.provider,
      new LinuxFileTimeProvider(),
      new NodeFileOperationProvider(0o660),
      videoRoot,
    ).download(Buffer.from(playlist), target, "2026-11-17");

    const outputStat = await stat(target);
    assert.ok(outputStat.size > 0);
    if (process.platform !== "win32") assert.equal(outputStat.mode & 0o777, 0o660);
    assert.ok(Math.abs(outputStat.mtimeMs - Date.parse("2026-11-17T15:59:59Z")) < 1_000);
    assert.ok(segmentRequests > 0);

    const probe = await runner.run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_name,codec_type",
      "-of",
      "json",
      target,
    ]);
    const mediaInfo = JSON.parse(probe.stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_name?: string; codec_type?: string }>;
    };
    const duration = Number(mediaInfo.format?.duration);
    assert.ok(duration >= 3.5 && duration <= 4.5, `unexpected duration ${duration}`);
    assert.ok(mediaInfo.streams?.some((stream) => stream.codec_name === "h264"));
    assert.ok(mediaInfo.streams?.some((stream) => stream.codec_name === "aac"));

    const firstFrameSimilarity = await frameSimilarity(
      runner,
      target,
      "0.5",
      source,
      "0.5",
    );
    assert.ok(
      firstFrameSimilarity >= 0.95,
      `first frame does not match source: ${firstFrameSimilarity}`,
    );
    const laterFrameSimilarity = await frameSimilarity(
      runner,
      target,
      "3",
      source,
      "3",
    );
    assert.ok(
      laterFrameSimilarity >= 0.95,
      `later frame does not match source: ${laterFrameSimilarity}`,
    );

    const silence = await runner.run(ffmpeg, [
      "-v",
      "info",
      "-i",
      target,
      "-af",
      "silencedetect=noise=-40dB:d=0.2",
      "-f",
      "null",
      "-",
    ]);
    assert.doesNotMatch(silence.stderr, /silence_start/u, "audio should start immediately");

    assert.deepEqual(
      (await readdir(path.dirname(target))).filter(
        (name) => name.includes(".source.mp4") || name.includes(".partial.mp4"),
      ),
      [],
    );
  } finally {
    if (server) {
      await closeServer(server);
    }
    await rm(directory, { recursive: true, force: true });
  }
});
