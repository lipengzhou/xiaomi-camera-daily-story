import { AppError } from "./errors.js";
import type { RuntimeMode } from "./platform/types.js";

export const FNOS_BASE_PATH = "/app/xiaomi-camera-daily-story" as const;

type HeaderMap = Record<string, string | string[] | undefined>;

export interface RequestIdentity {
  userId: string;
  username: string;
  isAdmin: true;
}

function headerValue(headers: HeaderMap, name: string): string | undefined {
  const value = headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",", 1)[0]?.trim();
}

export function withBasePath(basePath: string, route: string): string {
  if (!route.startsWith("/")) {
    throw new Error("应用路由必须以 / 开头。");
  }
  return `${basePath}${route}`;
}

export function requestPath(url: string): string {
  return url.split("?", 1)[0] ?? "";
}

export function isSafeRequestPath(url: string): boolean {
  const raw = requestPath(url);
  if (!raw.startsWith("/") || raw.includes("//") || raw.includes("\\")) {
    return false;
  }
  if (/%(?:2f|5c)/iu.test(raw)) {
    return false;
  }
  try {
    const decoded = decodeURIComponent(raw);
    return !decoded
      .split("/")
      .some((segment) => segment === "." || segment === "..");
  } catch {
    return false;
  }
}

export function isWithinBasePath(url: string, basePath: string): boolean {
  const pathname = requestPath(url);
  return basePath === "" || pathname === basePath || pathname.startsWith(`${basePath}/`);
}

export function isApiRequest(url: string, basePath: string): boolean {
  return requestPath(url).startsWith(withBasePath(basePath, "/api/"));
}

export function allowedLocalHost(host: string | undefined): boolean {
  if (!host) {
    return false;
  }
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : host.split(":")[0];
  return hostname === "127.0.0.1" || hostname === "localhost";
}

export function allowedLocalOrigin(
  origin: string | undefined,
  port: number,
): boolean {
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.port === String(port)
    );
  } catch {
    return false;
  }
}

export function allowedGatewayOrigin(
  origin: string | undefined,
  headers: HeaderMap,
): boolean {
  if (!origin) {
    return false;
  }
  try {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return false;
    }
    const expectedHost =
      headerValue(headers, "x-forwarded-host") ?? headerValue(headers, "host");
    const expectedProtocol = headerValue(headers, "x-forwarded-proto");
    if (
      expectedHost &&
      parsed.host === expectedHost &&
      (!expectedProtocol || `${expectedProtocol}:` === parsed.protocol)
    ) {
      return true;
    }
    const fetchSite = headerValue(headers, "sec-fetch-site");
    if (fetchSite) {
      return fetchSite === "same-origin";
    }
    // fnOS rewrites Host and may strip Fetch Metadata before proxying to the
    // Unix Socket. This custom header makes browser cross-origin requests
    // non-simple, so they cannot reach the handler without an allowed CORS
    // preflight. The application never emits CORS allow headers.
    return headerValue(headers, "x-requested-with") === "XiaomiDailyStoryUI";
  } catch {
    return false;
  }
}

export function resolveRequestIdentity(
  runtimeMode: RuntimeMode,
  headers: HeaderMap,
): RequestIdentity {
  if (runtimeMode === "local") {
    return { userId: "local-developer", username: "本地开发者", isAdmin: true };
  }
  const userId = headerValue(headers, "x-trim-userid");
  const username = headerValue(headers, "x-trim-username");
  const isAdmin = headerValue(headers, "x-trim-isadmin")?.toLowerCase();
  if (!userId || !username || !isAdmin) {
    throw new AppError(
      "缺少 fnOS 统一网关身份，请从飞牛桌面入口访问应用。",
      "GATEWAY_IDENTITY_REQUIRED",
      401,
    );
  }
  if (isAdmin !== "true") {
    throw new AppError("仅 fnOS 管理员可以使用本应用。", "ADMIN_REQUIRED", 403);
  }
  return { userId, username, isAdmin: true };
}
