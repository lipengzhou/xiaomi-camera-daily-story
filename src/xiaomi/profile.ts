import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

import { AppError, AuthRequiredError } from "../errors.js";
import type { XiaomiSession } from "../types.js";

const PROFILE_URL = "https://api.account.xiaomi.com/pass/v2/safe/user/coreInfo";
const DEFAULT_IV = Buffer.from("0102030405060708", "utf8");
const PROFILE_CACHE_MS = 15 * 60 * 1000;
const AVATAR_CACHE_MS = 60 * 60 * 1000;
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

type CookieFetch = (
  input: URL | RequestInfo,
  init?: RequestInit & { maxRedirect?: number; redirectCount?: number },
) => Promise<Response>;

interface PassportSession {
  ssecurity: string;
  serviceToken: string;
  cUserId: string;
}

interface PassportLoginResult {
  ssecurity?: string;
  location?: string;
  cUserId?: string;
}

interface ProfileResponse {
  code?: number;
  description?: string;
  data?: {
    userId?: string | number;
    userName?: string;
    icon?: string;
  };
}

export interface AccountProfile {
  userId: string;
  userName: string;
  avatarSourceUrl: string | null;
  authorizedAt: string;
}

export interface AvatarImage {
  body: Buffer;
  contentType: string;
}

export interface ProfileProvider {
  getProfile(session: XiaomiSession): Promise<AccountProfile>;
  getAvatar(session: XiaomiSession): Promise<AvatarImage | null>;
  clearCache(): void;
}

function parseLoginJson<T>(text: string): T {
  return JSON.parse(text.replace(/^&&&START&&&/, "")) as T;
}

function aesKey(ssecurity: string): Buffer {
  const key = Buffer.from(ssecurity, "base64");
  if (key.length !== 16) {
    throw new AppError("小米 Passport ssecurity 不是有效的 AES-128 密钥。", "PROFILE_KEY_INVALID", 502);
  }
  return key;
}

export function encryptProfileValue(value: string, ssecurity: string): string {
  const cipher = createCipheriv("aes-128-cbc", aesKey(ssecurity), DEFAULT_IV);
  return Buffer.concat([cipher.update(value, "utf8"), cipher.final()]).toString("base64");
}

export function decryptProfileValue(value: string, ssecurity: string): string {
  const decipher = createDecipheriv("aes-128-cbc", aesKey(ssecurity), DEFAULT_IV);
  return Buffer.concat([
    decipher.update(Buffer.from(value.trim(), "base64")),
    decipher.final(),
  ]).toString("utf8");
}

export function profileSignature(
  method: string,
  url: string,
  encryptedParams: ReadonlyMap<string, string>,
  ssecurity: string,
): string {
  const values = [method.toUpperCase(), new URL(url).pathname];
  for (const [key, value] of [...encryptedParams.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    values.push(`${key}=${value}`);
  }
  values.push(ssecurity);
  return createHash("sha1").update(values.join("&"), "utf8").digest("base64");
}

async function cookieValue(jar: CookieJar, name: string, urls: string[]): Promise<string> {
  for (const url of urls) {
    const found = (await jar.getCookies(url)).find((cookie) => cookie.key === name);
    if (found) {
      return found.value;
    }
  }
  return "";
}

function validAvatarUrl(value: string | null): URL | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "mi-img.com" || url.hostname.endsWith(".mi-img.com"))
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export class XiaomiProfileService implements ProfileProvider {
  private profileCache: { key: string; expiresAt: number; value: AccountProfile } | null = null;
  private avatarCache: { url: string; expiresAt: number; value: AvatarImage } | null = null;
  private pendingProfile: Promise<AccountProfile> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  clearCache(): void {
    this.profileCache = null;
    this.avatarCache = null;
    this.pendingProfile = null;
  }

  async getProfile(session: XiaomiSession): Promise<AccountProfile> {
    const cacheKey = `${session.userId}:${session.createdAt}:${session.refreshedAt}`;
    if (
      this.profileCache?.key === cacheKey &&
      this.profileCache.expiresAt > Date.now()
    ) {
      return structuredClone(this.profileCache.value);
    }
    if (this.pendingProfile) {
      return this.pendingProfile;
    }
    this.pendingProfile = this.loadProfile(session)
      .then((profile) => {
        this.profileCache = {
          key: cacheKey,
          expiresAt: Date.now() + PROFILE_CACHE_MS,
          value: profile,
        };
        return structuredClone(profile);
      })
      .finally(() => {
        this.pendingProfile = null;
      });
    return this.pendingProfile;
  }

  async getAvatar(session: XiaomiSession): Promise<AvatarImage | null> {
    const profile = await this.getProfile(session);
    const avatarUrl = validAvatarUrl(profile.avatarSourceUrl);
    if (!avatarUrl) {
      return null;
    }
    if (this.avatarCache?.url === avatarUrl.href && this.avatarCache.expiresAt > Date.now()) {
      return this.avatarCache.value;
    }
    const response = await this.fetchImpl(avatarUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/*" },
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (!response.ok || !contentType.startsWith("image/")) {
      throw new AppError("小米头像下载失败。", "AVATAR_DOWNLOAD_FAILED", 502);
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length === 0 || body.length > MAX_AVATAR_BYTES) {
      throw new AppError("小米头像文件大小异常。", "AVATAR_SIZE_INVALID", 502);
    }
    const value = { body, contentType };
    this.avatarCache = { url: avatarUrl.href, expiresAt: Date.now() + AVATAR_CACHE_MS, value };
    return value;
  }

  private async loadProfile(session: XiaomiSession): Promise<AccountProfile> {
    if (!session.passToken) {
      throw new AuthRequiredError("当前凭证缺少 passToken，需重新扫码后才能读取用户资料。");
    }
    const passport = await this.createPassportSession(session);
    const encrypted = new Map<string, string>([
      ["userId", encryptProfileValue(session.userId, passport.ssecurity)],
      ["flag", encryptProfileValue("2", passport.ssecurity)],
    ]);
    const query = new URLSearchParams([...encrypted.entries()]);
    query.set("signature", profileSignature("GET", PROFILE_URL, encrypted, passport.ssecurity));
    const response = await this.fetchImpl(`${PROFILE_URL}?${query.toString()}`, {
      headers: {
        Cookie: `cUserId=${passport.cUserId}; serviceToken=${passport.serviceToken}`,
        "User-Agent": session.userAgent,
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthRequiredError("读取小米用户资料失败，请重新扫码授权。");
    }
    if (!response.ok) {
      throw new AppError(
        `小米用户资料接口失败：HTTP ${response.status}`,
        "PROFILE_HTTP_ERROR",
        502,
      );
    }
    const profile = JSON.parse(
      decryptProfileValue(await response.text(), passport.ssecurity),
    ) as ProfileResponse;
    if (profile.code !== 0 || !profile.data) {
      throw new AppError(
        profile.description || "小米用户资料响应无效。",
        "PROFILE_API_ERROR",
        502,
      );
    }
    const userId = String(profile.data.userId ?? session.userId);
    const userName = profile.data.userName?.trim() || `小米用户 ${userId}`;
    return {
      userId,
      userName,
      avatarSourceUrl: validAvatarUrl(profile.data.icon ?? null)?.href ?? null,
      authorizedAt: new Date(session.createdAt).toISOString(),
    };
  }

  private async createPassportSession(session: XiaomiSession): Promise<PassportSession> {
    const jar = new CookieJar();
    await jar.setCookie(`userId=${session.userId}; Path=/`, "https://account.xiaomi.com/");
    await jar.setCookie(`passToken=${session.passToken}; Path=/`, "https://account.xiaomi.com/");
    const client = makeFetchCookie(this.fetchImpl, jar) as CookieFetch;
    const loginResponse = await client(
      "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=passportapi",
      {
        headers: { "User-Agent": session.userAgent },
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!loginResponse.ok) {
      throw new AuthRequiredError("无法获取小米 Passport 凭证，请重新扫码授权。");
    }
    const login = parseLoginJson<PassportLoginResult>(await loginResponse.text());
    if (!login.ssecurity || !login.location) {
      throw new AuthRequiredError("小米 Passport 登录响应不完整，请重新扫码授权。");
    }
    const stsResponse = await client(login.location, {
      headers: {
        "User-Agent": session.userAgent,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!stsResponse.ok) {
      throw new AuthRequiredError("小米 Passport STS 登录失败，请重新扫码授权。");
    }
    await stsResponse.arrayBuffer();
    const urls = [
      login.location,
      "https://sts.api.io.mi.com/",
      "https://api.account.xiaomi.com/",
    ];
    const serviceToken = await cookieValue(jar, "serviceToken", urls);
    const cUserId = (await cookieValue(jar, "cUserId", urls)) || login.cUserId || session.cUserId;
    if (!serviceToken || !cUserId) {
      throw new AuthRequiredError("小米 Passport STS 没有返回完整凭证。");
    }
    return { ssecurity: login.ssecurity, serviceToken, cUserId };
  }
}
