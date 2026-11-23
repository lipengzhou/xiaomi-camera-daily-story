import assert from "node:assert/strict";
import { test } from "node:test";

import { nextShanghaiRun, storyDateFromCreateTime } from "../src/sync/date.js";

test("daily story date is the Shanghai calendar day before createTime", () => {
  assert.equal(storyDateFromCreateTime(1_794_956_975_950), "2026-11-17");
  assert.equal(storyDateFromCreateTime(1_794_430_791_767), "2026-11-11");
});

test("daily scheduler selects today before the configured time", () => {
  const now = new Date("2026-11-18T00:00:00.000Z"); // 08:00 Shanghai
  assert.equal(nextShanghaiRun(now, "08:17").toISOString(), "2026-11-18T00:17:00.000Z");
});

test("daily scheduler rolls to tomorrow after the configured time", () => {
  const now = new Date("2026-11-18T01:00:00.000Z"); // 09:00 Shanghai
  assert.equal(nextShanghaiRun(now, "08:17").toISOString(), "2026-11-19T00:17:00.000Z");
});
