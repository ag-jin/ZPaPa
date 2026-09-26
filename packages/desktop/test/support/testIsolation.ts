/**
 * 跨机测试的隔离护栏。
 *
 * 背景：一次验证误用了用户正在运行的真实会话，把测试消息写进了用户历史，
 * 且因 CLI 重写了消息 id 而无法精确回滚。跨机测试必须假设"对端是用户的
 * 生产环境"，任何写操作都要能被证明只落在自己创建的对象上。
 *
 * 本模块提供两件东西：
 * 1. 测试对象命名约定 —— 自建对象带可识别前缀，便于审计与清理。
 * 2. 写操作前的守卫 —— 拒绝在任何"非本次创建"的对象上做写操作。
 */

/** 测试自建对象的统一前缀，用于区分用户数据。 */
export const TEST_OBJECT_PREFIX = "zpapa-test-";

/** 判断某个会话是否由测试创建（按标题前缀识别）。 */
export function isTestOwnedSession(title: string | undefined | null): boolean {
  return typeof title === "string" && title.startsWith(TEST_OBJECT_PREFIX);
}

export interface TestGuardDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * 写操作前的守卫。
 *
 * 规则：只有当目标会话是本次运行创建的（id 在 `createdSessionIds` 内）时才放行。
 * 绝不按"最近活跃""状态为 completed""标题看起来像测试"这类启发式挑选目标 ——
 * 那些正是此前误碰用户会话的原因。
 */
export function assertTestOwnedTarget(params: {
  taskId: string;
  createdSessionIds: ReadonlySet<string>;
  operation: string;
}): TestGuardDecision {
  if (params.createdSessionIds.has(params.taskId)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `${params.operation} 被隔离护栏拒绝：目标会话 ${params.taskId} 不是本次运行创建的。` +
      `跨机写测试只允许操作自己新建的一次性会话（前缀 ${TEST_OBJECT_PREFIX}），` +
      `以免把测试内容写进用户正在使用的会话。`,
  };
}

/** 自建会话标题，带前缀与时间戳，便于对端审计和事后清理。 */
export function buildTestSessionTitle(scope: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${TEST_OBJECT_PREFIX}${scope}-${stamp}`;
}
