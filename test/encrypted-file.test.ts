import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { AuthRequiredError } from "../src/errors.js";
import { EncryptedFileCredentialStore } from "../src/platform/encrypted-file.js";
import type { XiaomiSession } from "../src/types.js";

const session: XiaomiSession = {
  userId: "xiaomi-user-1",
  cUserId: "xiaomi-c-user-2",
  passToken: "pass-token-plaintext-marker",
  ssecurity: "MDEyMzQ1Njc4OWFiY2RlZg==",
  serviceToken: "service-token-plaintext-marker",
  userAgent: "credential-test",
  createdAt: 1,
  refreshedAt: 2,
};

async function fixture(): Promise<{
  directory: string;
  keyFile: string;
  credentialFile: string;
}> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xiaomi-encrypted-credentials-"));
  return {
    directory,
    keyFile: path.join(directory, "config", "credential.key"),
    credentialFile: path.join(directory, "data", "credentials.enc"),
  };
}

test("encrypted file store persists a session without plaintext tokens", async () => {
  const paths = await fixture();
  try {
    const store = new EncryptedFileCredentialStore(paths);
    assert.equal(await store.get(), null);
    await store.set(session);

    const key = await readFile(paths.keyFile);
    const ciphertext = await readFile(paths.credentialFile, "utf8");
    assert.equal(key.length, 32);
    if (process.platform !== "win32") {
      assert.equal((await stat(paths.keyFile)).mode & 0o777, 0o600);
      assert.equal((await stat(paths.credentialFile)).mode & 0o777, 0o600);
    }
    assert.doesNotMatch(ciphertext, /pass-token-plaintext-marker/);
    assert.doesNotMatch(ciphertext, /service-token-plaintext-marker/);
    assert.deepEqual(await store.get(), session);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("encrypted file store survives restart and returns cloned sessions", async () => {
  const paths = await fixture();
  try {
    await new EncryptedFileCredentialStore(paths).set(session);
    const restarted = new EncryptedFileCredentialStore(paths);
    const first = await restarted.get();
    first!.userId = "changed";
    assert.deepEqual(await restarted.get(), session);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("encrypted file store rejects a wrong key and tampered ciphertext", async () => {
  const wrongKeyPaths = await fixture();
  const tamperedPaths = await fixture();
  try {
    await new EncryptedFileCredentialStore(wrongKeyPaths).set(session);
    await writeFile(wrongKeyPaths.keyFile, Buffer.alloc(32, 7));
    await assert.rejects(
      () => new EncryptedFileCredentialStore(wrongKeyPaths).get(),
      AuthRequiredError,
    );

    await new EncryptedFileCredentialStore(tamperedPaths).set(session);
    const envelope = JSON.parse(
      await readFile(tamperedPaths.credentialFile, "utf8"),
    ) as { ciphertext: string };
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    envelope.ciphertext = ciphertext.toString("base64");
    await writeFile(tamperedPaths.credentialFile, JSON.stringify(envelope));
    await assert.rejects(
      () => new EncryptedFileCredentialStore(tamperedPaths).get(),
      AuthRequiredError,
    );
  } finally {
    await Promise.all([
      rm(wrongKeyPaths.directory, { recursive: true, force: true }),
      rm(tamperedPaths.directory, { recursive: true, force: true }),
    ]);
  }
});

test("encrypted file store serializes mutations and retains the master key on clear", async () => {
  const paths = await fixture();
  try {
    const store = new EncryptedFileCredentialStore(paths);
    await Promise.all([
      store.set({ ...session, userId: "first" }),
      store.set({ ...session, userId: "second" }),
      store.clear(),
    ]);
    assert.equal(await store.get(), null);
    assert.equal((await readFile(paths.keyFile)).length, 32);
    await assert.rejects(() => stat(paths.credentialFile), { code: "ENOENT" });
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test("a successful reauthorization replaces an unusable master key", async () => {
  const paths = await fixture();
  try {
    await new EncryptedFileCredentialStore(paths).set(session);
    await writeFile(paths.keyFile, Buffer.from("truncated"));
    await assert.rejects(
      () => new EncryptedFileCredentialStore(paths).get(),
      AuthRequiredError,
    );

    const reauthorized = new EncryptedFileCredentialStore(paths);
    await reauthorized.set({ ...session, refreshedAt: 3 });
    assert.equal((await readFile(paths.keyFile)).length, 32);
    assert.equal(
      (await new EncryptedFileCredentialStore(paths).get())?.refreshedAt,
      3,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});
