import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Workflow, checksum, parseOptions, runCommand, synchronizeVersion } from "../scripts/workflow.mjs";

const APP = "xiaomi-camera-daily-story";
const version = "3.4.5";
const digest = `sha256:${"a".repeat(64)}`;

async function fixture(context: { after: (cleanup: () => Promise<unknown>) => void }): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "xiaomi-workflow-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["fnos", "public"]) {
    await cp(path.join(process.cwd(), name), path.join(root, name), { recursive: true });
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version }));
  await writeFile(path.join(root, "package-lock.json"), JSON.stringify({ version: "0.0.0", packages: { "": { version: "0.0.0" } } }));
  return root;
}

function fakeTools({ existingImage = false, platforms = ["amd64", "arm64"] } = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const run = (command: string, args: string[], options: { cwd: string; capture?: boolean }) => {
    calls.push({ command, args });
    if (command === "docker" && args.includes("imagetools")) {
      const reference = args[3]!;
      if (!reference.includes("@")) {
        if (existingImage) return "{}";
        throw new Error("manifest unknown");
      }
      return JSON.stringify({ manifests: platforms.map((architecture) => ({ platform: { os: "linux", architecture } })) });
    }
    if (command === "docker" && args[0] === "save") {
      writeFileSync(args[args.indexOf("-o") + 1]!, "fake image archive");
    }
    if (command === "docker" && args.includes("--metadata-file")) {
      writeFileSync(args[args.indexOf("--metadata-file") + 1]!, JSON.stringify({ "containerimage.digest": digest }));
    }
    if (command === "fnpack" && args.includes("--directory")) {
      const staged = args[args.indexOf("--directory") + 1]!;
      const manifest = readFileSync(path.join(staged, "manifest"), "utf8");
      const compose = readFileSync(path.join(staged, "app/docker/docker-compose.yaml"), "utf8");
      const template = readFileSync(path.join(staged, "app/docker/docker-compose.template.yaml"), "utf8");
      writeFileSync(path.join(options.cwd, `${APP}.fpk`), JSON.stringify({ manifest, compose, template }));
    }
    return "";
  };
  return { calls, run };
}

test("test build uses package version for image, FPK, cache URLs and checksummed NAS preparation", async (context) => {
  const root = await fixture(context);
  const tools = fakeTools();
  const workflow = new Workflow(root, tools.run);
  await workflow.initialize();
  const directory = await workflow.buildTest("arm64");
  const metadata = JSON.parse(await readFile(path.join(directory, "artifacts.json"), "utf8"));
  assert.equal(metadata.version, version);
  assert.equal(metadata.arch, "arm64");
  assert.equal(metadata.image, `${APP}:${version}`);
  const fpk = JSON.parse(await readFile(path.join(directory, `${APP}-${version}.fpk`), "utf8"));
  assert.match(fpk.manifest, new RegExp(`^version=${version}$`, "m"));
  assert.ok(fpk.compose.includes(`image: ${APP}:${version}`));
  assert.equal(fpk.template, fpk.compose);
  assert.ok((await readFile(path.join(root, "public/index.html"), "utf8")).includes(`app.js?v=${version}`));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  assert.equal(lock.packages[""].version, version);
  for (const file of metadata.files) assert.equal(await checksum(path.join(directory, file.name)), file.sha256);
  const prepare = await readFile(path.join(directory, "prepare-nas.sh"), "utf8");
  assert.ok(prepare.indexOf("sha256sum -c") < prepare.indexOf("docker load"));
  assert.ok(prepare.includes("镜像与 NAS 架构不匹配"));
  assert.ok(prepare.includes(`linux/arm64`));
  assert.doesNotMatch(prepare, /appcenter-cli|install-local/u);
  assert.equal(tools.calls.find((call) => call.command === "docker" && call.args[0] === "save")?.args.at(-1), `${APP}:${version}`);
});

test("NAS deployment refuses damaged artifacts before connecting or uploading", async (context) => {
  const root = await fixture(context);
  const tools = fakeTools();
  const workflow = new Workflow(root, tools.run);
  await workflow.initialize();
  const directory = await workflow.buildTest("amd64");
  await writeFile(path.join(directory, `${APP}-${version}-amd64.tar`), "damaged archive");
  await assert.rejects(workflow.deployTest("amd64", "nas-test"), /产物校验失败/u);
  assert.equal(tools.calls.some((call) => ["ssh", "scp"].includes(call.command)), false);
});

test("formal build locks the multi-architecture digest without changing local Compose or including a tar", async (context) => {
  const root = await fixture(context);
  const tools = fakeTools();
  const workflow = new Workflow(root, tools.run);
  await workflow.initialize();
  const directory = await workflow.release("registry.example.invalid/team/camera");
  const fpk = JSON.parse(await readFile(path.join(directory, `${APP}-${version}.fpk`), "utf8"));
  assert.ok(fpk.compose.includes(`registry.example.invalid/team/camera:${version}@${digest}`));
  assert.equal(fpk.template, fpk.compose);
  const sourceCompose = await readFile(path.join(root, `fnos/${APP}/app/docker/docker-compose.yaml`), "utf8");
  assert.ok(sourceCompose.includes(`image: ${APP}:${version}`));
  const metadata = JSON.parse(await readFile(path.join(directory, "artifacts.json"), "utf8"));
  assert.equal(metadata.image, `registry.example.invalid/team/camera:${version}@${digest}`);
  assert.equal(metadata.files.some((file: { name: string }) => file.name.endsWith(".tar")), false);
  assert.ok(tools.calls.some((call) => call.args.includes("--push") && call.args.includes("linux/amd64,linux/arm64")));
  assert.ok(tools.calls.some((call) => call.args.includes("--sbom=true")));
});

test("formal build refuses an existing published tag and incomplete platform indexes", async (context) => {
  const root = await fixture(context);
  const existing = fakeTools({ existingImage: true });
  const workflow = new Workflow(root, existing.run);
  await workflow.initialize();
  await assert.rejects(workflow.release("registry.example.invalid/team/camera"), /禁止覆盖/u);
  assert.equal(existing.calls.some((call) => call.args.includes("--push")), false);

  const incomplete = fakeTools({ platforms: ["amd64"] });
  const workflow2 = new Workflow(root, incomplete.run);
  await workflow2.initialize();
  await assert.rejects(workflow2.release("registry.example.invalid/team/camera"), /缺少 amd64 或 arm64/u);
  assert.equal(incomplete.calls.some((call) => call.command === "fnpack" && call.args.includes("--directory")), false);
  assert.equal(existsSync(path.join(root, ".dev/artifacts/release", version)), false);
});

test("workflow rejects unsupported platforms, credential-bearing image addresses and invalid versions", async (context) => {
  assert.throws(() => parseOptions(["test-build", "--arch", "x86"]), /--arch/u);
  assert.throws(() => parseOptions(["release", "--image", "user:password@registry.example.invalid/team/camera"]), /不包含/u);
  assert.throws(() => parseOptions(["release"]), /--image/u);
  assert.throws(() => parseOptions(["test-deploy", "--host", "nas; id"]), /--host/u);
  const root = await fixture(context);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "../../elsewhere" }));
  await assert.rejects(synchronizeVersion(root), /版本/u);
});

test("npm patch version runs the synchronization hook without a Git commit or tag", async (context) => {
  const root = await fixture(context);
  await cp(path.join(process.cwd(), "scripts"), path.join(root, "scripts"), { recursive: true });
  const scripts = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")).scripts;
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "workflow-fixture", version,
    scripts: { postversion: scripts.postversion, "version:sync": scripts["version:sync"] } }));
  runCommand("npm", ["version", "patch", "--no-git-tag-version"], {
    cwd: root, capture: true, env: { ...process.env, npm_config_ignore_scripts: "false" },
  });
  const nextVersion = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;
  assert.equal(nextVersion, "3.4.6");
  const manifest = await readFile(path.join(root, `fnos/${APP}/manifest`), "utf8");
  assert.ok(manifest.includes(`version=${nextVersion}`));
  assert.ok((await readFile(path.join(root, "public/index.html"), "utf8")).includes(`app.js?v=${nextVersion}`));
  assert.equal(existsSync(path.join(root, ".git")), false);
});
