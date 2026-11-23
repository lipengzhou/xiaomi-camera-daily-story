import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";

import type { CredentialStore } from "./credentials.js";
import { AppError, SyncBusyError, ValidationError } from "./errors.js";
import type { PlatformServices, RuntimePaths } from "./platform/types.js";
import { readAuthorizedVideoRoots } from "./runtime.js";
import { DailyScheduler } from "./scheduler.js";
import { ConfigStore, HistoryStore, validateConfig } from "./storage.js";
import { SpawnCommandRunner, type CommandRunner } from "./sync/commands.js";
import { MediaDownloader } from "./sync/media.js";
import { SyncService } from "./sync/service.js";
import type { AppConfig, XiaomiSession } from "./types.js";
import { resolveVideoRoot, videoStorageOptions } from "./video-storage.js";
import { QrLoginService, SessionProvider } from "./xiaomi/auth.js";
import { XiaomiCloudClient } from "./xiaomi/cloud.js";
import {
  XiaomiProfileService,
  type ProfileProvider,
} from "./xiaomi/profile.js";
import {
  allowedGatewayOrigin,
  allowedLocalHost,
  allowedLocalOrigin,
  isApiRequest,
  isSafeRequestPath,
  isWithinBasePath,
  resolveRequestIdentity,
  withBasePath,
} from "./web.js";

export interface CreateServerOptions {
  platformServices: PlatformServices;
  port?: number;
  paths?: RuntimePaths;
  credentials?: CredentialStore;
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
  publicRoot?: string;
  logger?: boolean;
  profileProvider?: ProfileProvider;
}

function defaultPublicRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
}

export async function createServer(options: CreateServerOptions): Promise<FastifyInstance> {
  const port = options.port ?? 3210;
  const runner = options.commandRunner ?? new SpawnCommandRunner();
  const platformServices = options.platformServices;
  const basePath = platformServices.web.basePath;
  const route = (value: string): string => withBasePath(basePath, value);
  const paths = options.paths ?? platformServices.paths;
  const credentials = options.credentials ?? platformServices.credentials;
  const fetchImpl = options.fetchImpl ?? fetch;
  const configStore = new ConfigStore(
    paths,
    platformServices.fileOperations,
  );
  const historyStore = new HistoryStore(paths, platformServices.fileOperations);
  const qrLogin = new QrLoginService(credentials, fetchImpl);
  const sessions = new SessionProvider(credentials, fetchImpl);
  const allowedVideoRoots = [
    paths.downloadRoot,
    ...(paths.authorizedDownloadRoots ?? [])
      .filter((root) => root.available)
      .map((root) => root.path),
  ];
  const downloader = new MediaDownloader(
    runner,
    platformServices.mediaTools,
    platformServices.fileTimes,
    platformServices.fileOperations,
    allowedVideoRoots,
  );
  const refreshAuthorizedVideoRoots = async (): Promise<void> => {
    if (!paths.authorizedDownloadRootsFile) {
      return;
    }
    const roots = await readAuthorizedVideoRoots(paths.authorizedDownloadRootsFile);
    if (roots.length) {
      paths.authorizedDownloadRoots = roots;
    } else {
      delete paths.authorizedDownloadRoots;
    }
    downloader.setDownloadRoots([
      paths.downloadRoot,
      ...roots.filter((root) => root.available).map((root) => root.path),
    ]);
  };
  const syncService = new SyncService(
    configStore,
    historyStore,
    sessions,
    downloader,
    async (config) => {
      await refreshAuthorizedVideoRoots();
      return resolveVideoRoot(paths, config.videoStorage);
    },
    (session: XiaomiSession) => new XiaomiCloudClient(session, fetchImpl),
  );
  const profileProvider = options.profileProvider ?? new XiaomiProfileService(fetchImpl);
  const app = Fastify({ logger: options.logger ? { level: "info" } : false });
  const requireCredentialStore = (): void => {
    if (platformServices.credentialStore.available) {
      return;
    }
    throw new AppError(
      "当前加密凭证存储不可用，无法保存米家授权。",
      "CREDENTIAL_STORE_UNAVAILABLE",
      503,
    );
  };
  const requireMediaCapability = async (): Promise<void> => {
    const capabilities = await platformServices.capabilities();
    if (capabilities.mediaDownload) {
      return;
    }
    const issue = platformServices.issues.find((candidate) =>
      candidate.code.includes("MEDIA"),
    );
    throw new AppError(
      issue?.message ?? "当前运行环境缺少完整的媒体下载能力。",
      "MEDIA_CAPABILITY_UNAVAILABLE",
      503,
    );
  };
  const scheduler = new DailyScheduler(configStore, async () => {
    try {
      await requireMediaCapability();
      await syncService.run("schedule");
    } catch (error) {
      if (!(error instanceof SyncBusyError)) {
        app.log.error(error, "scheduled sync failed");
      }
    }
  }, (error) => app.log.error(error, "scheduler failed"));

  app.addHook("onRequest", async (request, reply) => {
    if (!isSafeRequestPath(request.raw.url ?? request.url)) {
      await reply.code(400).send({
        error: { code: "INVALID_PATH", message: "请求路径格式无效。" },
      });
      return reply;
    }
    if (!isWithinBasePath(request.raw.url ?? request.url, basePath)) {
      await reply.code(404).send({
        error: { code: "INVALID_BASE_PATH", message: "请求不属于当前应用路径。" },
      });
      return reply;
    }
    if (platformServices.runtimeMode === "local" && !allowedLocalHost(request.headers.host)) {
      await reply.code(421).send({ error: { code: "INVALID_HOST", message: "仅允许本地 Host。" } });
      return reply;
    }
    resolveRequestIdentity(platformServices.runtimeMode, request.headers);
    const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const originAllowed = platformServices.runtimeMode === "local"
      ? allowedLocalOrigin(request.headers.origin, port)
      : allowedGatewayOrigin(request.headers.origin, request.headers);
    if (mutating && isApiRequest(request.url, basePath) && !originAllowed) {
      await reply
        .code(403)
        .send({ error: { code: "INVALID_ORIGIN", message: "拒绝非当前应用页面发起的请求。" } });
      return reply;
    }
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header(
        "Content-Security-Policy",
        `default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors ${platformServices.runtimeMode === "fnos" ? "'self'" : "'none'"}; base-uri 'none'; form-action 'self'`,
      )
      .header("X-Content-Type-Options", "nosniff")
      .header(
        "X-Frame-Options",
        platformServices.runtimeMode === "fnos" ? "SAMEORIGIN" : "DENY",
      )
      .header("Referrer-Policy", "no-referrer")
      .header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
      .header("Cross-Origin-Resource-Policy", "same-origin");
    if (isApiRequest(_request.url, basePath)) {
      reply.header("Cache-Control", "no-store");
    } else {
      reply.header("Cache-Control", "no-cache");
    }
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    app.log.error(error);
    void reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "服务内部错误，请查看服务日志。" },
    });
  });

  app.get(route("/api/status"), async (request) => {
    await refreshAuthorizedVideoRoots();
    const [config, session, history, capabilities] = await Promise.all([
      configStore.load(),
      credentials.get(),
      historyStore.list(),
      platformServices.capabilities(),
    ]);
    let profile = null;
    if (session) {
      try {
        const account = await profileProvider.getProfile(session);
        profile = {
          userId: account.userId,
          userName: account.userName,
          avatarUrl: account.avatarSourceUrl ? route("/api/profile/avatar") : null,
          authorizedAt: account.authorizedAt,
        };
      } catch (error) {
        app.log.warn(error, "failed to load Xiaomi profile");
        profile = {
          userId: session.userId,
          userName: `小米用户 ${session.userId}`,
          avatarUrl: null,
          authorizedAt: new Date(session.createdAt).toISOString(),
        };
      }
    }
    const storageOptions = videoStorageOptions(paths, platformServices.runtimeMode);
    const selectedStorage = storageOptions.find(
      (option) => option.id === config.videoStorage,
    ) ?? storageOptions[0]!;
    return {
      config,
      authenticated: session !== null,
      profile,
      qrLogin: qrLogin.getState(),
      sync: syncService.getState(),
      nextRunAt: scheduler.getNextRunAt(),
      history: history.slice(0, 10),
      capabilities,
      environment: {
        runtimeMode: platformServices.runtimeMode,
        platform: platformServices.platform,
        architecture: platformServices.architecture,
        credentialStore: platformServices.credentialStore,
        dataDir: paths.dataDir,
        videoDir: selectedStorage.path,
        videoStorageOptions: storageOptions,
        issues: platformServices.issues,
        ...(platformServices.mediaStatus ? { media: platformServices.mediaStatus } : {}),
      },
      currentUser: resolveRequestIdentity(platformServices.runtimeMode, request.headers),
      server: {
        transport: platformServices.web.transport,
        basePath,
        ...(platformServices.web.transport === "tcp"
          ? { host: "127.0.0.1", port }
          : { socketPath: platformServices.web.socketPath }),
      },
    };
  });

  app.post(route("/api/auth/qr"), async (_request, reply) => {
    requireCredentialStore();
    const state = await qrLogin.start();
    return reply.code(202).send(state);
  });

  app.get(route("/api/auth/qr/status"), async () => qrLogin.getState());

  app.get<{ Params: { id: string } }>(route("/api/auth/qr/:id.png"), async (request, reply) => {
    const image = qrLogin.getImage(request.params.id);
    if (!image) {
      return reply.code(404).send({ error: { code: "QR_NOT_FOUND", message: "二维码不存在或已过期。" } });
    }
    return reply
      .header("Cache-Control", "no-store")
      .type("image/png")
      .send(image);
  });

  app.delete(route("/api/auth/session"), async (_request, reply) => {
    requireCredentialStore();
    await qrLogin.clear();
    profileProvider.clearCache();
    return reply.code(204).send();
  });

  app.get(route("/api/profile/avatar"), async (_request, reply) => {
    const session = await sessions.get();
    const avatar = await profileProvider.getAvatar(session);
    if (!avatar) {
      return reply.code(404).send({
        error: { code: "AVATAR_NOT_FOUND", message: "当前小米账号没有可用头像。" },
      });
    }
    return reply
      .header("Cache-Control", "private, max-age=300")
      .type(avatar.contentType)
      .send(avatar.body);
  });

  app.get(route("/api/devices"), async () => {
    return sessions.run((session) => new XiaomiCloudClient(session, fetchImpl).listCameras());
  });

  app.put<{ Body: AppConfig }>(route("/api/config"), async (request) => {
    const config = validateConfig(request.body);
    if (config.schedule.enabled) {
      await requireMediaCapability();
    }
    await refreshAuthorizedVideoRoots();
    const videoRoot = resolveVideoRoot(paths, config.videoStorage);
    await mkdir(videoRoot, { recursive: true, mode: 0o755 });
    await access(videoRoot, constants.W_OK);
    await configStore.save(config);
    await scheduler.reschedule();
    return { config, nextRunAt: scheduler.getNextRunAt() };
  });

  app.post(route("/api/sync"), async (_request, reply) => {
    if (syncService.getState().running) {
      throw new SyncBusyError();
    }
    await requireMediaCapability();
    void syncService.run("manual").catch((error) => {
      app.log.error(error, "manual sync failed");
    });
    return reply.code(202).send({ sync: syncService.getState() });
  });

  app.get(route("/api/sync/history"), async () => ({ history: await historyStore.list() }));

  if (basePath) {
    app.get(basePath, async (_request, reply) => reply.redirect(`${basePath}/`));
  }

  await app.register(fastifyStatic, {
    root: options.publicRoot ?? defaultPublicRoot(),
    prefix: basePath ? `${basePath}/` : "/",
    wildcard: false,
    index: ["index.html"],
    cacheControl: false,
  });

  app.addHook("onClose", async () => {
    scheduler.stop();
  });
  await configStore.load();
  await scheduler.start();
  return app;
}
