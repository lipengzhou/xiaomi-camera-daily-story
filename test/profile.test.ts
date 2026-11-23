import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decryptProfileValue,
  encryptProfileValue,
  profileSignature,
} from "../src/xiaomi/profile.js";

test("Passport profile AES and signature match fixed Xiaomi vectors", () => {
  const security = "MDEyMzQ1Njc4OWFiY2RlZg==";
  const userId = encryptProfileValue("123", security);
  const flag = encryptProfileValue("2", security);
  assert.equal(userId, "x1Xw9M2bv2bzevfFThOnxA==");
  assert.equal(flag, "BZ6wBlFgysMgUCYkQPFcZg==");
  assert.equal(decryptProfileValue(userId, security), "123");
  const params = new Map([
    ["userId", userId],
    ["flag", flag],
  ]);
  assert.equal(
    profileSignature(
      "GET",
      "https://api.account.xiaomi.com/pass/v2/safe/user/coreInfo",
      params,
      security,
    ),
    "JZhuAloJXWONrh7TZdwzoa+fyfs=",
  );
});
