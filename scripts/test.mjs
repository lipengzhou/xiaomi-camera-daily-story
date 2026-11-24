import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = process.argv[2] ?? "test";
if (!["test", "container-test"].includes(directory)) throw new Error("测试目录只能是 test 或 container-test。");
const files = (await readdir(path.join(root, directory)))
  .filter((file) => file.endsWith(".test.ts")).sort().map((file) => path.join(root, directory, file));
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
