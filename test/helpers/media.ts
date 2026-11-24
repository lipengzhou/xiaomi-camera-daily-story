import type { CommandResult, CommandRunner } from "../../src/sync/commands.js";

export function mediaProbeOutput(args: string[]): CommandResult | null {
  if (args[0] === "-version") return { stdout: "media-tool version test\n", stderr: "" };
  if (args.includes("demuxer=hls")) {
    return { stdout: "Demuxer hls\n -extension_picky\n -allowed_segment_extensions\n", stderr: "" };
  }
  if (args.includes("-protocols")) return { stdout: "http\nhttps\ntcp\ntls\ncrypto\npipe\n", stderr: "" };
  return null;
}

export class MediaProbeRunner implements CommandRunner {
  async run(_command: string, args: string[]): Promise<CommandResult> {
    return mediaProbeOutput(args) ?? { stdout: "", stderr: "" };
  }
}
