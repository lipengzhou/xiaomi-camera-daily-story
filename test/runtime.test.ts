import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createRuntimeServices, resolveRuntimeMode } from "../src/runtime.js";
import type { CommandResult, CommandRunner } from "../src/sync/commands.js";
import type { XiaomiSession } from "../src/types.js";

const fnosTest = process.platform === "win32" ? test.skip : test;

class NoopRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: "", stderr: "" };
  }
}

const session: XiaomiSession = {
  userId: "1",
  cUserId: "2",
  passToken: "pass",
  ssecurity: "MDEyMzQ1Njc4OWFiY2RlZg==",
  serviceToken: "service",
  userAgent: "runtime-test",
  createdAt: 1,
  refreshedAt: 2,
};

test("runtime mode defaults to local only outside production", () => {
  assert.equal(resolveRuntimeMode({}), "local");
  assert.equal(resolveRuntimeMode({ XIAOMI_STORY_RUNTIME: "fnos" }), "fnos");
  assert.equal(
    resolveRuntimeMode({ NODE_ENV: "production", XIAOMI_STORY_RUNTIME: "fnos" }),
    "fnos",
  );
  assert.throws(
    () => resolveRuntimeMode({ NODE_ENV: "production" }),
    /必须显式设置/,
  );
  assert.throws(
    () =>
      resolveRuntimeMode({
        NODE_ENV: "production",
        XIAOMI_STORY_RUNTIME: "local",
      }),
    /不允许使用 local/,
  );
  assert.throws(
    () => resolveRuntimeMode({ XIAOMI_STORY_RUNTIME: "desktop" }),
    /只能是 local 或 fnos/,
  );
});

fnosTest("fnOS runtime uses fixed container directories and encrypted credentials", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-fnos-runtime-"));
  try {
    const services = await createRuntimeServices("linux", new NoopRunner(), {
      environment: { XIAOMI_STORY_RUNTIME: "fnos" },
      fnosDirectories: {
        configDir: path.join(directory, "config"),
        dataDir: path.join(directory, "data"),
        downloadRoot: path.join(directory, "videos"),
        targetDir: path.join(directory, "target"),
      },
    });
    const paths = services.paths;
    assert.equal(services.runtimeMode, "fnos");
    assert.equal(services.credentialStore.kind, "encrypted-file");
    assert.equal(paths.downloadRoot, path.join(directory, "videos"));
    assert.equal(paths.credentialKeyFile, path.join(directory, "config", "credential.key"));
    assert.equal(paths.credentialFile, path.join(directory, "data", "credentials.enc"));
    assert.deepEqual(services.web, {
      basePath: "/app/xiaomi-camera-daily-story",
      transport: "unix",
      socketPath: path.join(directory, "target", "app.sock"),
    });
    await services.credentials.set(session);

    const restarted = await createRuntimeServices("linux", new NoopRunner(), {
      environment: { XIAOMI_STORY_RUNTIME: "fnos" },
      fnosDirectories: {
        configDir: path.join(directory, "config"),
        dataDir: path.join(directory, "data"),
        downloadRoot: path.join(directory, "videos"),
        targetDir: path.join(directory, "target"),
      },
    });
    assert.deepEqual(await restarted.credentials.get(), session);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

fnosTest("fnOS runtime loads multiple authorized video roots from private metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-authorized-roots-"));
  try {
    const configDir = path.join(directory, "config");
    await mkdir(configDir);
    await writeFile(
      path.join(configDir, "authorized-video-roots.tsv"),
      [
        "accessible:111111111111\tMovies\t/authorized-videos-111111111111",
        "accessible:222222222222\tPhotos\t/authorized-videos-222222222222",
        "",
      ].join("\n"),
    );
    const services = await createRuntimeServices("linux", new NoopRunner(), {
      environment: { XIAOMI_STORY_RUNTIME: "fnos" },
      fnosDirectories: { configDir },
    });
    assert.equal(services.paths.downloadRoot, "/videos");
    assert.deepEqual(services.paths.authorizedDownloadRoots, [
      {
        id: "accessible:111111111111",
        label: "Movies",
        path: "/authorized-videos-111111111111",
        available: false,
      },
      {
        id: "accessible:222222222222",
        label: "Photos",
        path: "/authorized-videos-222222222222",
        available: false,
      },
    ]);

    await writeFile(
      path.join(configDir, "authorized-video-roots.tsv"),
      "accessible:invalid\tMovies\t/host/path\n",
    );
    await assert.rejects(
      () =>
        createRuntimeServices("linux", new NoopRunner(), {
          environment: { XIAOMI_STORY_RUNTIME: "fnos" },
          fnosDirectories: { configDir },
        }),
      /元数据第 1 行内容无效/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fnOS runtime refuses to start outside Linux", async () => {
  await assert.rejects(
    () =>
      createRuntimeServices("darwin", new NoopRunner(), {
        environment: { XIAOMI_STORY_RUNTIME: "fnos" },
      }),
    /只能在 Linux 容器中启动/,
  );
});

test("local runtime starts on Windows, macOS and Linux with project-relative storage", async () => {
  for (const platform of ["win32", "darwin", "linux"] as const) {
    const paths = platform === "win32" ? path.win32 : path.posix;
    const projectRoot = platform === "win32" ? "C:\\projects\\camera" : "/projects/camera";
    const services = await createRuntimeServices(platform, new NoopRunner(), {
      projectRoot,
      environment: { XIAOMI_STORY_RUNTIME: "local", XIAOMI_STORY_DATA_DIR: "private/data" },
    });
    assert.equal(services.platform, platform);
    assert.equal(services.web.transport, "tcp");
    assert.equal(services.paths.dataDir, paths.join(projectRoot, "private/data"));
  }
});

fnosTest("fnOS runtime still rejects relative container storage paths", async () => {
  await assert.rejects(
    () =>
      createRuntimeServices("linux", new NoopRunner(), {
        environment: { XIAOMI_STORY_RUNTIME: "fnos" },
        fnosDirectories: { dataDir: "relative-data" },
      }),
    /必须是绝对路径/,
  );
});

test("local authorization persists encrypted under the project and survives restart", async (context) => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "xiaomi-project-credentials-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  const options = { projectRoot, environment: { XIAOMI_STORY_RUNTIME: "local" } };
  const services = await createRuntimeServices(process.platform, new NoopRunner(), options);
  await services.credentials.set(session);
  assert.equal(services.paths.credentialFile, path.join(projectRoot, ".dev/local/data/credentials.enc"));
  const stored = await readFile(services.paths.credentialFile, "utf8");
  assert.doesNotMatch(stored, /serviceToken|passToken/u);
  const restarted = await createRuntimeServices(process.platform, new NoopRunner(), options);
  assert.deepEqual(await restarted.credentials.get(), session);
});
