import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encryptedSignature,
  generateNonce,
  rc4Crypt,
  signaturePath,
  signedNonce,
} from "../src/xiaomi/crypto.js";

test("RC4 implementation matches the canonical Key/Plaintext vector", () => {
  const encrypted = rc4Crypt(Buffer.from("Key"), Buffer.from("Plaintext"), 0);
  assert.equal(encrypted.toString("hex"), "bbf316e8d940af0ad3");
});

test("Xiaomi nonce and signatures are deterministic with fixed entropy", () => {
  const nonce = generateNonce(1_700_000_000_000, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]));
  assert.equal(nonce, "AAECAwQFBgcBsFUV");
  const nonceKey = signedNonce("MDEyMzQ1Njc4OWFiY2RlZg==", nonce);
  assert.equal(nonceKey, "jJSDtjhNmSIEWHCVcTbRRb9Y2uivglyOL9fqb3Izzbs=");
  const signature = encryptedSignature(
    "GET",
    "https://business.smartcamera.api.io.mi.com/miot/camera/app/v1/dailyStory/playlist",
    new Map([["data", '{"did":"123"}']]),
    nonceKey,
  );
  assert.equal(signature, "XW+C974tk0bhlNjAb6cHZbEtxr8=");
});

test("api.io app paths and camera paths use Xiaomi signature conventions", () => {
  assert.equal(signaturePath("https://api.io.mi.com/app/v2/home/home_device_list"), "/v2/home/home_device_list");
  assert.equal(
    signaturePath("https://business.smartcamera.api.io.mi.com/miot/camera/app/v1/dailyStory/m3u8"),
    "/miot/camera/app/v1/dailyStory/m3u8",
  );
});
