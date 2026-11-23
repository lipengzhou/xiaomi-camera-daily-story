import { spawn } from "node:child_process";

import { AppError } from "../errors.js";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  stdin?: Buffer;
}

export interface CommandRunner {
  run(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;
}

export function redactCommandOutput(value: string): string {
  return value
    .replace(/(https?:\/\/[^?\s]+)\?\S+/giu, "$1?<redacted>")
    .replace(
      /(yetAnotherServiceToken|serviceToken|token|signature|nonce)=([^\s,&}]*)/giu,
      "$1=<redacted>",
    );
}

export class SpawnCommandRunner implements CommandRunner {
  async run(
    command: string,
    args: string[],
    options: CommandOptions = {},
  ): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        stdio: [options.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const fail = (error: unknown): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      const append = (existing: string, chunk: Buffer): string =>
        `${existing}${chunk.toString("utf8")}`.slice(-64 * 1024);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once("error", fail);
      if (options.stdin && child.stdin) {
        child.stdin.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code !== "EPIPE") {
            child.kill();
            fail(
              new AppError(
                `${command} 标准输入写入失败：${redactCommandOutput(error.message)}`,
                "COMMAND_STDIN_FAILED",
                502,
              ),
            );
          }
        });
        child.stdin.end(options.stdin);
      }
      child.once("close", (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          fail(
            new AppError(
              `${command} 执行失败（${String(code)}）：${redactCommandOutput(stderr || stdout)}`,
              "COMMAND_FAILED",
              502,
            ),
          );
          return;
        }
        settled = true;
        resolve({ stdout, stderr });
      });
    });
  }
}
