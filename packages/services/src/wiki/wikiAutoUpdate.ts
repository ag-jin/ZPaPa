import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import type { WikiSettings } from "@zcode/shared";
import {
  listWikiAutoUpdateProjects,
  resolveWikiWorkspaceKey,
  type ResolvedWikiProjectSettings,
} from "./wikiProjectSettings.js";
import { computeNextWikiRunAt, isWithinWikiRunWindow } from "./wikiSchedule.js";

/** 定时器最长一次睡眠：跨越系统休眠/时钟跳变后仍能重新对齐。 */
const MAX_TIMER_SLEEP_MS = 30 * 60_000;

export interface WikiAutoUpdateTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

export interface WikiAutoUpdateSchedulerOptions {
  readSettings: () => Promise<WikiSettings | undefined>;
  /** 列出所有已知 workspace（用来把配置键反解成可读写的路径）。 */
  listKnownTargets: () => Promise<WikiAutoUpdateTarget[]>;
  /** 触发一次增量生成。 */
  runUpdate: (
    target: WikiAutoUpdateTarget,
    settings: ResolvedWikiProjectSettings,
  ) => Promise<void>;
  /** 记录本次触发时间（写回该项目的 lastAutoUpdateAt）。 */
  recordRun?: (workspaceKey: string, at: number) => Promise<void>;
  logger?: ServiceLogger;
}

interface ScheduledProject {
  workspaceKey: string;
  target: WikiAutoUpdateTarget;
  settings: ResolvedWikiProjectSettings;
  /** 该项目下一次该跑的时刻。 */
  nextRunAt: number;
}

/**
 * wiki 定时自动更新的调度器。
 *
 * **按项目独立排期**：每个项目有自己的频率与时刻，所以调度器每次醒来
 * 取所有项目中最早的那个到点时间睡眠，醒来后只跑真正到点的项目。
 *
 * 不用固定间隔轮询 —— 轮询会让实际触发时间随进程启动时刻漂移，
 * 且项目多了以后无法表达「各自的时刻」。
 */
export class WikiAutoUpdateScheduler {
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;
  #running = false;

  constructor(private readonly options: WikiAutoUpdateSchedulerOptions) {}

  start(): void {
    if (this.#timer || this.#stopped) return;
    this.#scheduleNext();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** 把「配置键」映射回可读写的 workspace 路径。查不到就跳过（项目已被移除）。 */
  #resolveScheduledProjects(
    settings: WikiSettings | undefined,
    targets: readonly WikiAutoUpdateTarget[],
    from: number,
  ): ScheduledProject[] {
    const byKey = new Map<string, WikiAutoUpdateTarget>();
    for (const target of targets) {
      byKey.set(resolveWikiWorkspaceKey(target.workspacePath, target.workspaceIdentity), target);
    }

    const scheduled: ScheduledProject[] = [];
    for (const project of listWikiAutoUpdateProjects(settings)) {
      const target = byKey.get(project.workspaceKey);
      if (!target) continue;
      const { autoUpdateFrequency, autoUpdateHour, autoUpdateMinute } = project.settings;
      // 锚点缺失时用「当前时刻」兜底：没有锚点就无法按日历天推进。
      const anchorAt = project.settings.autoUpdateAnchorAt ?? from;
      scheduled.push({
        workspaceKey: project.workspaceKey,
        target,
        settings: project.settings,
        nextRunAt: computeNextWikiRunAt({
          frequency: autoUpdateFrequency,
          hour: autoUpdateHour,
          minute: autoUpdateMinute,
          anchorAt,
          from,
        }),
      });
    }
    return scheduled;
  }

  #scheduleNext(): void {
    if (this.#stopped) return;
    void this.#readDelay()
      .then((delayMs) => {
        if (this.#stopped) return;
        this.#timer = setTimeout(() => {
          this.#timer = null;
          void this.#tick();
        }, delayMs);
        this.#timer.unref?.();
      })
      .catch((error: unknown) => {
        this.options.logger?.warn(undefined, "wiki 自动更新调度失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (this.#stopped) return;
        this.#timer = setTimeout(() => {
          this.#timer = null;
          this.#scheduleNext();
        }, MAX_TIMER_SLEEP_MS);
        this.#timer.unref?.();
      });
  }

  async #readDelay(): Promise<number> {
    const now = Date.now();
    const [settings, targets] = await Promise.all([
      this.options.readSettings(),
      this.options.listKnownTargets(),
    ]);
    const scheduled = this.#resolveScheduledProjects(settings, targets, now);
    if (scheduled.length === 0) {
      // 没有开启的项目时低频复查配置变化，而不是彻底停摆。
      return MAX_TIMER_SLEEP_MS;
    }
    const earliest = Math.min(...scheduled.map((project) => project.nextRunAt));
    const delay = earliest - now;
    if (delay <= 0) return 1_000;
    return Math.min(delay, MAX_TIMER_SLEEP_MS);
  }

  async #tick(): Promise<void> {
    if (this.#stopped || this.#running) {
      this.#scheduleNext();
      return;
    }
    this.#running = true;
    try {
      const now = Date.now();
      const [settings, targets] = await Promise.all([
        this.options.readSettings(),
        this.options.listKnownTargets(),
      ]);
      const scheduled = this.#resolveScheduledProjects(settings, targets, now);

      for (const project of scheduled) {
        if (this.#stopped) break;
        const anchorAt = project.settings.autoUpdateAnchorAt ?? now;
        // 睡醒可能早于到点（被 MAX_TIMER_SLEEP_MS 截断），也可能晚了；
        // 只有落在窗口内的项目才真的该跑。
        const due = isWithinWikiRunWindow({
          frequency: project.settings.autoUpdateFrequency,
          hour: project.settings.autoUpdateHour,
          minute: project.settings.autoUpdateMinute,
          anchorAt,
          now,
        });
        if (!due) continue;

        try {
          await this.options.runUpdate(project.target, project.settings);
          await this.options.recordRun?.(project.workspaceKey, Date.now());
        } catch (error) {
          // 单个项目失败不阻塞其余项目
          this.options.logger?.warn(undefined, "wiki 自动更新单个项目失败", {
            workspacePath: project.target.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.#running = false;
      this.#scheduleNext();
    }
  }
}
