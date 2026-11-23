import { AuthRequiredError } from "./errors.js";
import type { XiaomiSession } from "./types.js";

export function validateStoredSession(value: unknown): XiaomiSession {
  if (!value || typeof value !== "object") {
    throw new AuthRequiredError("保存的米家凭证格式无效，请重新扫码授权。");
  }
  const session = value as Partial<XiaomiSession>;
  for (const key of [
    "userId",
    "cUserId",
    "passToken",
    "ssecurity",
    "serviceToken",
    "userAgent",
  ] as const) {
    if (typeof session[key] !== "string") {
      throw new AuthRequiredError("保存的米家凭证不完整，请重新扫码授权。");
    }
  }
  if (typeof session.createdAt !== "number" || typeof session.refreshedAt !== "number") {
    throw new AuthRequiredError("保存的米家凭证时间字段无效，请重新扫码授权。");
  }
  return session as XiaomiSession;
}

export interface CredentialStore {
  get(): Promise<XiaomiSession | null>;
  set(session: XiaomiSession): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryCredentialStore implements CredentialStore {
  private session: XiaomiSession | null = null;

  async get(): Promise<XiaomiSession | null> {
    return this.session ? structuredClone(this.session) : null;
  }

  async set(session: XiaomiSession): Promise<void> {
    this.session = structuredClone(session);
  }

  async clear(): Promise<void> {
    this.session = null;
  }
}
