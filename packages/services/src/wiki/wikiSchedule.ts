import type { WikiAutoUpdateFrequency } from "@zcode/shared";

/**
 * wiki 自动更新的排期换算（纯函数）。
 *
 * 单独成模块而不是塞在调度器里：这些换算有真实边界（跨月、锚点推进、
 * 时区日历），必须能脱离定时器与文件系统直接测。
 */

/** 频率 → 间隔天数。 */
export const WIKI_FREQUENCY_INTERVAL_DAYS: Record<WikiAutoUpdateFrequency, number> = {
  daily: 1,
  every2days: 2,
  weekly: 7,
};

export const WIKI_DEFAULT_HOUR = 3;
export const WIKI_DEFAULT_MINUTE = 0;
export const WIKI_DEFAULT_FREQUENCY: WikiAutoUpdateFrequency = "daily";

function atTime(reference: Date, hour: number, minute: number): Date {
  return new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    hour,
    minute,
    0,
    0,
  );
}

/** 把可能越界的小时/分钟收敛到合法范围。 */
export function clampClock(hour: number, minute: number): { hour: number; minute: number } {
  const safeHour = Number.isFinite(hour)
    ? Math.min(23, Math.max(0, Math.floor(hour)))
    : WIKI_DEFAULT_HOUR;
  const safeMinute = Number.isFinite(minute)
    ? Math.min(59, Math.max(0, Math.floor(minute)))
    : WIKI_DEFAULT_MINUTE;
  return { hour: safeHour, minute: safeMinute };
}

/**
 * 计算下一次触发时间。
 *
 * 从锚点按「日历天 + 间隔」推进，而不是用 `*\/N` cron：后者在月末会出错
 * （31 号之后的 `*\/2` 会命中 1 号，间隔实际只有 1 天）。
 *
 * @param anchorAt 锚点时间戳；频率或时刻变更时由调用方刷新。
 */
export function computeNextWikiRunAt(params: {
  frequency: WikiAutoUpdateFrequency;
  hour: number;
  minute: number;
  anchorAt: number;
  from?: number;
}): number {
  const intervalDays = WIKI_FREQUENCY_INTERVAL_DAYS[params.frequency] ?? 1;
  const { hour, minute } = clampClock(params.hour, params.minute);
  const from = params.from ?? Date.now();
  const anchor = new Date(params.anchorAt);

  // 锚点当天对齐到目标时刻，再按间隔天数往前找第一个严格晚于 from 的候选。
  const first = atTime(anchor, hour, minute);
  if (first.getTime() > from) return first.getTime();

  const elapsedDays = Math.floor((from - first.getTime()) / 86_400_000);
  let steps = Math.floor(elapsedDays / intervalDays) + 1;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const candidate = new Date(
      anchor.getFullYear(),
      anchor.getMonth(),
      anchor.getDate() + steps * intervalDays,
      hour,
      minute,
      0,
      0,
    ).getTime();
    if (candidate > from) return candidate;
    steps += 1;
  }
  // 理论上不可达；返回一个安全值而不是抛错，避免调度器因算术问题整体停摆。
  return from + intervalDays * 86_400_000;
}

/**
 * 判断「现在」是否落在该次触发窗口内。
 *
 * 调度器按上限截断睡眠后会提前醒来，需要判断是真到点了还是只醒了个早。
 * 用 5 分钟窗口而非 1 分钟：进程被系统挂起后唤醒可能晚一些，
 * 窗口太窄会整轮漏掉。
 */
export function isWithinWikiRunWindow(params: {
  frequency: WikiAutoUpdateFrequency;
  hour: number;
  minute: number;
  anchorAt: number;
  now: number;
  windowMs?: number;
}): boolean {
  const windowMs = params.windowMs ?? 5 * 60_000;
  const { hour, minute } = clampClock(params.hour, params.minute);
  const intervalDays = WIKI_FREQUENCY_INTERVAL_DAYS[params.frequency] ?? 1;
  const anchor = new Date(params.anchorAt);
  const nowDate = new Date(params.now);

  // 只在「日期差是间隔天数的整数倍 + 时刻在窗口内」时才算命中。
  const anchorMidnight = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
  ).getTime();
  const nowMidnight = new Date(
    nowDate.getFullYear(),
    nowDate.getMonth(),
    nowDate.getDate(),
  ).getTime();
  const dayDiff = Math.round((nowMidnight - anchorMidnight) / 86_400_000);
  if (dayDiff < 0 || dayDiff % intervalDays !== 0) return false;

  const scheduled = atTime(nowDate, hour, minute).getTime();
  return params.now >= scheduled && params.now - scheduled < windowMs;
}

/** 频率的中文/英文展示交给 i18n；这里只做归一化。 */
export function normalizeFrequency(value: unknown): WikiAutoUpdateFrequency {
  return value === "every2days" || value === "weekly" ? value : WIKI_DEFAULT_FREQUENCY;
}

/**
 * 从旧 cron 迁移频率与时刻（读历史设置时用）。
 *
 * 只识别「每日/每 N 天/每周」这三档能表达的范围；识别不了就回退默认，
 * 不让用户因为一次迁移而彻底丢掉自动更新。
 */
export function migrateFromCron(cron: string | undefined): {
  frequency: WikiAutoUpdateFrequency;
  hour: number;
  minute: number;
} | null {
  if (!cron) return null;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;

  const dayOfMonth = parts[2] ?? "*";
  const dayOfWeek = parts[4] ?? "*";
  if (dayOfWeek !== "*") return { frequency: "weekly", hour, minute };
  if (dayOfMonth === "*") return { frequency: "daily", hour, minute };
  // `*/N` 形式的日间隔：N=1 视作每天，N=2 视作每 2 天，其余按最接近的档位收敛。
  const step = /^\*\/(\d+)$/.exec(dayOfMonth);
  if (step) {
    const value = Number(step[1]);
    if (value === 1) return { frequency: "daily", hour, minute };
    if (value === 2) return { frequency: "every2days", hour, minute };
    return { frequency: value >= 7 ? "weekly" : "every2days", hour, minute };
  }
  return null;
}
