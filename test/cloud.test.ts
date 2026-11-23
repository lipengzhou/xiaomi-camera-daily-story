import assert from "node:assert/strict";
import { test } from "node:test";

import type { XiaomiSession } from "../src/types.js";
import { XiaomiCloudClient } from "../src/xiaomi/cloud.js";

const session: XiaomiSession = {
  userId: "1",
  cUserId: "2",
  passToken: "pass",
  ssecurity: "MDEyMzQ1Njc4OWFiY2RlZg==",
  serviceToken: "service",
  userAgent: "test",
  createdAt: 1,
  refreshedAt: 1,
};

test("camera discovery keeps the family name and scopes duplicate devices by family", async () => {
  const responses = [
    {
      code: 0,
      result: {
        homelist: [
          { id: 101, uid: 1, name: "家" },
          { id: 202, uid: 1, name: "父母家" },
        ],
      },
    },
    {
      code: 0,
      result: {
        device_info: [
          { did: "camera-1", model: "chuangmi.camera.1", name: "客厅" },
          { did: "light-1", model: "yeelink.light.1", name: "灯" },
        ],
      },
    },
    {
      code: 0,
      result: {
        device_info: [
          { did: "camera-1", model: "chuangmi.camera.1", name: "门口" },
          { did: "camera-2", model: "isa.camera.2", name: "书房" },
        ],
      },
    },
  ];
  const requestedPaths: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    requestedPaths.push(new URL(String(input)).pathname);
    const payload = responses.shift();
    assert.ok(payload);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const devices = await new XiaomiCloudClient(session, fetchImpl).listCameras();

  assert.deepEqual(
    devices.map(({ did, name, homeId, homeName }) => ({ did, name, homeId, homeName })),
    [
      { did: "camera-1", name: "客厅", homeId: "101", homeName: "家" },
      { did: "camera-1", name: "门口", homeId: "202", homeName: "父母家" },
      { did: "camera-2", name: "书房", homeId: "202", homeName: "父母家" },
    ],
  );
  assert.deepEqual(requestedPaths, [
    "/app/v2/homeroom/gethome",
    "/app/v2/home/home_device_list",
    "/app/v2/home/home_device_list",
  ]);
});
