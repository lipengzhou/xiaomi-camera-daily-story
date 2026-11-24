import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP = "xiaomi-camera-daily-story";
const COMPOSE_FILES = ["docker-compose.yaml", "docker-compose.template.yaml"];
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

export async function checksum(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export function runCommand(command, args, { cwd, capture = false, env = process.env } = {}) {
  const npmCandidates = [
    env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  const npmCli = command === "npm" ? npmCandidates.find((file) => file && existsSync(file)) : null;
  if (command === "npm" && process.platform === "win32" && !npmCli) {
    throw new Error("找不到 npm CLI，请安装完整 Node.js 并通过 npm run 执行构建脚本。");
  }
  const executable = npmCli ? process.execPath : command;
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const result = spawnSync(executable, commandArgs, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} 执行失败（${result.status ?? result.signal}）${capture ? `：${result.stderr?.trim() ?? ""}` : ""}`);
  }
  return result.stdout ?? "";
}

export function parseOptions(argv) {
  if (argv.includes("--help")) return { command: "help", arch: "amd64" };
  const [command = "help", ...rest] = argv;
  const options = { command, arch: "amd64" };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!["--arch", "--image", "--host"].includes(key) || !value || value.startsWith("--")) {
      throw new Error(`无效参数：${key ?? ""}`);
    }
    options[key.slice(2)] = value;
  }
  if (!["help", "sync", "media", "docker-test", "fpk", "test-build", "test-deploy", "release"].includes(command)) {
    throw new Error(`未知命令：${command}`);
  }
  if (!["amd64", "arm64"].includes(options.arch)) throw new Error("--arch 只能是 amd64 或 arm64。");
  if (options.host && !/^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/u.test(options.host)) {
    throw new Error("--host 应为 SSH 配置别名或主机地址。");
  }
  if (options.image) {
    const [registry, ...segments] = options.image.split("/");
    if (!registry || !/[.:]/u.test(registry) || !/^[a-z0-9.-]+(?::\d+)?$/u.test(registry) ||
        segments.length === 0 || segments.some((part) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u.test(part))) {
      throw new Error("--image 应为完整仓库地址，不包含 tag、digest 或凭据。");
    }
  }
  if (command === "release" && !options.image) throw new Error("正式发布必须提供 --image 镜像仓库地址。");
  if (command === "test-deploy" && !options.host) throw new Error("NAS 预载必须提供 --host SSH 目标。");
  return options;
}

export async function synchronizeVersion(root) {
  const packageFile = path.join(root, "package.json");
  const pkg = JSON.parse(await readFile(packageFile, "utf8"));
  const version = pkg.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error("package.json 的版本必须是可用作 Docker tag 的应用版本，不支持 +build 元数据。");
  }
  const lockFile = path.join(root, "package-lock.json");
  const lock = JSON.parse(await readFile(lockFile, "utf8"));
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
  await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const packageRoot = path.join(root, "fnos", APP);
  const manifestFile = path.join(packageRoot, "manifest");
  const manifest = await readFile(manifestFile, "utf8");
  if (!/^version=/mu.test(manifest)) throw new Error("FPK manifest 缺少 version。");
  await writeFile(manifestFile, manifest.replace(/^version=.*$/mu, `version=${version}`));
  for (const name of COMPOSE_FILES) {
    const file = path.join(packageRoot, "app", "docker", name);
    const compose = await readFile(file, "utf8");
    if (!/^\s*image:\s*\S+/mu.test(compose)) throw new Error(`${name} 缺少 image。`);
    await writeFile(file, compose.replace(/^(\s*image:\s*)\S+$/mu, `$1${APP}:${version}`));
  }
  const indexFile = path.join(root, "public", "index.html");
  const index = await readFile(indexFile, "utf8");
  await writeFile(indexFile, index.replace(/((?:styles\.css|app\.js)\?v=)[^"'\s]+/gu, `$1${version}`));
  return version;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function nasPrepareScript(version, arch) {
  return `#!/bin/bash
set -euo pipefail
cd -- "$(dirname -- "\${BASH_SOURCE[0]}")"
[ "$(id -u)" -eq 0 ] || { echo "请通过 sudo bash 执行此脚本。" >&2; exit 1; }
case "$(uname -m)" in
  x86_64) host_arch=amd64 ;;
  aarch64|arm64) host_arch=arm64 ;;
  *) echo "不支持的 NAS 架构。" >&2; exit 1 ;;
esac
[ "$host_arch" = ${shellQuote(arch)} ] || { echo "镜像与 NAS 架构不匹配。" >&2; exit 1; }
sha256sum -c SHA256SUMS
docker load -i ${shellQuote(`${APP}-${version}-${arch}.tar`)}
actual_platform="$(docker image inspect ${shellQuote(`${APP}:${version}`)} --format '{{.Os}}/{{.Architecture}}')"
[ "$actual_platform" = ${shellQuote(`linux/${arch}`)} ] || { echo "导入后的镜像架构校验失败。" >&2; exit 1; }
echo "镜像预载完成：${APP}:${version}。请在应用中心 Web UI 手动安装同目录的 FPK。"
`;
}

export class Workflow {
  constructor(root, run = runCommand) {
    this.root = root;
    this.run = (command, args, options = {}) => run(command, args, { cwd: root, ...options });
  }

  async initialize() {
    this.version = await synchronizeVersion(this.root);
    this.outputRoot = path.join(this.root, ".dev", "artifacts");
    await mkdir(this.outputRoot, { recursive: true });
  }

  check() {
    this.run("npm", ["run", "check"]);
  }

  media(arch) {
    const image = `${APP}-build:${this.version}-${arch}`;
    this.run("docker", ["buildx", "build", "--platform", `linux/${arch}`, "--target", "build", "--tag", image, "--load", "."]);
    this.run("docker", ["run", "--rm", "--platform", `linux/${arch}`, "--user", "node", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=64m,mode=1777", "--env", "npm_config_cache=/tmp/npm-cache",
      "--mount", `type=bind,src=${path.join(this.root, "container-test")},dst=/app/container-test,readonly`, image, "npm", "run", "test:container"]);
  }

  async pack(workspace, image) {
    const staged = path.join(workspace, "package");
    await cp(path.join(this.root, "fnos", APP), staged, { recursive: true });
    for (const name of COMPOSE_FILES) {
      const file = path.join(staged, "app", "docker", name);
      await writeFile(file, (await readFile(file, "utf8")).replace(/^(\s*image:\s*)\S+$/mu, `$1${image}`));
    }
    this.run("fnpack", ["build", "--directory", staged], { cwd: workspace });
    const generated = path.join(workspace, `${APP}.fpk`);
    const artifact = path.join(workspace, `${APP}-${this.version}.fpk`);
    if ((await stat(generated)).size === 0) throw new Error("fnpack 生成了空 FPK。");
    await rename(generated, artifact);
    await rm(staged, { recursive: true, force: true });
    return path.basename(artifact);
  }

  dockerTest(arch) {
    const image = `${APP}-test:${this.version}-${arch}`;
    this.run("docker", ["buildx", "build", "--platform", `linux/${arch}`, "--target", "test", "--tag", image, "--load", "."]);
    this.run("docker", ["run", "--rm", "--platform", `linux/${arch}`, "--user", "node", "--read-only", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=64m,mode=1777", "--env", "npm_config_cache=/tmp/npm-cache", image]);
  }

  async finalize(workspace, kind, arch, image, names) {
    const files = [];
    for (const name of names) files.push({ name, sha256: await checksum(path.join(workspace, name)) });
    await writeFile(path.join(workspace, "SHA256SUMS"), files.map((file) => `${file.sha256}  ${file.name}\n`).join(""));
    await writeFile(path.join(workspace, "artifacts.json"), `${JSON.stringify({ version: this.version, kind, arch, image, files }, null, 2)}\n`);
    const directory = path.join(this.outputRoot, kind, this.version, ...(arch ? [arch] : []));
    await mkdir(path.dirname(directory), { recursive: true });
    await rm(directory, { recursive: true, force: true });
    await rename(workspace, directory);
    console.log(`产物已生成：${directory}`);
    return directory;
  }

  async buildTest(arch) {
    this.check();
    this.media(arch);
    const workspace = await mkdtemp(path.join(this.outputRoot, ".test-"));
    try {
      const image = `${APP}:${this.version}`;
      this.run("docker", ["buildx", "build", "--platform", `linux/${arch}`, "--target", "runtime", "--tag", image, "--load", "."]);
      const archive = `${APP}-${this.version}-${arch}.tar`;
      this.run("docker", ["save", "-o", path.join(workspace, archive), image]);
      if ((await stat(path.join(workspace, archive))).size === 0) throw new Error("Docker 导出了空镜像归档。");
      const fpk = await this.pack(workspace, image);
      await writeFile(path.join(workspace, "prepare-nas.sh"), nasPrepareScript(this.version, arch), { mode: 0o755 });
      return await this.finalize(workspace, "test", arch, image, [archive, fpk, "prepare-nas.sh"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async buildFpk() {
    this.check();
    const workspace = await mkdtemp(path.join(this.outputRoot, ".fpk-"));
    try {
      const image = `${APP}:${this.version}`;
      const fpk = await this.pack(workspace, image);
      const directory = await this.finalize(workspace, "fpk", null, image, [fpk]);
      await cp(path.join(directory, fpk), path.join(this.root, `${APP}.fpk`));
      return directory;
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async deployTest(arch, host) {
    const directory = path.join(this.outputRoot, "test", this.version, arch);
    const metadata = JSON.parse(await readFile(path.join(directory, "artifacts.json"), "utf8"));
    const expected = [`${APP}-${this.version}-${arch}.tar`, `${APP}-${this.version}.fpk`, "prepare-nas.sh"];
    if (metadata.kind !== "test" || metadata.version !== this.version || metadata.arch !== arch || metadata.image !== `${APP}:${this.version}` ||
        metadata.files?.length !== expected.length || expected.some((name) => !metadata.files.some((file) => file.name === name))) {
      throw new Error("测试产物与当前版本或架构不一致，请重新构建。");
    }
    for (const file of metadata.files) {
      if (await checksum(path.join(directory, file.name)) !== file.sha256) throw new Error(`产物校验失败：${file.name}`);
    }
    const sums = metadata.files.map((file) => `${file.sha256}  ${file.name}\n`).join("");
    if (await readFile(path.join(directory, "SHA256SUMS"), "utf8") !== sums) throw new Error("SHA256SUMS 与产物信息不一致。");
    const remote = `.xiaomi-camera-daily-story-upgrade/${randomUUID()}`;
    this.run("ssh", ["--", host, `umask 077; mkdir -p -- ${shellQuote(remote)}`]);
    this.run("scp", ["--", ...expected.map((name) => path.join(directory, name)), path.join(directory, "SHA256SUMS"), `${host}:${remote}/`]);
    this.run("ssh", ["-tt", "--", host, `sudo bash ${shellQuote(`${remote}/prepare-nas.sh`)}`]);
    console.log(`NAS 镜像已预载。通过应用中心 Web UI 上传：${path.join(directory, expected[1])}`);
    console.log(`验收后可清理 NAS 本次上传目录：~/${remote}`);
  }

  async release(repository) {
    this.run("fnpack", ["build", "--help"], { capture: true });
    const image = `${repository}:${this.version}`;
    try {
      this.run("docker", ["buildx", "imagetools", "inspect", image, "--raw"], { capture: true });
    } catch (error) {
      if (!/manifest unknown|not found|404/iu.test(String(error)) || /unauthorized|denied|authentication/iu.test(String(error))) throw error;
      return this.publishRelease(repository, image);
    }
    throw new Error(`镜像版本已存在，禁止覆盖：${image}。请先递增应用版本。`);
  }

  async publishRelease(repository, image) {
    this.check();
    this.media("amd64");
    this.media("arm64");
    const workspace = await mkdtemp(path.join(this.outputRoot, ".release-"));
    try {
      const metadataFile = path.join(workspace, "build-metadata.json");
      this.run("docker", ["buildx", "build", "--platform", "linux/amd64,linux/arm64", "--target", "runtime", "--tag", image,
        "--metadata-file", metadataFile, "--provenance=true", "--sbom=true", "--push", "."]);
      const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
      const digest = metadata["containerimage.digest"];
      if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) throw new Error("构建结果没有有效的镜像摘要，停止生成正式 FPK。");
      const lockedImage = `${image}@${digest}`;
      const index = JSON.parse(this.run("docker", ["buildx", "imagetools", "inspect", `${repository}@${digest}`, "--raw"], { capture: true }));
      const platforms = new Set((index.manifests ?? []).filter((item) => item.platform?.os === "linux").map((item) => item.platform.architecture));
      if (!platforms.has("amd64") || !platforms.has("arm64")) throw new Error("已发布镜像缺少 amd64 或 arm64，停止生成正式 FPK。");
      const fpk = await this.pack(workspace, lockedImage);
      await writeFile(path.join(workspace, "image.json"), `${JSON.stringify({ image: lockedImage, platforms: ["linux/amd64", "linux/arm64"], sbom: "镜像 OCI attestation" }, null, 2)}\n`);
      await rm(metadataFile, { force: true });
      return await this.finalize(workspace, "release", null, lockedImage, [fpk, "image.json"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.command === "help") {
    console.log("用法：node scripts/workflow.mjs sync|media|docker-test|fpk|test-build|test-deploy|release [--arch amd64|arm64] [--host SSH目标] [--image 完整镜像仓库地址]\nrelease 会推送镜像；test-deploy 会上传并预载镜像。两个命令均不会安装或升级 fnOS 应用。");
    return;
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const workflow = new Workflow(root);
  await workflow.initialize();
  switch (options.command) {
    case "sync": console.log(`应用版本已同步：${workflow.version}`); break;
    case "media": workflow.media(options.arch); break;
    case "docker-test": workflow.dockerTest(options.arch); break;
    case "fpk": await workflow.buildFpk(); break;
    case "test-build": await workflow.buildTest(options.arch); break;
    case "test-deploy": await workflow.deployTest(options.arch, options.host); break;
    case "release": await workflow.release(options.image); break;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
