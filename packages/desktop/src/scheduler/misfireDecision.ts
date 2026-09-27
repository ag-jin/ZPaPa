/**
 * misfire 判定：本轮触发是否属于「关机/休眠/退出期间错过的窗口」，因而跳过不补跑。
 *
 * 判定必须区分两类「next_run_at 已在过去」的情况：
 *   - 真错过：app 没运行，到期时刻无人认领 → 跳过（避免开机后集中补跑一堆历史提醒）；
 *   - 等待重投：这一轮已被接受、正在退避或等待目标会话空闲 → **不得**跳过，
 *     否则长任务的提醒会在等待中被静默丢弃（用户明确要求会话停下后仍要执行）。
 *
 * retry_at 非空即表示属于第二类，因此它与 dispatch_attempts 一起构成 isRetry。
 */
export function isMissedTriggerWindow(params: {
  nextRunAt: number | null | undefined;
  retryAt: number | null | undefined;
  dispatchAttempts: number;
  now: number;
  graceMs: number;
}): boolean {
  const isAwaitingRedispatch = params.dispatchAttempts > 0 || params.retryAt != null;
  if (isAwaitingRedispatch) return false;
  if (params.nextRunAt == null) return false;
  return params.nextRunAt <= params.now - params.graceMs;
}
