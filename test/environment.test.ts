import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";

import { loadEnvironmentFiles } from "../src/environment.js";
import { createLocalRuntimePaths } from "../src/platform/local.js";
import { ensureLocalEnvironment } from "../scripts/dev-env.mjs";

async function fixture(context: { after: (cleanup: () => Promise<unknown>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiaomi-env-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("environment files load with process environment above .env.local above .env", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, ".env"), 'PORT=1111\nVALUE=base\nQUOTED="hello world"\n');
  await writeFile(path.join(root, ".env.local"), 'PORT=2222\nVALUE=local\nXIAOMI_STORY_DATA_DIR=private/data\n');
  const environment: NodeJS.ProcessEnv = { PORT: "3333" };
  assert.deepEqual(await loadEnvironmentFiles(root, environment), [".env", ".env.local"]);
  assert.equal(environment.PORT, "3333");
  assert.equal(environment.VALUE, "local");
  assert.equal(environment.QUOTED, "hello world");
  assert.equal(createLocalRuntimePaths(environment, root).dataDir, path.join(root, "private/data"));
});

test("fnOS and production startup never loads project-local environment files", async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, ".env.local"), 'XIAOMI_STORY_RUNTIME=local\nXIAOMI_STORY_DATA_DIR=private/data\nPORT=2222\n');
  for (const environment of [{ NODE_ENV: "production" }, { XIAOMI_STORY_RUNTIME: "fnos" }] as NodeJS.ProcessEnv[]) {
    assert.deepEqual(await loadEnvironmentFiles(root, environment), []);
    assert.equal(environment.PORT, undefined);
    assert.equal(environment.XIAOMI_STORY_DATA_DIR, undefined);
  }
});

test("dev generates the local template once and preserves user edits", async (context) => {
  const root = await fixture(context);
  await cp(path.resolve(".env.example"), path.join(root, ".env.example"));
  assert.equal(await ensureLocalEnvironment(root), true);
  const environment: NodeJS.ProcessEnv = {};
  await loadEnvironmentFiles(root, environment);
  assert.equal(environment.XIAOMI_STORY_RUNTIME, "local");
  assert.equal(createLocalRuntimePaths(environment, root).credentialFile, path.join(root, ".dev/local/data/credentials.enc"));
  await writeFile(path.join(root, ".env.local"), "PORT=4567\n");
  assert.equal(await ensureLocalEnvironment(root), false);
  assert.equal(await readFile(path.join(root, ".env.local"), "utf8"), "PORT=4567\n");
});

test("local environment and credential paths are ignored by Git, while the template remains trackable", (context) => {
  if (spawnSync("git", ["--version"]).status !== 0) return context.skip("Git is not installed in this test image");
  const ignored = spawnSync("git", ["check-ignore", "--no-index", ".env.local", ".dev/local/config/credential.key", ".dev/local/data/credentials.enc"], { encoding: "utf8" });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.deepEqual(ignored.stdout.trim().split(/\r?\n/u), [".env.local", ".dev/local/config/credential.key", ".dev/local/data/credentials.enc"]);
  assert.equal(spawnSync("git", ["check-ignore", "--no-index", ".env.example"]).status, 1);
});

test("local startup reads .env.local and creates project-local data without installed media tools", async (context) => {
  const root = await fixture(context);
  for (const name of ["src", "public"]) await cp(path.resolve(name), path.join(root, name), { recursive: true });
  await writeFile(path.join(root, "package.json"), '{"type":"module"}');
  await symlink(path.resolve("node_modules"), path.join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  await writeFile(path.join(root, ".env.local"), `PORT=${port}\nXIAOMI_STORY_FFMPEG=missing-test-ffmpeg\nXIAOMI_STORY_FFPROBE=missing-test-ffprobe\n`);
  const environment = { ...process.env, NODE_ENV: "development" };
  delete environment.PORT;
  for (const key of Object.keys(environment)) if (key.startsWith("XIAOMI_STORY_")) delete environment[key];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`启动超时：${output.slice(-1200)}`)), 20_000);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("Server listening at")) { clearTimeout(deadline); resolve(); }
      });
      child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(deadline); reject(error); });
      child.once("exit", (code) => { clearTimeout(deadline); reject(new Error(`启动失败 ${code}：${output.slice(-1200)}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(response.status, 200);
    const state = await response.json() as { environment: { platform: string; runtimeMode: string; dataDir: string }; capabilities: { mediaDownload: boolean } };
    assert.equal(state.environment.platform, process.platform);
    assert.equal(state.environment.runtimeMode, "local");
    assert.equal(await realpath(state.environment.dataDir), await realpath(path.join(root, ".dev/local/data")));
    assert.equal(state.capabilities.mediaDownload, false);
    assert.ok(await readFile(path.join(root, ".dev/local/data/config.json"), "utf8"));
  } finally {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  }
});
