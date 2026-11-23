import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = process.cwd();
const packageRoot = path.join(projectRoot, "fnos", "xiaomi-camera-daily-story");

async function readPackageFile(relativePath: string): Promise<string> {
  return readFile(path.join(packageRoot, relativePath), "utf8");
}

async function writeExecutable(file: string, contents: string): Promise<void> {
  await writeFile(file, contents);
  await chmod(file, 0o755);
}

function parseManifest(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of contents.split("\n")) {
    const match = line.match(/^([^#=]+)=(.*)$/u);
    if (match) {
      result.set(match[1]!.trim(), match[2]!.trim());
    }
  }
  return result;
}

async function assertMissing(file: string): Promise<void> {
  await assert.rejects(access(file), { code: "ENOENT" });
}

function pngDimensions(contents: Buffer): { width: number; height: number } {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(contents.subarray(0, 8), signature);
  assert.equal(contents.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: contents.readUInt32BE(16),
    height: contents.readUInt32BE(20),
  };
}

test("FPK manifest, desktop entry and Compose stay aligned", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, "package.json"), "utf8"),
  ) as { version: string };
  const manifest = parseManifest(await readPackageFile("manifest"));
  assert.equal(manifest.get("appname"), "xiaomi-camera-daily-story");
  assert.equal(manifest.get("version"), packageJson.version);
  assert.equal(manifest.get("platform"), "all");
  assert.equal(
    manifest.get("desktop_applaunchname"),
    "xiaomi-camera-daily-story.main",
  );
  assert.equal(manifest.get("ctl_stop"), "true");

  const ui = JSON.parse(await readPackageFile("app/ui/config")) as {
    ".url": Record<string, Record<string, unknown>>;
  };
  const entry = ui[".url"]["xiaomi-camera-daily-story.main"];
  assert.ok(entry);
  assert.equal(entry.type, "iframe");
  assert.equal(entry.gatewayPrefix, "/app/xiaomi-camera-daily-story");
  assert.equal(entry.gatewaySocket, "app.sock");
  assert.equal(entry.url, "/app/xiaomi-camera-daily-story");
  assert.equal(entry.allUsers, false);

  const compose = await readPackageFile("app/docker/docker-compose.yaml");
  const image = compose.match(/image: xiaomi-camera-daily-story:([^\s]+)/u);
  assert.ok(image);
  assert.equal(image[1], packageJson.version);
  const publicIndex = await readFile(path.join(projectRoot, "public", "index.html"), "utf8");
  assert.match(publicIndex, new RegExp(`styles\\.css\\?v=${packageJson.version}`, "u"));
  assert.match(publicIndex, new RegExp(`app\\.js\\?v=${packageJson.version}`, "u"));
  assert.match(compose, /container_name: xiaomi-camera-daily-story-app/u);
  assert.match(compose, /user: "\$\{TRIM_UID\}:\$\{TRIM_GID\}"/u);
  assert.match(compose, /read_only: true/u);
  assert.match(compose, /- ALL/u);
  assert.match(compose, /no-new-privileges:true/u);
  assert.match(compose, /"\$\{TRIM_APPDEST\}:\/app\/target:rw"/u);
  assert.match(compose, /"\$\{TRIM_APPDEST\}\/docker:\/app\/target\/docker:ro"/u);
  assert.match(compose, /"\$\{TRIM_PKGETC\}:\/config:rw"/u);
  assert.match(compose, /"\$\{TRIM_PKGVAR\}:\/data:rw"/u);
  assert.match(compose, /"\$\{TRIM_DATA_SHARE_PATHS\}:\/videos:rw"/u);
  assert.match(compose, /# __XIAOMI_AUTHORIZED_VIDEO_VOLUMES__/u);
  const composeTemplate = await readPackageFile("app/docker/docker-compose.template.yaml");
  assert.equal(composeTemplate, compose);
  assert.doesNotMatch(compose, /^\s*ports:/mu);
  assert.doesNotMatch(compose, /privileged:\s*true/u);
  assert.doesNotMatch(compose, /network_mode:\s*host/u);
  assert.doesNotMatch(compose, /docker\.sock/u);
  assert.doesNotMatch(compose, /:latest(?:\s|$)/u);
});

test("FPK resource and privilege declarations are minimal", async () => {
  const resource = JSON.parse(await readPackageFile("config/resource")) as {
    "docker-project": {
      projects: Array<{ name: string; path: string }>;
    };
    "data-share": { shares: Array<{ name: string }> };
  };
  assert.deepEqual(resource["docker-project"].projects, [
    {
      name: "xiaomi-camera-daily-story",
      path: "docker",
    },
  ]);
  assert.deepEqual(resource["data-share"].shares, [
    { name: "xiaomi-camera-daily-story/videos" },
  ]);

  const privilege = JSON.parse(await readPackageFile("config/privilege")) as {
    defaults: { "run-as": string };
    username: string;
    groupname: string;
  };
  assert.equal(privilege.defaults["run-as"], "package");
  assert.equal(privilege.username, "xiaomi-camera-daily-story");
  assert.equal(privilege.groupname, "xiaomi-camera-daily-story");
});

test("FPK lifecycle scripts are executable and valid Bash", async () => {
  const scripts = [
    "main",
    "install_init",
    "install_callback",
    "upgrade_init",
    "upgrade_callback",
    "uninstall_init",
    "uninstall_callback",
    "config_init",
    "config_callback",
    "authorized-mounts-watcher",
    "_lib",
  ];
  for (const script of scripts) {
    const file = path.join(packageRoot, "cmd", script);
    await access(file, constants.X_OK);
    const result = spawnSync("bash", ["-n", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${script}: ${result.stderr}`);
  }
});

test("FPK preflight hooks leave Docker management to the app center", async () => {
  for (const script of ["install_init", "upgrade_init"]) {
    const contents = await readPackageFile(`cmd/${script}`);
    assert.doesNotMatch(contents, /\bdocker\b/iu);
  }
  const library = await readPackageFile("cmd/_lib");
  assert.doesNotMatch(library, /docker (?:info|version)/iu);
});

test("FPK config init renders stable mounts before appcenter recreates the container", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-mounts-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const videos = path.join(root, "videos");
  const movies = path.join(root, "Movies");
  const photos = path.join(root, "Photos");
  await Promise.all([
    mkdir(path.join(app, "docker"), { recursive: true }),
    mkdir(config),
    mkdir(data),
    mkdir(videos),
    mkdir(movies),
    mkdir(photos),
  ]);
  await writeFile(
    path.join(app, "docker", "docker-compose.template.yaml"),
    await readPackageFile("app/docker/docker-compose.template.yaml"),
  );
  const result = spawnSync(
    "bash",
    [path.join(packageRoot, "cmd", "config_init")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
        TRIM_UID: "1000",
        TRIM_GID: "1000",
        TRIM_DATA_SHARE_PATHS: videos,
        TRIM_DATA_ACCESSIBLE_PATHS: `${movies}:${photos}`,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const moviesId = createHash("sha256").update(movies).digest("hex").slice(0, 12);
  const photosId = createHash("sha256").update(photos).digest("hex").slice(0, 12);
  const compose = await readFile(path.join(app, "docker", "docker-compose.yaml"), "utf8");
  assert.doesNotMatch(compose, /__XIAOMI_AUTHORIZED_VIDEO_VOLUMES__/u);
  assert.match(compose, new RegExp(`source: '${movies}'`, "u"));
  assert.match(compose, new RegExp(`target: /authorized-videos-${moviesId}`, "u"));
  assert.match(compose, new RegExp(`source: '${photos}'`, "u"));
  assert.match(compose, new RegExp(`target: /authorized-videos-${photosId}`, "u"));
  const metadata = await readFile(path.join(config, "authorized-video-roots.tsv"), "utf8");
  assert.equal(
    metadata,
    [
      `accessible:${moviesId}\tMovies\t/authorized-videos-${moviesId}`,
      `accessible:${photosId}\tPhotos\t/authorized-videos-${photosId}`,
      "",
    ].join("\n"),
  );
  assert.equal((await stat(path.join(config, "authorized-video-roots.tsv"))).mode & 0o777, 0o644);
});

test("FPK lifecycle formats authorized paths like fnOS application settings", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-labels-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const getent = path.join(bin, "getent");
  await writeFile(
    getent,
    [
      "#!/bin/sh",
      "if [ \"$1\" = passwd ] && [ \"$2\" = 1000 ]; then",
      "  printf '%s\\n' 'alice:x:1000:1000::/home/alice:/bin/bash'",
      "fi",
      "",
    ].join("\n"),
  );
  await chmod(getent, 0o755);

  const result = spawnSync(
    "bash",
    [
      "-c",
      [
        "source \"$1\"",
        "stage_format_authorized_path_label /vol2/1000/Movies",
        "printf '\\n'",
        "stage_format_authorized_path_label /vol3/2000/Photos",
        "printf '\\n'",
        "stage_format_authorized_path_label /vol1/@appshare/example/videos",
        "printf '\\n'",
        "stage_format_authorized_path_label /archive/Camera",
        "printf '\\n'",
      ].join("; "),
      "bash",
      path.join(packageRoot, "cmd", "_lib"),
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    [
      "存储空间 2/alice 的文件/Movies",
      "存储空间 3/用户 2000 的文件/Photos",
      "存储空间 1/应用文件/example/videos",
      "Camera",
      "",
    ].join("\n"),
  );
});

test("FPK main start force-recreates the Docker project with current mounts", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-start-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const videos = path.join(root, "videos");
  const movies = path.join(root, "Movies");
  const photos = path.join(root, "Photos");
  const bin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  await Promise.all([
    mkdir(path.join(app, "docker"), { recursive: true }),
    mkdir(config),
    mkdir(data),
    mkdir(videos),
    mkdir(movies),
    mkdir(photos),
    mkdir(bin),
  ]);
  await writeFile(
    path.join(app, "docker", "docker-compose.template.yaml"),
    await readPackageFile("app/docker/docker-compose.template.yaml"),
  );
  await writeExecutable(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
      "exit 0",
      "",
    ].join("\n"),
  );
  const result = spawnSync(
    "bash",
    [path.join(packageRoot, "cmd", "main"), "start"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_LOG: dockerLog,
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
        TRIM_UID: "1000",
        TRIM_GID: "1000",
        TRIM_DATA_SHARE_PATHS: videos,
        TRIM_DATA_ACCESSIBLE_PATHS: `${movies}:${photos}`,
        XIAOMI_DISABLE_WATCHER: "1",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(dockerLog, "utf8");
  assert.match(log, /compose --project-name xiaomi-camera-daily-story/u);
  assert.match(log, /up -d --force-recreate/u);
  const compose = await readFile(path.join(app, "docker", "docker-compose.yaml"), "utf8");
  assert.match(compose, new RegExp(`source: '${movies}'`, "u"));
  assert.match(compose, new RegExp(`source: '${photos}'`, "u"));
});

test("FPK main status reports container state without shell errors", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-status-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const videos = path.join(root, "videos");
  const bin = path.join(root, "bin");
  await Promise.all([
    mkdir(app),
    mkdir(config),
    mkdir(data),
    mkdir(videos),
    mkdir(bin),
  ]);
  await writeExecutable(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      'case "$1" in',
      "  inspect)",
      '    case "$3" in',
      "      *State.Running*) printf '%s\\n' \"$RUNNING_VALUE\" ;;",
      "    esac",
      "    exit 0",
      "    ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const runStatus = (running: string) =>
    spawnSync("bash", [path.join(packageRoot, "cmd", "main"), "status"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNING_VALUE: running,
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
        TRIM_DATA_SHARE_PATHS: videos,
        XIAOMI_DISABLE_WATCHER: "1",
        XIAOMI_WATCHER_RECREATE_FLAG: path.join(root, "recreating"),
      },
    });
  const running = runStatus("true");
  assert.equal(running.status, 0, running.stderr);
  assert.doesNotMatch(running.stderr, /local:|unbound variable/u);
  const stopped = runStatus("false");
  assert.equal(stopped.status, 3, stopped.stderr);
  assert.doesNotMatch(stopped.stderr, /local:|unbound variable/u);
});

test("FPK watcher renders mounts from the appcenter authorization database", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-watcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const videos = path.join(root, "videos");
  const movies = path.join(root, "Movies");
  const photos = path.join(root, "Photos");
  const bin = path.join(root, "bin");
  const dockerLog = path.join(root, "docker.log");
  await Promise.all([
    mkdir(path.join(app, "docker"), { recursive: true }),
    mkdir(config),
    mkdir(data),
    mkdir(videos),
    mkdir(movies),
    mkdir(photos),
    mkdir(bin),
  ]);
  await writeFile(
    path.join(app, "docker", "docker-compose.template.yaml"),
    await readPackageFile("app/docker/docker-compose.template.yaml"),
  );
  await writeExecutable(
    path.join(bin, "getent"),
    [
      "#!/bin/sh",
      'if [ "$1" = "passwd" ] && [ "$2" = "1000" ]; then',
      "  printf '%s\\n' 'alice:x:1000:1000::/home/alice:/bin/bash'",
      "fi",
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(bin, "runuser"),
    [
      "#!/bin/sh",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -u) shift 2 ;;',
      '    --) shift; break ;;',
      '    *) shift ;;',
      "  esac",
      "done",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(bin, "psql"),
    [
      "#!/bin/sh",
      `printf '%s\\n' '${movies}' '${photos}'`,
      "",
    ].join("\n"),
  );
  await writeExecutable(
    path.join(bin, "docker"),
    [
      "#!/bin/sh",
      'printf "%s\\n" "$*" >> "$DOCKER_LOG"',
      'case "$1" in',
      "  inspect)",
      '    case "$3" in',
      "      *State.Running*) printf '%s\\n' 'true' ;;",
      "    esac",
      "    exit 0",
      "    ;;",
      "  compose) exit 0 ;;",
      "  *) exit 0 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  const result = spawnSync(
    "bash",
    [path.join(packageRoot, "cmd", "authorized-mounts-watcher")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_LOG: dockerLog,
        TRIM_APPNAME: "xiaomi-camera-daily-story",
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
        TRIM_UID: "1000",
        TRIM_GID: "1000",
        TRIM_USERNAME: "xiaomi-camera-daily-story",
        TRIM_DATA_SHARE_PATHS: videos,
        XIAOMI_WATCHER_ONCE: "1",
        XIAOMI_WATCHER_ALLOW_NON_ROOT: "1",
        XIAOMI_WATCHER_RUNUSER: path.join(bin, "runuser"),
        XIAOMI_WATCHER_LOCK_DIR: path.join(root, "watcher.lock"),
        XIAOMI_WATCHER_STATE_FILE: path.join(root, "watcher.state"),
        XIAOMI_WATCHER_PID_FILE: path.join(root, "watcher.pid"),
        XIAOMI_WATCHER_RECREATE_FLAG: path.join(root, "recreating"),
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const moviesId = createHash("sha256").update(movies).digest("hex").slice(0, 12);
  const photosId = createHash("sha256").update(photos).digest("hex").slice(0, 12);
  const compose = await readFile(path.join(app, "docker", "docker-compose.yaml"), "utf8");
  assert.match(compose, new RegExp(`source: '${movies}'`, "u"));
  assert.match(compose, new RegExp(`target: /authorized-videos-${moviesId}`, "u"));
  assert.match(compose, new RegExp(`source: '${photos}'`, "u"));
  assert.match(compose, new RegExp(`target: /authorized-videos-${photosId}`, "u"));
  const metadata = await readFile(path.join(config, "authorized-video-roots.tsv"), "utf8");
  assert.equal(
    metadata,
    [
      `accessible:${moviesId}\tMovies\t/authorized-videos-${moviesId}`,
      `accessible:${photosId}\tPhotos\t/authorized-videos-${photosId}`,
      "",
    ].join("\n"),
  );
  assert.equal((await stat(path.join(config, "authorized-video-roots.tsv"))).mode & 0o777, 0o644);
  const log = await readFile(dockerLog, "utf8");
  assert.match(log, /compose --project-name xiaomi-camera-daily-story/u);
  assert.match(log, /up -d --force-recreate/u);
  assert.equal((await stat(path.join(root, "watcher.state"))).isFile(), true);
});

test("FPK uninstall only removes selected private files and preserves videos", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  const videos = path.join(root, "videos");
  await Promise.all([
    mkdir(app),
    mkdir(config),
    mkdir(data),
    mkdir(videos),
  ]);
  await Promise.all([
    writeFile(path.join(config, "credential.key"), "test-key"),
    writeFile(path.join(data, "credentials.enc"), "ciphertext"),
    writeFile(path.join(data, "config.json"), "{}"),
    writeFile(path.join(data, "sync-history.json"), "[]"),
    writeFile(path.join(data, "future-private-file"), "preserve"),
    writeFile(path.join(videos, "story.mp4"), "video"),
  ]);

  const result = spawnSync(
    "bash",
    [path.join(packageRoot, "cmd", "uninstall_init")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
        wizard_private_data_action: "delete",
        wizard_authorization_action: "delete",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  await Promise.all([
    assertMissing(path.join(config, "credential.key")),
    assertMissing(path.join(data, "credentials.enc")),
    assertMissing(path.join(data, "config.json")),
    assertMissing(path.join(data, "sync-history.json")),
  ]);
  assert.equal(await readFile(path.join(data, "future-private-file"), "utf8"), "preserve");
  assert.equal(await readFile(path.join(videos, "story.mp4"), "utf8"), "video");
});

test("FPK uninstall script does not delete private data unless explicitly selected", async (context) => {
  const root = await mkdtemp(path.join(tmpdir(), "xiaomi-story-fpk-keep-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, "app");
  const config = path.join(root, "config");
  const data = path.join(root, "data");
  await Promise.all([mkdir(app), mkdir(config), mkdir(data)]);
  await writeFile(path.join(data, "credentials.enc"), "ciphertext");

  const result = spawnSync(
    "bash",
    [path.join(packageRoot, "cmd", "uninstall_init")],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TRIM_APPDEST: app,
        TRIM_PKGETC: config,
        TRIM_PKGVAR: data,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(path.join(data, "credentials.enc"), "utf8"), "ciphertext");
});

test("FPK uninstall wizard defaults to keeping data and authorization", async () => {
  const wizard = JSON.parse(await readPackageFile("wizard/uninstall")) as Array<{
    items: Array<{ field?: string; initValue?: string }>;
  }>;
  const fields = new Map(
    wizard.flatMap((step) => step.items)
      .filter((item) => item.field)
      .map((item) => [item.field!, item.initValue]),
  );
  assert.equal(fields.get("wizard_private_data_action"), "keep");
  assert.equal(fields.get("wizard_authorization_action"), "keep");
});

test("FPK icons have the required dimensions", async () => {
  const expected = new Map([
    ["ICON.PNG", 64],
    ["ICON_256.PNG", 256],
    ["app/ui/images/icon_64.png", 64],
    ["app/ui/images/icon_256.png", 256],
  ]);
  for (const [relativePath, size] of expected) {
    const dimensions = pngDimensions(
      await readFile(path.join(packageRoot, relativePath)),
    );
    assert.deepEqual(dimensions, { width: size, height: size });
  }
});

test("FPK includes privacy and third-party notices in the installed app", async () => {
  const privacy = await readPackageFile("app/legal/PRIVACY.md");
  const notices = await readPackageFile("app/legal/THIRD_PARTY_NOTICES.md");
  assert.match(privacy, /凭证使用 AES-256-GCM 加密/u);
  assert.match(privacy, /用户.*明确授权的目录/u);
  assert.match(privacy, /共享目录和授权目录中的视频应始终保留/u);
  assert.match(privacy, /fnOS 可能在卸载时删除应用私有目录/u);
  assert.match(notices, /Node\.js/u);
  assert.match(notices, /FFmpeg/u);
  assert.match(notices, /SBOM/u);
});
