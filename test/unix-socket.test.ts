import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRuntimeServices } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import type { CommandResult, CommandRunner } from "../src/sync/commands.js";
import {
  cleanupUnixSocket,
  prepareUnixSocket,
  secureUnixSocket,
} from "../src/unix-socket.js";

class NoopRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: "", stderr: "" };
  }
}

function getThroughSocket(
  socketPath: string,
  requestPath: string,
  headers: Record<string, string>,
): Promise<{ body: string; statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, path: requestPath, method: "GET", headers },
      (response) => {
        response.setEncoding("utf8");
        let body = "";
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => resolve({ body, statusCode: response.statusCode }));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("Unix Socket preparation never overwrites a regular file", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-socket-guard-"));
  const socketPath = path.join(directory, "app.sock");
  try {
    await writeFile(socketPath, "keep-me");
    await assert.rejects(() => prepareUnixSocket(socketPath), /拒绝覆盖非 Socket 文件/);
    await cleanupUnixSocket(socketPath);
    assert.equal(await readFile(socketPath, "utf8"), "keep-me");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fnOS server accepts authenticated requests only through its Unix Socket", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-socket-server-"));
  const targetDir = path.join(directory, "target");
  await mkdir(targetDir, { recursive: true });
  const runner = new NoopRunner();
  const platformServices = await createRuntimeServices("linux", runner, {
    environment: { XIAOMI_STORY_RUNTIME: "fnos" },
    fnosDirectories: {
      configDir: path.join(directory, "config"),
      dataDir: path.join(directory, "data"),
      downloadRoot: path.join(directory, "videos"),
      targetDir,
    },
  });
  assert.equal(platformServices.web.transport, "unix");
  const socketPath = platformServices.web.socketPath;
  const app = await createServer({
    logger: false,
    platformServices,
    commandRunner: runner,
    publicRoot: path.resolve("public"),
  });
  try {
    await prepareUnixSocket(socketPath);
    await app.listen({ path: socketPath });
    await secureUnixSocket(socketPath);
    const socketStat = await stat(socketPath);
    assert.equal(socketStat.isSocket(), true);
    assert.equal(socketStat.mode & 0o777, 0o660);

    const response = await getThroughSocket(
      socketPath,
      "/app/xiaomi-camera-daily-story/api/status",
      {
        host: "nas.example:5666",
        "x-trim-userid": "1000",
        "x-trim-username": "admin",
        "x-trim-isadmin": "true",
      },
    );
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body).currentUser.userId, "1000");
  } finally {
    await app.close();
    await cleanupUnixSocket(socketPath);
    await assert.rejects(() => stat(socketPath), { code: "ENOENT" });
    await rm(directory, { recursive: true, force: true });
  }
});
