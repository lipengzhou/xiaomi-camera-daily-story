import { AppError } from "../errors.js";
import type { CommandRunner } from "../sync/commands.js";
import type {
  MediaRuntimeStatus,
  MediaToolProvider,
  MediaTools,
  PlatformIssue,
} from "./types.js";

const REQUIRED_PROTOCOLS = ["http", "https", "tcp", "tls", "crypto", "pipe"];

function firstLine(value: string): string | null {
  return value.split(/\r?\n/u).find((line) => line.trim())?.trim() ?? null;
}

function hasListedValue(output: string, value: string): boolean {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\s*$`, "mu").test(output);
}

export class ContainerMediaToolProvider implements MediaToolProvider {
  constructor(
    private readonly tools: MediaTools,
    readonly status: MediaRuntimeStatus,
  ) {}

  getTools(): MediaTools {
    if (!this.status.available) {
      throw new AppError(
        `运行环境媒体能力不完整：${this.status.missing.join("、")}`,
        "MEDIA_CAPABILITY_UNAVAILABLE",
        503,
      );
    }
    return {
      ffmpeg: this.tools.ffmpeg,
      ffprobe: this.tools.ffprobe,
      hlsInputOptions: [...this.tools.hlsInputOptions],
    };
  }
}

export interface ContainerMediaProbeResult {
  provider: ContainerMediaToolProvider;
  issues: PlatformIssue[];
}

async function probeMediaTools(
  runner: CommandRunner,
  commands: { ffmpeg?: string; ffprobe?: string },
  mode: "local" | "fnos",
): Promise<ContainerMediaProbeResult> {
  const label = mode === "local" ? "本地" : "容器";
  const prefix = mode === "local" ? "LOCAL" : "FNOS";
  const ffmpeg = commands.ffmpeg ?? "ffmpeg";
  const ffprobe = commands.ffprobe ?? "ffprobe";
  try {
    const [ffmpegVersionResult, ffprobeVersionResult, hlsResult, protocolResult] =
      await Promise.all([
        runner.run(ffmpeg, ["-version"]),
        runner.run(ffprobe, ["-version"]),
        runner.run(ffmpeg, ["-hide_banner", "-h", "demuxer=hls"]),
        runner.run(ffmpeg, ["-hide_banner", "-protocols"]),
      ]);
    const hlsOutput = `${hlsResult.stdout}\n${hlsResult.stderr}`;
    const protocolOutput = `${protocolResult.stdout}\n${protocolResult.stderr}`;
    const protocols = REQUIRED_PROTOCOLS.filter((value) => hasListedValue(protocolOutput, value));
    const hlsOptions = ["extension_picky", "allowed_segment_extensions"].filter((value) =>
      hlsOutput.includes(value),
    );
    const hls = /Demuxer hls|Apple HTTP Live Streaming/iu.test(hlsOutput);
    const missing = [
      ...(!hls ? ["HLS demuxer"] : []),
      ...REQUIRED_PROTOCOLS.filter((value) => !protocols.includes(value)).map(
        (value) => `${value} protocol`,
      ),
    ];
    const status: MediaRuntimeStatus = {
      available: missing.length === 0,
      ffmpegVersion: firstLine(ffmpegVersionResult.stdout || ffmpegVersionResult.stderr),
      ffprobeVersion: firstLine(ffprobeVersionResult.stdout || ffprobeVersionResult.stderr),
      hls,
      protocols,
      hlsOptions,
      missing,
    };
    const hlsInputOptions = [
      ...(hlsOptions.includes("extension_picky") ? ["-extension_picky", "0"] : []),
      ...(hlsOptions.includes("allowed_segment_extensions")
        ? ["-allowed_segment_extensions", "ALL"]
        : []),
      "-protocol_whitelist",
      "pipe,http,https,tcp,tls,crypto",
    ];
    const provider = new ContainerMediaToolProvider(
      { ffmpeg, ffprobe, hlsInputOptions },
      status,
    );
    return {
      provider,
      issues: status.available
        ? []
        : [
            {
              code: `${prefix}_MEDIA_CAPABILITY_MISSING`,
              message: `${label} FFmpeg 能力不完整：${missing.join("、")}`,
              blocking: true,
            },
          ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status: MediaRuntimeStatus = {
      available: false,
      ffmpegVersion: null,
      ffprobeVersion: null,
      hls: false,
      protocols: [],
      hlsOptions: [],
      missing: ["ffmpeg", "ffprobe"],
    };
    return {
      provider: new ContainerMediaToolProvider(
        {
          ffmpeg,
          ffprobe,
          hlsInputOptions: ["-protocol_whitelist", "pipe,http,https,tcp,tls,crypto"],
        },
        status,
      ),
      issues: [
        {
          code: `${prefix}_MEDIA_PROBE_FAILED`,
          message: `${label}媒体能力探测失败：${message}`,
          blocking: true,
        },
      ],
    };
  }
}

export function probeContainerMediaTools(
  runner: CommandRunner,
  commands: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<ContainerMediaProbeResult> {
  return probeMediaTools(runner, commands, "fnos");
}

export function probeLocalMediaTools(
  runner: CommandRunner,
  commands: { ffmpeg?: string; ffprobe?: string } = {},
): Promise<ContainerMediaProbeResult> {
  return probeMediaTools(runner, commands, "local");
}
