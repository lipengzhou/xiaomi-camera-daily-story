import { constants } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureLocalEnvironment(root) {
  const target = path.join(root, ".env.local");
  try {
    await copyFile(path.join(root, ".env.example"), target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  ensureLocalEnvironment(root).then((created) => {
    console.log(created ? "已生成 .env.local 配置模板。" : "使用现有 .env.local，本次不会覆盖。");
    console.log("请在 .env.local 配置端口、归档目录和 FFmpeg/ffprobe 路径。修改后重启 npm run dev。");
    console.log("默认设置可以直接启动；扫码后的加密授权凭证存放在 .dev/local/（可在配置中调整），该目录不提交到 Git。");
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
