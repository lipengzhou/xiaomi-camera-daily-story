import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { MemoryCredentialStore } from "../src/credentials.js";
import { createLocalPlatformServices } from "../src/platform/local.js";
import type { RuntimePaths } from "../src/platform/types.js";
import { createRuntimeServices } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import type { CommandResult, CommandRunner } from "../src/sync/commands.js";
import type { XiaomiSession } from "../src/types.js";
import type { AccountProfile, ProfileProvider } from "../src/xiaomi/profile.js";

const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version as string;

class NoopRunner implements CommandRunner {
  async run(): Promise<CommandResult> {
    return { stdout: "", stderr: "" };
  }
}

class FakeProfileProvider implements ProfileProvider {
  clearCache(): void {}

  async getProfile(session: XiaomiSession): Promise<AccountProfile> {
    return {
      userId: session.userId,
      userName: "测试用户",
      avatarSourceUrl: "https://cdn.example.invalid/private-avatar.jpg",
      authorizedAt: new Date(session.createdAt).toISOString(),
    };
  }

  async getAvatar(): Promise<{ body: Buffer; contentType: string }> {
    return { body: Buffer.from("image"), contentType: "image/jpeg" };
  }
}

test("server enforces local Host and Origin and serves the UI", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-server-test-"));
  const downloadRoot = path.join(directory, "downloads");
  const paths: RuntimePaths = {
    configDir: path.join(directory, "private-config"),
    dataDir: directory,
    downloadRoot,
    credentialKeyFile: path.join(directory, "private-config", "credential.key"),
    credentialFile: path.join(directory, "credentials.enc"),
    configFile: path.join(directory, "config.json"),
    historyFile: path.join(directory, "history.json"),
  };
  const credentials = new MemoryCredentialStore();
  await credentials.set({
    userId: "123",
    cUserId: "456",
    passToken: "pass",
    ssecurity: "MDEyMzQ1Njc4OWFiY2RlZg==",
    serviceToken: "service",
    userAgent: "test",
    createdAt: Date.parse("2026-11-18T09:45:17.825Z"),
    refreshedAt: Date.parse("2026-11-18T09:45:17.825Z"),
  });
  const runner = new NoopRunner();
  const app = await createServer({
    port: 3210,
    logger: false,
    credentials,
    profileProvider: new FakeProfileProvider(),
    commandRunner: runner,
    platformServices: await createLocalPlatformServices(runner, { credentials }),
    publicRoot: path.resolve("public"),
    paths,
  });
  try {
    const status = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "127.0.0.1:3210" },
    });
    assert.equal(status.statusCode, 200);
    const statusBody = status.json();
    assert.deepEqual(statusBody.profile, {
      userId: "123",
      userName: "测试用户",
      avatarUrl: "/api/profile/avatar",
      authorizedAt: "2026-11-18T09:45:17.825Z",
    });
    assert.equal(statusBody.environment.platform, process.platform);
    assert.equal(statusBody.environment.credentialStore.kind, "encrypted-file");
    assert.equal(statusBody.environment.runtimeMode, "local");
    assert.equal(statusBody.environment.videoDir, downloadRoot);
    assert.deepEqual(statusBody.currentUser, {
      userId: "local-developer",
      username: "本地开发者",
      isAdmin: true,
    });
    assert.doesNotMatch(status.body, /cdn\.example\.invalid/);
    assert.equal(status.headers["cache-control"], "no-store");
    assert.match(status.headers["content-security-policy"] ?? "", /frame-ancestors 'none'/);

    const ignoredGatewayIdentity = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: {
        host: "127.0.0.1:3210",
        "x-trim-userid": "attacker",
        "x-trim-username": "伪造管理员",
        "x-trim-isadmin": "true",
      },
    });
    assert.equal(ignoredGatewayIdentity.json().currentUser.userId, "local-developer");

    const avatar = await app.inject({
      method: "GET",
      url: "/api/profile/avatar",
      headers: { host: "127.0.0.1:3210" },
    });
    assert.equal(avatar.statusCode, 200);
    assert.equal(avatar.headers["content-type"], "image/jpeg");
    assert.equal(avatar.body, "image");

    const rejectedHost = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: { host: "attacker.example" },
    });
    assert.equal(rejectedHost.statusCode, 421);

    const rejectedOrigin = await app.inject({
      method: "PUT",
      url: "/api/config",
      headers: { host: "127.0.0.1:3210", "content-type": "application/json" },
      payload: {},
    });
    assert.equal(rejectedOrigin.statusCode, 403);

    const accepted = await app.inject({
      method: "PUT",
      url: "/api/config",
      headers: {
        host: "127.0.0.1:3210",
        origin: "http://127.0.0.1:3210",
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: 1,
        devices: [
          {
            did: "camera-1",
            model: "chuangmi.camera.1",
            name: "客厅",
            homeId: "home-1",
            homeName: "我的家",
          },
          {
            did: "camera-2",
            model: "chuangmi.camera.2",
            name: "门口",
            homeId: "home-2",
            homeName: "父母家",
          },
        ],
        story: { region: "CN", timezone: "Asia/Shanghai" },
        schedule: {
          enabled: false,
          time: "08:17",
          timezone: "Asia/Shanghai",
          catchUpOnStart: false,
        },
      },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(
      accepted.json().config.devices.map((device: { homeName: string }) => device.homeName),
      ["我的家", "父母家"],
    );

    const page = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "localhost:3210" },
    });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /每日故事同步/);
    assert.match(page.body, /id="home-select"/);
    assert.match(page.body, /id="video-storage"/);
    assert.match(page.body, /id="add-device"/);
    assert.match(page.body, /id="selected-devices"/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("fnOS routes require the gateway base path and an administrator identity", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-linux-server-test-"));
  const runner = new NoopRunner();
  const platformServices = await createRuntimeServices("linux", runner, {
    environment: { XIAOMI_STORY_RUNTIME: "fnos" },
    fnosDirectories: {
      configDir: path.join(directory, "config"),
      dataDir: path.join(directory, "data"),
      downloadRoot: path.join(directory, "videos"),
      authorizedDownloadRoots: [
        {
          id: "accessible:111111111111",
          label: "Movies",
          path: path.join(directory, "authorized-movies"),
          available: true,
        },
        {
          id: "accessible:222222222222",
          label: "Photos",
          path: path.join(directory, "authorized-photos"),
          available: true,
        },
      ],
    },
  });
  const app = await createServer({
    port: 3211,
    logger: false,
    platformServices,
    commandRunner: runner,
    publicRoot: path.resolve("public"),
  });
  const basePath = "/app/xiaomi-camera-daily-story";
  const adminHeaders = {
    host: "nas.example:5666",
    "x-forwarded-host": "nas.example:5666",
    "x-forwarded-proto": "https",
    "x-trim-userid": "1000",
    "x-trim-username": "admin",
    "x-trim-isadmin": "true",
  };
  try {
    const wrongBasePath = await app.inject({
      method: "GET",
      url: "/api/status",
      headers: adminHeaders,
    });
    assert.equal(wrongBasePath.statusCode, 404);
    assert.equal(wrongBasePath.json().error.code, "INVALID_BASE_PATH");

    const missingIdentity = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: { host: "nas.example:5666" },
    });
    assert.equal(missingIdentity.statusCode, 401);
    assert.equal(missingIdentity.json().error.code, "GATEWAY_IDENTITY_REQUIRED");

    const partialIdentity = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: {
        host: "nas.example:5666",
        "x-trim-userid": "1000",
        "x-trim-isadmin": "true",
      },
    });
    assert.equal(partialIdentity.statusCode, 401);

    const nonAdmin = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: { ...adminHeaders, "x-trim-isadmin": "false" },
    });
    assert.equal(nonAdmin.statusCode, 403);
    assert.equal(nonAdmin.json().error.code, "ADMIN_REQUIRED");

    const status = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: adminHeaders,
    });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().environment.runtimeMode, "fnos");
    assert.equal(status.json().environment.credentialStore.kind, "encrypted-file");
    assert.equal(status.json().environment.dataDir, path.join(directory, "data"));
    assert.equal(status.json().environment.videoDir, path.join(directory, "videos"));
    assert.equal(status.json().config.videoStorage, "data-share");
    assert.deepEqual(status.json().environment.videoStorageOptions, [
      {
        id: "data-share",
        label: "应用文件/xiaomi-camera-daily-story/videos",
        path: path.join(directory, "videos"),
        available: true,
      },
      {
        id: "accessible:111111111111",
        label: "Movies",
        path: path.join(directory, "authorized-movies"),
        available: true,
      },
      {
        id: "accessible:222222222222",
        label: "Photos",
        path: path.join(directory, "authorized-photos"),
        available: true,
      },
    ]);
    assert.equal(status.json().config.schemaVersion, 1);
    assert.deepEqual(status.json().currentUser, {
      userId: "1000",
      username: "admin",
      isAdmin: true,
    });
    assert.deepEqual(status.json().server, {
      transport: "unix",
      basePath,
      socketPath: "/app/target/app.sock",
    });

    const redirect = await app.inject({
      method: "GET",
      url: basePath,
      headers: adminHeaders,
    });
    assert.equal(redirect.statusCode, 302);
    assert.equal(redirect.headers.location, `${basePath}/`);

    const page = await app.inject({
      method: "GET",
      url: `${basePath}/`,
      headers: adminHeaders,
    });
    assert.equal(page.statusCode, 200);
    assert.ok(page.body.includes(`href="styles.css?v=${packageVersion}"`));
    assert.ok(page.body.includes(`src="app.js?v=${packageVersion}"`));
    assert.equal(page.headers["cache-control"], "no-cache");
    assert.match(page.headers["content-security-policy"] ?? "", /frame-ancestors 'self'/);
    assert.equal(page.headers["x-frame-options"], "SAMEORIGIN");

    for (const asset of ["app.js", "styles.css"]) {
      const response = await app.inject({
        method: "GET",
        url: `${basePath}/${asset}`,
        headers: adminHeaders,
      });
      assert.equal(response.statusCode, 200, asset);
      assert.equal(response.headers["cache-control"], "no-cache", asset);
    }

    const invalidOrigin = await app.inject({
      method: "PUT",
      url: `${basePath}/api/config`,
      headers: {
        ...adminHeaders,
        origin: "https://attacker.example",
        "content-type": "application/json",
      },
      payload: {},
    });
    assert.equal(invalidOrigin.statusCode, 403);
    assert.equal(invalidOrigin.json().error.code, "INVALID_ORIGIN");

    const acceptedConfig = await app.inject({
      method: "PUT",
      url: `${basePath}/api/config`,
      headers: {
        host: "internal-unix-gateway",
        origin: "http://nas.example:5666",
        "x-requested-with": "XiaomiDailyStoryUI",
        "x-trim-userid": "1000",
        "x-trim-username": "admin",
        "x-trim-isadmin": "true",
        "content-type": "application/json",
      },
      payload: {
        schemaVersion: 1,
        videoStorage: "accessible:222222222222",
        devices: [],
        story: { region: "CN", timezone: "Asia/Shanghai" },
        schedule: {
          enabled: false,
          time: "08:17",
          timezone: "Asia/Shanghai",
          catchUpOnStart: false,
        },
      },
    });
    assert.equal(acceptedConfig.statusCode, 200);
    assert.equal(acceptedConfig.json().config.videoStorage, "accessible:222222222222");

    const metadataFile = path.join(directory, "config", "authorized-video-roots.tsv");
    await mkdir(path.dirname(metadataFile), { recursive: true });
    platformServices.paths.authorizedDownloadRootsFile = metadataFile;
    await writeFile(
      metadataFile,
      "accessible:333333333333\tArchive\t/authorized-videos-333333333333\n",
    );
    const refreshedStorage = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: adminHeaders,
    });
    assert.deepEqual(
      refreshedStorage.json().environment.videoStorageOptions.map(
        (option: { id: string; available: boolean }) => ({
          id: option.id,
          available: option.available,
        }),
      ),
      [
        { id: "data-share", available: true },
        { id: "accessible:333333333333", available: false },
      ],
    );
    await writeFile(metadataFile, "");
    const removedStorage = await app.inject({
      method: "GET",
      url: `${basePath}/api/status`,
      headers: adminHeaders,
    });
    assert.deepEqual(
      removedStorage.json().environment.videoStorageOptions.map(
        (option: { id: string }) => option.id,
      ),
      ["data-share"],
    );

    const invalidPath = await app.inject({
      method: "GET",
      url: `${basePath}/api/%2e%2e/status`,
      headers: adminHeaders,
    });
    assert.notEqual(invalidPath.statusCode, 200);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
