import { chmod, mkdir, mkdtemp, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { AppError } from "../errors.js";
import type {
  FileOperationProvider,
  FileTimeProvider,
  MediaToolProvider,
} from "../platform/types.js";
import { creationTime, expectedUtcCreationTime } from "./date.js";
import type { CommandRunner } from "./commands.js";

interface ProbeStream {
  codec_type?: string;
  tags?: { creation_time?: string };
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { tags?: { creation_time?: string } };
}

const COVER_SOURCE_SECOND = 2;
const COVER_DURATION_SECONDS = 2;
const OUTPUT_FRAME_RATE = 30;

export class MediaDownloader {
  private downloadRoots: string[];

  constructor(
    private readonly runner: CommandRunner,
    private readonly mediaTools: MediaToolProvider,
    private readonly fileTimes: FileTimeProvider,
    private readonly fileOperations: FileOperationProvider,
    downloadRoots: string | readonly string[],
  ) {
    this.downloadRoots = [];
    this.setDownloadRoots(downloadRoots);
  }

  setDownloadRoots(downloadRoots: string | readonly string[]): void {
    const nextRoots = (Array.isArray(downloadRoots) ? downloadRoots : [downloadRoots])
      .map((root) => path.resolve(root));
    if (nextRoots.length === 0) {
      throw new Error("至少需要一个视频归档根目录。");
    }
    this.downloadRoots = nextRoots;
  }

  async download(playlist: Buffer, target: string, date: string): Promise<void> {
    const targetDirectory = await this.prepareTargetDirectory(target);
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-daily-story-"));
    await chmod(temporaryDirectory, 0o700);
    const coverFile = path.join(temporaryDirectory, "cover.png");
    const sourceFile = path.join(
      targetDirectory,
      `.${path.basename(target, ".mp4")}.${process.pid}.source.mp4`,
    );
    const partialFile = path.join(
      targetDirectory,
      `.${path.basename(target, ".mp4")}.${process.pid}.partial.mp4`,
    );
    try {
      const tools = this.mediaTools.getTools();
      const metadataTime = creationTime(date);

      // First preserve the Xiaomi HLS media in a local MP4. The next stages need random access
      // to capture a frame and prepend it to the final video.
      await this.runner.run(
        tools.ffmpeg,
        [
          "-y",
          "-nostdin",
          "-v",
          "error",
          ...tools.hlsInputOptions,
          "-i",
          "pipe:0",
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          sourceFile,
        ],
        { stdin: playlist },
      );
      await this.requireNonEmpty(
        sourceFile,
        "FFmpeg 生成了空的原始视频文件。",
        "EMPTY_SOURCE_VIDEO",
      );

      await this.runner.run(tools.ffmpeg, [
        "-y",
        "-nostdin",
        "-v",
        "error",
        "-ss",
        String(COVER_SOURCE_SECOND),
        "-i",
        sourceFile,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        coverFile,
      ]);
      await this.requireNonEmpty(coverFile, "无法截取视频第 2 秒画面。", "COVER_FRAME_FAILED");

      const hasAudio = await this.hasAudio(sourceFile, tools.ffprobe);
      const filter = [
        `[0:v]trim=duration=${COVER_DURATION_SECONDS},setpts=PTS-STARTPTS,fps=${OUTPUT_FRAME_RATE},format=yuv420p,setsar=1[cover]`,
        `[1:v]setpts=PTS-STARTPTS,fps=${OUTPUT_FRAME_RATE},format=yuv420p,setsar=1[main]`,
        "[cover][main]concat=n=2:v=1:a=0[video]",
        ...(hasAudio
          ? [
              `[1:a]adelay=${COVER_DURATION_SECONDS * 1000}:all=1,asetpts=PTS-STARTPTS[audio]`,
            ]
          : []),
      ].join(";");
      const composeArguments = [
        "-y",
        "-nostdin",
        "-v",
        "error",
        "-loop",
        "1",
        "-framerate",
        String(OUTPUT_FRAME_RATE),
        "-i",
        coverFile,
        "-i",
        sourceFile,
        "-filter_complex",
        filter,
        "-map",
        "[video]",
      ];
      if (hasAudio) {
        composeArguments.push("-map", "[audio]");
      }
      composeArguments.push(
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
      );
      if (hasAudio) {
        composeArguments.push("-c:a", "aac", "-b:a", "128k");
      }
      composeArguments.push(
        "-metadata",
        `creation_time=${metadataTime}`,
        "-metadata:s",
        `creation_time=${metadataTime}`,
        "-movflags",
        "+faststart",
        partialFile,
      );
      await this.runner.run(tools.ffmpeg, composeArguments);
      await this.requireNonEmpty(partialFile, "FFmpeg 生成了空视频文件。", "EMPTY_VIDEO");
      await this.fileTimes.setTimes(partialFile, new Date(metadataTime));
      await this.verify(partialFile, date, tools.ffprobe);
      await this.fileOperations.setMediaPermissions(partialFile);
      await this.fileOperations.replaceFile(partialFile, target);
    } finally {
      await this.fileOperations.removeTemporary(partialFile);
      await this.fileOperations.removeTemporary(sourceFile);
      await this.fileOperations.removeTemporary(temporaryDirectory);
    }
  }

  private async prepareTargetDirectory(target: string): Promise<string> {
    const resolvedTarget = path.resolve(target);
    const root = this.downloadRoots.find((candidate) =>
      this.isWithinRoot(candidate, resolvedTarget),
    );
    if (!root) {
      throw new AppError(
        "视频目标路径超出运行环境声明的归档目录。",
        "VIDEO_PATH_OUTSIDE_ROOT",
        400,
      );
    }
    const targetDirectory = path.dirname(resolvedTarget);
    await mkdir(targetDirectory, { recursive: true, mode: 0o755 });
    const [realRoot, realTargetDirectory] = await Promise.all([
      realpath(root),
      realpath(targetDirectory),
    ]);
    if (!this.isWithinRoot(realRoot, realTargetDirectory)) {
      throw new AppError(
        "视频目标目录通过符号链接逃逸归档目录。",
        "VIDEO_PATH_OUTSIDE_ROOT",
        400,
      );
    }
    return targetDirectory;
  }

  private isWithinRoot(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
  }

  private async requireNonEmpty(file: string, message: string, code: string): Promise<void> {
    try {
      const result = await stat(file);
      if (result.isFile() && result.size > 0) {
        return;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    throw new AppError(message, code, 502);
  }

  private async hasAudio(file: string, ffprobe: string): Promise<boolean> {
    const result = await this.runner.run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "json",
      file,
    ]);
    const probe = JSON.parse(result.stdout) as ProbeResult;
    return (probe.streams ?? []).some((stream) => stream.codec_type === "audio");
  }

  private async verify(file: string, date: string, ffprobe: string): Promise<void> {
    const result = await this.runner.run(ffprobe, [
      "-v",
      "error",
      "-show_entries",
      "format_tags=creation_time:stream=codec_type:stream_tags=creation_time",
      "-of",
      "json",
      file,
    ]);
    const probe = JSON.parse(result.stdout) as ProbeResult;
    const expected = expectedUtcCreationTime(date);
    if (probe.format?.tags?.creation_time !== expected) {
      throw new AppError("MP4 容器拍摄时间校验失败。", "METADATA_VERIFY_FAILED", 502);
    }
    const streamTypes = new Set<string>();
    for (const stream of probe.streams ?? []) {
      if (stream.codec_type) {
        streamTypes.add(stream.codec_type);
      }
      if (stream.tags?.creation_time !== expected) {
        throw new AppError("MP4 轨道拍摄时间校验失败。", "METADATA_VERIFY_FAILED", 502);
      }
    }
    if (!streamTypes.has("video")) {
      throw new AppError("下载文件缺少视频轨。", "VIDEO_VERIFY_FAILED", 502);
    }
  }
}
