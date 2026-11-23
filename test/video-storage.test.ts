import assert from "node:assert/strict";
import { test } from "node:test";

import type { RuntimePaths } from "../src/platform/types.js";
import { resolveVideoRoot, videoStorageOptions } from "../src/video-storage.js";

function paths(withAuthorizedRoots = false): RuntimePaths {
  return {
    configDir: "/config",
    dataDir: "/data",
    downloadRoot: "/videos",
    ...(withAuthorizedRoots
      ? {
          authorizedDownloadRoots: [
            {
              id: "accessible:111111111111" as const,
              label: "Movies",
              path: "/authorized-videos-111111111111",
              available: true,
            },
            {
              id: "accessible:222222222222" as const,
              label: "Photos",
              path: "/authorized-videos-222222222222",
              available: true,
            },
          ],
        }
      : {}),
    credentialKeyFile: "/config/credential.key",
    credentialFile: "/data/credentials.enc",
    configFile: "/data/config.json",
    historyFile: "/data/sync-history.json",
  };
}

test("video storage keeps data-share as the default and exposes authorized roots", () => {
  assert.equal(resolveVideoRoot(paths(), "data-share"), "/videos");
  assert.deepEqual(videoStorageOptions(paths(), "fnos"), [
    {
      id: "data-share",
      label: "应用文件/xiaomi-camera-daily-story/videos",
      path: "/videos",
      available: true,
    },
  ]);

  const authorized = paths(true);
  assert.deepEqual(videoStorageOptions(authorized, "fnos").map((option) => option.label), [
    "应用文件/xiaomi-camera-daily-story/videos",
    "Movies",
    "Photos",
  ]);
  assert.equal(
    resolveVideoRoot(authorized, "accessible:222222222222"),
    "/authorized-videos-222222222222",
  );
});

test("video storage refuses an authorized selection when no folder is mounted", () => {
  assert.throws(
    () => resolveVideoRoot(paths(), "accessible:111111111111"),
    /所选 fnOS 授权文件夹当前不可用/,
  );
});
