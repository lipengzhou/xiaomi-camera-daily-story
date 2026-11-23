import { randomBytes } from "node:crypto";

import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

import type { CredentialStore } from "../credentials.js";
import { AuthRequiredError, AppError } from "../errors.js";
import type { XiaomiSession } from "../types.js";

const JSON_PREFIX = "&&&START&&&";

interface LoginMetadata {
  qr: string;
  lp: string;
  timeout: number;
}

interface LoginResult {
  userId: string | number;
  cUserId?: string;
  passToken: string;
  ssecurity: string;
  location: string;
}

type CookieFetch = (
  input: URL | RequestInfo,
  init?: RequestInit & { maxRedirect?: number; redirectCount?: number },
) => Promise<Response>;

export type QrLoginStatus = "idle" | "waiting" | "success" | "expired" | "error";

export interface QrLoginState {
  id: string | null;
  status: QrLoginStatus;
  startedAt: string | null;
  expiresAt: string | null;
  message: string | null;
}

function parseLoginJson<T>(text: string): T {
  return JSON.parse(text.replace(new RegExp(`^${JSON_PREFIX}`), "")) as T;
}

function userAgent(): string {
  const prefix = randomBytes(18)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z]/g, "a")
    .slice(0, 18);
  const suffix = Array.from(randomBytes(13), (value) => String.fromCharCode(65 + (value % 5))).join(
    "",
  );
  return `${prefix}-${suffix} APP/com.xiaomi.mihome APPV/11.9.705`;
}

async function cookieValue(jar: CookieJar, name: string, urls: string[]): Promise<string> {
  for (const url of urls) {
    const cookies = await jar.getCookies(url);
    const found = cookies.find((cookie) => cookie.key === name);
    if (found) {
      return found.value;
    }
  }
  return "";
}

async function finishLogin(
  client: CookieFetch,
  jar: CookieJar,
  result: LoginResult,
  agent: string,
): Promise<XiaomiSession> {
  const response = await client(result.location, {
    headers: { "User-Agent": agent, "Content-Type": "application/x-www-form-urlencoded" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new AuthRequiredError(`小米 STS 登录失败：HTTP ${response.status}`);
  }
  await response.arrayBuffer();
  const serviceToken = await cookieValue(jar, "serviceToken", [
    result.location,
    "https://sts.api.io.mi.com/",
    "https://api.io.mi.com/",
  ]);
  if (!serviceToken) {
    throw new AuthRequiredError("小米 STS 响应没有返回 serviceToken。");
  }
  const now = Date.now();
  return {
    userId: String(result.userId),
    cUserId:
      result.cUserId ||
      (await cookieValue(jar, "cUserId", [result.location, "https://sts.api.io.mi.com/"])),
    passToken: result.passToken,
    ssecurity: result.ssecurity,
    serviceToken,
    userAgent: agent,
    createdAt: now,
    refreshedAt: now,
  };
}

export async function refreshXiaomiSession(
  session: XiaomiSession,
  fetchImpl: typeof fetch = fetch,
): Promise<XiaomiSession> {
  const jar = new CookieJar();
  await jar.setCookie(`userId=${session.userId}; Path=/`, "https://account.xiaomi.com/");
  await jar.setCookie(`passToken=${session.passToken}; Path=/`, "https://account.xiaomi.com/");
  const client = makeFetchCookie(fetchImpl, jar) as CookieFetch;
  const response = await client(
    "https://account.xiaomi.com/pass/serviceLogin?_json=true&sid=xiaomiio",
    {
      headers: { "User-Agent": session.userAgent },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new AuthRequiredError("米家凭证刷新失败，请重新扫码授权。");
  }
  const data = parseLoginJson<LoginResult>(await response.text());
  if (!data.ssecurity || !data.location || !data.passToken) {
    throw new AuthRequiredError("米家凭证刷新响应不完整，请重新扫码授权。");
  }
  const refreshed = await finishLogin(client, jar, data, session.userAgent);
  return { ...refreshed, createdAt: session.createdAt };
}

export class SessionProvider {
  constructor(
    private readonly credentials: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<XiaomiSession> {
    const session = await this.credentials.get();
    if (!session) {
      throw new AuthRequiredError();
    }
    return session;
  }

  async run<T>(operation: (session: XiaomiSession) => Promise<T>): Promise<T> {
    const session = await this.get();
    try {
      return await operation(session);
    } catch (error) {
      if (!(error instanceof AuthRequiredError) || !session.passToken) {
        throw error;
      }
      const refreshed = await refreshXiaomiSession(session, this.fetchImpl);
      await this.credentials.set(refreshed);
      return operation(refreshed);
    }
  }
}

export class QrLoginService {
  private state: QrLoginState = {
    id: null,
    status: "idle",
    startedAt: null,
    expiresAt: null,
    message: null,
  };

  private image: Buffer | null = null;
  private controller: AbortController | null = null;

  constructor(
    private readonly credentials: CredentialStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  getState(): QrLoginState {
    return structuredClone(this.state);
  }

  getImage(id: string): Buffer | null {
    return this.state.id === id ? this.image : null;
  }

  async isAuthenticated(): Promise<boolean> {
    return (await this.credentials.get()) !== null;
  }

  async clear(): Promise<void> {
    this.controller?.abort();
    this.controller = null;
    this.image = null;
    this.state = { id: null, status: "idle", startedAt: null, expiresAt: null, message: null };
    await this.credentials.clear();
  }

  async start(): Promise<QrLoginState> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const jar = new CookieJar();
    const client = makeFetchCookie(this.fetchImpl, jar) as CookieFetch;
    const agent = userAgent();
    const params = new URLSearchParams({
      _qrsize: "480",
      qs: "%3Fsid%3Dxiaomiio%26_json%3Dtrue",
      callback: "https://sts.api.io.mi.com/sts",
      _hasLogo: "false",
      sid: "xiaomiio",
      serviceParam: "",
      _locale: "zh_CN",
      _dc: String(Date.now()),
    });
    const metadataResponse = await client(
      `https://account.xiaomi.com/longPolling/loginUrl?${params.toString()}`,
      {
        headers: { "User-Agent": agent },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      },
    );
    if (!metadataResponse.ok) {
      throw new AppError(
        `获取小米登录二维码失败：HTTP ${metadataResponse.status}`,
        "QR_START_FAILED",
        502,
      );
    }
    const metadata = parseLoginJson<LoginMetadata>(await metadataResponse.text());
    if (!metadata.qr || !metadata.lp || !metadata.timeout) {
      throw new AppError("小米没有返回完整的二维码信息。", "QR_INVALID_RESPONSE", 502);
    }
    const imageResponse = await client(metadata.qr, {
      headers: { "User-Agent": agent },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    });
    if (!imageResponse.ok) {
      throw new AppError("下载小米登录二维码失败。", "QR_IMAGE_FAILED", 502);
    }
    this.image = Buffer.from(await imageResponse.arrayBuffer());
    const id = randomBytes(12).toString("hex");
    const startedAt = new Date();
    this.state = {
      id,
      status: "waiting",
      startedAt: startedAt.toISOString(),
      expiresAt: new Date(startedAt.getTime() + metadata.timeout * 1000).toISOString(),
      message: "请使用手机扫描二维码并确认登录。",
    };
    void this.poll(client, jar, metadata, agent, controller).catch((error: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      this.state = {
        ...this.state,
        status: "error",
        message: error instanceof Error ? error.message : "二维码登录失败。",
      };
    });
    return this.getState();
  }

  private async poll(
    client: CookieFetch,
    jar: CookieJar,
    metadata: LoginMetadata,
    agent: string,
    controller: AbortController,
  ): Promise<void> {
    const deadline = Date.now() + metadata.timeout * 1000;
    while (Date.now() < deadline && !controller.signal.aborted) {
      try {
        const response = await client(metadata.lp, {
          headers: { "User-Agent": agent },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]),
        });
        if (response.ok) {
          const result = parseLoginJson<LoginResult>(await response.text());
          if (!result.userId || !result.passToken || !result.ssecurity || !result.location) {
            throw new AppError("小米二维码确认响应不完整。", "QR_CONFIRM_INVALID", 502);
          }
          const session = await finishLogin(client, jar, result, agent);
          await this.credentials.set(session);
          this.image = null;
          this.state = {
            ...this.state,
            status: "success",
            message: "扫码授权成功，凭证已保存到系统凭证库。",
          };
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        if ((error as Error).name !== "TimeoutError" && (error as Error).name !== "AbortError") {
          throw error;
        }
      }
    }
    this.image = null;
    this.state = { ...this.state, status: "expired", message: "二维码已经过期，请重新生成。" };
  }
}
