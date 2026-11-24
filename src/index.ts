import { loadEnvironmentFiles } from "./environment.js";
import { createRuntimeServices } from "./runtime.js";
import { createServer } from "./server.js";
import { SpawnCommandRunner } from "./sync/commands.js";
import {
  cleanupUnixSocket,
  prepareUnixSocket,
  secureUnixSocket,
} from "./unix-socket.js";

function localPort(): number {
  const port = Number(process.env.PORT ?? "3210");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT 必须是 1-65535 之间的整数。");
  }
  return port;
}

await loadEnvironmentFiles();
const runner = new SpawnCommandRunner();
const platformServices = await createRuntimeServices(process.platform, runner);
const port = platformServices.web.transport === "tcp" ? localPort() : 3210;
const app = await createServer({
  port,
  logger: true,
  commandRunner: runner,
  platformServices,
});
const socketPath = platformServices.web.transport === "unix"
  ? platformServices.web.socketPath
  : null;
let closing = false;

const close = async (): Promise<void> => {
  if (closing) {
    return;
  }
  closing = true;
  try {
    await app.close();
  } finally {
    if (socketPath) {
      await cleanupUnixSocket(socketPath);
    }
  }
};

process.once("SIGINT", () => {
  void close().catch((error) => {
    app.log.error(error, "failed to stop application");
    process.exitCode = 1;
  });
});
process.once("SIGTERM", () => {
  void close().catch((error) => {
    app.log.error(error, "failed to stop application");
    process.exitCode = 1;
  });
});

try {
  let address: string;
  if (platformServices.web.transport === "unix") {
    await prepareUnixSocket(platformServices.web.socketPath);
    address = await app.listen({ path: platformServices.web.socketPath });
    await secureUnixSocket(platformServices.web.socketPath);
  } else {
    address = await app.listen({ host: "127.0.0.1", port });
  }
  app.log.info(`米家每日故事同步后台：${address}`);
} catch (error) {
  app.log.error(error);
  await close();
  process.exitCode = 1;
}
