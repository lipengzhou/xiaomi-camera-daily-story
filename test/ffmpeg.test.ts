import assert from "node:assert/strict";
import { test } from "node:test";

import { probeContainerMediaTools } from "../src/platform/ffmpeg.js";
import type { CommandResult, CommandRunner } from "../src/sync/commands.js";

class ProbeRunner implements CommandRunner {
  constructor(
    private readonly protocols = ["http", "https", "tcp", "tls", "crypto", "pipe"],
    private readonly encoders = ["libx264", "aac", "png"],
    private readonly hlsOptions = ["extension_picky", "allowed_segment_extensions"],
  ) {}

  async run(command: string, args: string[]): Promise<CommandResult> {
    if (args[0] === "-version") {
      return { stdout: `${command} version test-1.0\n`, stderr: "" };
    }
    if (args.includes("demuxer=hls")) {
      return {
        stdout: [
          "Demuxer hls [Apple HTTP Live Streaming]:",
          ...this.hlsOptions.map((option) => `  -${option} <boolean>`),
        ].join("\n"),
        stderr: "",
      };
    }
    if (args.includes("-protocols")) {
      return { stdout: this.protocols.map((value) => `  ${value}`).join("\n"), stderr: "" };
    }
    if (args.includes("-encoders")) {
      return {
        stdout: this.encoders
          .map((value) => ` V..... ${value} test encoder`)
          .join("\n"),
        stderr: "",
      };
    }
    return { stdout: "", stderr: "" };
  }
}

test("container media probe detects required tools and optional HLS arguments", async () => {
  const result = await probeContainerMediaTools(new ProbeRunner());
  assert.equal(result.provider.status.available, true);
  assert.deepEqual(result.provider.status.protocols, [
    "http",
    "https",
    "tcp",
    "tls",
    "crypto",
    "pipe",
  ]);
  assert.deepEqual(result.provider.status.encoders, ["libx264", "aac", "png"]);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.provider.getTools().hlsInputOptions, [
    "-extension_picky",
    "0",
    "-allowed_segment_extensions",
    "ALL",
    "-protocol_whitelist",
    "pipe,http,https,tcp,tls,crypto",
  ]);
});

test("container media probe omits unsupported optional HLS arguments", async () => {
  const result = await probeContainerMediaTools(
    new ProbeRunner(
      ["http", "https", "tcp", "tls", "crypto", "pipe"],
      ["libx264", "aac", "png"],
      [],
    ),
  );
  assert.equal(result.provider.status.available, true);
  assert.deepEqual(result.provider.getTools().hlsInputOptions, [
    "-protocol_whitelist",
    "pipe,http,https,tcp,tls,crypto",
  ]);
});

test("container media probe blocks downloads when required capabilities are missing", async () => {
  const result = await probeContainerMediaTools(
    new ProbeRunner(["http", "https", "pipe"], ["aac", "png"]),
  );
  assert.equal(result.provider.status.available, false);
  assert.match(result.issues[0]?.message ?? "", /tcp protocol/);
  assert.match(result.issues[0]?.message ?? "", /libx264 encoder/);
  assert.throws(() => result.provider.getTools(), /媒体能力不完整/);
});
