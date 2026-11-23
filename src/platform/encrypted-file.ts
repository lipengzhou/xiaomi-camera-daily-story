import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  validateStoredSession,
  type CredentialStore,
} from "../credentials.js";
import { AuthRequiredError } from "../errors.js";
import type { XiaomiSession } from "../types.js";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;
const AAD = Buffer.from(
  "xiaomi-camera-daily-story\0xiaomi-session\0v1",
  "utf8",
);

interface CredentialEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface EncryptedFileCredentialPaths {
  keyFile: string;
  credentialFile: string;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

function decodeBase64(value: unknown, expectedBytes?: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new AuthRequiredError("加密凭证格式无效，请重新扫码授权。");
  }
  const decoded = Buffer.from(value, "base64");
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new AuthRequiredError("加密凭证格式无效，请重新扫码授权。");
  }
  return decoded;
}

function parseEnvelope(value: unknown): CredentialEnvelope {
  if (!value || typeof value !== "object") {
    throw new AuthRequiredError("加密凭证格式无效，请重新扫码授权。");
  }
  const candidate = value as Partial<CredentialEnvelope>;
  if (candidate.version !== ENVELOPE_VERSION || candidate.algorithm !== "aes-256-gcm") {
    throw new AuthRequiredError("加密凭证版本不受支持，请重新扫码授权。");
  }
  decodeBase64(candidate.iv, IV_BYTES);
  decodeBase64(candidate.tag, TAG_BYTES);
  decodeBase64(candidate.ciphertext);
  return candidate as CredentialEnvelope;
}

async function atomicWritePrivate(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class EncryptedFileCredentialStore implements CredentialStore {
  private cached: XiaomiSession | null = null;
  private initialized = false;
  private key: Buffer | null = null;
  private lock: Promise<void> = Promise.resolve();

  constructor(private readonly paths: EncryptedFileCredentialPaths) {}

  async get(): Promise<XiaomiSession | null> {
    return this.withLock(async () => {
      if (!this.initialized) {
        this.cached = await this.readCredential();
        this.initialized = true;
      }
      return this.cached ? structuredClone(this.cached) : null;
    });
  }

  async set(session: XiaomiSession): Promise<void> {
    const validated = validateStoredSession(session);
    await this.withLock(async () => {
      const key = await this.getOrCreateKey(true);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify(validated), "utf8"),
        cipher.final(),
      ]);
      const envelope: CredentialEnvelope = {
        version: ENVELOPE_VERSION,
        algorithm: "aes-256-gcm",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
      await atomicWritePrivate(
        this.paths.credentialFile,
        `${JSON.stringify(envelope)}\n`,
      );
      this.cached = structuredClone(validated);
      this.initialized = true;
    });
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await rm(this.paths.credentialFile, { force: true });
      this.cached = null;
      this.initialized = true;
    });
  }

  private async readCredential(): Promise<XiaomiSession | null> {
    let raw: string;
    try {
      raw = await readFile(this.paths.credentialFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw new Error(
        `读取加密凭证失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    try {
      const envelope = parseEnvelope(JSON.parse(raw));
      const key = await this.getOrCreateKey();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        decodeBase64(envelope.iv, IV_BYTES),
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(AAD);
      decipher.setAuthTag(decodeBase64(envelope.tag, TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(envelope.ciphertext)),
        decipher.final(),
      ]);
      return validateStoredSession(JSON.parse(plaintext.toString("utf8")));
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        throw error;
      }
      throw new AuthRequiredError(
        "加密凭证已损坏或主密钥不匹配，请重新扫码授权。",
      );
    }
  }

  private async getOrCreateKey(replaceInvalid = false): Promise<Buffer> {
    if (this.key) {
      return this.key;
    }
    await ensurePrivateDirectory(path.dirname(this.paths.keyFile));
    const generated = randomBytes(KEY_BYTES);
    try {
      const handle = await open(this.paths.keyFile, "wx", 0o600);
      try {
        await handle.writeFile(generated);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(this.paths.keyFile, { force: true });
        throw error;
      }
      await handle.close();
      await chmod(this.paths.keyFile, 0o600);
      this.key = generated;
      return generated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `创建凭证主密钥失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
    }
    const stored = await readFile(this.paths.keyFile);
    if (stored.length !== KEY_BYTES) {
      if (replaceInvalid) {
        await rm(this.paths.keyFile, { force: true });
        return this.getOrCreateKey();
      }
      throw new AuthRequiredError("凭证主密钥格式无效，请重新扫码授权。");
    }
    await chmod(this.paths.keyFile, 0o600);
    this.key = stored;
    return stored;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
