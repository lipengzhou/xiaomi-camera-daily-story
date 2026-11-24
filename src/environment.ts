import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "dotenv";

export async function loadEnvironmentFiles(
  projectRoot: string = fileURLToPath(new URL("../", import.meta.url)),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  if (environment.NODE_ENV === "production" || environment.XIAOMI_STORY_RUNTIME === "fnos") return [];
  const values: Record<string, string> = {};
  const loaded: string[] = [];
  for (const name of [".env", ".env.local"]) {
    try {
      Object.assign(values, parse(await readFile(path.join(projectRoot, name))));
      loaded.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const [key, value] of Object.entries(values)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return loaded;
}
