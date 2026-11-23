import type { ConfigStore } from "./storage.js";
import { nextShanghaiRun } from "./sync/date.js";

export class DailyScheduler {
  private timer: NodeJS.Timeout | null = null;
  private nextRun: Date | null = null;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly runSync: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    await this.reschedule();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.nextRun = null;
  }

  getNextRunAt(): string | null {
    return this.nextRun?.toISOString() ?? null;
  }

  async reschedule(): Promise<void> {
    this.stop();
    const config = await this.configStore.load();
    if (!config.schedule.enabled) {
      return;
    }
    this.nextRun = nextShanghaiRun(new Date(), config.schedule.time);
    const delay = Math.max(1, this.nextRun.getTime() - Date.now());
    this.timer = setTimeout(() => {
      void this.execute().catch(this.onError);
    }, delay);
    this.timer.unref();
  }

  private async execute(): Promise<void> {
    this.timer = null;
    this.nextRun = null;
    try {
      await this.runSync();
    } finally {
      try {
        await this.reschedule();
      } catch (error) {
        this.onError(error);
      }
    }
  }
}
