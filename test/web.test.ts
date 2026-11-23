import assert from "node:assert/strict";
import { test } from "node:test";

import {
  allowedGatewayOrigin,
  allowedLocalOrigin,
  isSafeRequestPath,
  isWithinBasePath,
  withBasePath,
} from "../src/web.js";

test("web paths reject traversal, encoded separators, and duplicate slashes", () => {
  assert.equal(isSafeRequestPath("/app/xiaomi-camera-daily-story/api/status"), true);
  assert.equal(isSafeRequestPath("/app//api/status"), false);
  assert.equal(isSafeRequestPath("/app/%2e%2e/api/status"), false);
  assert.equal(isSafeRequestPath("/app/%2Fapi/status"), false);
  assert.equal(isSafeRequestPath("/app/../api/status"), false);
});

test("base path membership requires a complete path segment", () => {
  const basePath = "/app/xiaomi-camera-daily-story";
  assert.equal(withBasePath(basePath, "/api/status"), `${basePath}/api/status`);
  assert.equal(isWithinBasePath(`${basePath}/api/status`, basePath), true);
  assert.equal(isWithinBasePath(`${basePath}-attacker/api/status`, basePath), false);
});

test("origin checks bind writes to the active local or gateway origin", () => {
  assert.equal(allowedLocalOrigin("http://127.0.0.1:3210", 3210), true);
  assert.equal(allowedLocalOrigin("http://127.0.0.1:4321", 3210), false);
  assert.equal(
    allowedGatewayOrigin("https://nas.example:5666", {
      host: "internal-gateway",
      "x-forwarded-host": "nas.example:5666",
      "x-forwarded-proto": "https",
    }),
    true,
  );
  assert.equal(
    allowedGatewayOrigin("https://attacker.example", {
      host: "nas.example:5666",
      "sec-fetch-site": "cross-site",
    }),
    false,
  );
  assert.equal(
    allowedGatewayOrigin("http://nas.example:5666", {
      host: "internal-unix-gateway",
      "x-requested-with": "XiaomiDailyStoryUI",
    }),
    true,
  );
  assert.equal(
    allowedGatewayOrigin("https://attacker.example", {
      host: "internal-unix-gateway",
      "sec-fetch-site": "cross-site",
      "x-requested-with": "XiaomiDailyStoryUI",
    }),
    false,
  );
  assert.equal(
    allowedGatewayOrigin("http://nas.example:5666", {
      host: "internal-unix-gateway",
      "x-requested-with": "untrusted-client",
    }),
    false,
  );
});
