/**
 * **CT.2：host 三臂的用量捕获工具**（#6 按 run 记账的接线条）。
 *
 * 一句话：在三条既有收尾臂（run 终态出口 / 看门狗结算 / 启动和解）**收尾之后**各补拉一次
 * `getTaskTokenUsage`，把快照经服务面 `recordSquadRunUsage` 落进台账 —— 全部 **best-effort**。
 *
 * 四条纪律（写进代码就是防漂移的那一份判据）：
 * · **终态是主事实，用量是属性**：调用点必须排在终态写入**之后**（见各调用点的注释）；
 *   反过来（先写用量）会留下「有用量但未结算」的行，与「台账即真相」冲突。
 * · **数据源不可得 ⇒ 静默跳过留 NULL**：`sessionId === null`（排队 / 残行 / 重开臂置空）时
 *   不拉不写、也不告警 —— 「没有会话」不是异常，写 0 才是说谎（NULL ≠ 0）。
 * · **失败只 warn 不阻断**：拉取 / 落账任一步抛错都只 `logger.warn`（带 runId，**不带用量明细**），
 *   台账保持 NULL；记账失败绝不反噬事实流（与投影同款纪律）。
 * · **只经既有查询面**（`getTaskTokenUsage`，读 CLI 侧聚合，只读 / 超时重发安全；U2）——
 *   不订阅 `onDynamicStreamEvent` 自累计：那会引入第二份状态（run↔累计值的内存副本）。
 *
 * 为什么抽成本模块（而不是照任务卡的「定义在 index.ts」）：`host/index.ts` 是进程入口
 * （顶层 `parentPort.on` 副作用）**不能在测试进程里 import**，定义在那里等于「拉取失败留 NULL
 * 只 warn」这一条**只能靠读源码相信**。本模块把行为收成可注入依赖的构件（照 `squadWatchdogTick` /
 * `squadDispatch` 的既有分法：lane 逻辑在独立模块里被真实驱动，`index.ts` 只做薄接线），
 * 结构守卫在测试里钉住 index.ts 的**调用点计数与次序**。
 */
import type {
  IZCodeTaskService,
  ISquadRuntimeService,
  SquadRunUsageSnapshot,
} from "@zcode/services";
import type { ZCodeTaskTokenUsageResult } from "@zcode/shared";

/** 捕获臂的依赖（全部注入：本模块不取服务、不读全局；测试因此能用最小 stub 驱动）。 */
export type SquadRunUsageCaptureDeps = {
  /** 用量事实源（唯一读口）：`IZCodeTaskService.getTaskTokenUsage`。 */
  zcodeTaskService: Pick<IZCodeTaskService, "getTaskTokenUsage">;
  /** 落账入口（唯一写者）：`ISquadRuntimeService.recordSquadRunUsage`（不过门禁、write-once）。 */
  squadRuntime: Pick<ISquadRuntimeService, "recordSquadRunUsage">;
  logger: { warn(message: string, error?: unknown): void };
};

export type SquadRunUsageCaptureInput = {
  /** 本次 run 所在 workspace（服务面 `SquadWorkspaceTarget` 的结构形状）；identity 空白 ⇒ 不传。 */
  target: { path: string; identity: string };
  runId: string;
  /** 本条 run 绑定的会话（台账 `session_id` / 本次派发的 taskId）；`null` ⇒ 没有用量事实可拉。 */
  sessionId: string | null;
};

/**
 * 协议 8 字段 → 台账快照（**显式投影**）：只取这 8 个数值，`sessionId` 与 `inputBaselineBySource`
 * 这两个第二形状（台账已有的会话列 / JSON 分桶）一律不带。
 *
 * 为什么不用解构剩余（`const { sessionId, inputBaselineBySource, ...rest } = usage`）：剩余法让
 * **将来协议新增的字段自动流进台账形状** —— 那会绕过「形状封闭就该拆列」的既有判据，且不报错。
 * 显式列举的下场是「协议加了字段而台账没加」时只丢一个字段（有意识），不是悄悄多一个形状。
 */
function toSquadRunUsageSnapshot(usage: ZCodeTaskTokenUsageResult): SquadRunUsageSnapshot {
  return {
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
  };
}

/**
 * 一次 best-effort 捕获。返回 `Promise<void>`：调用方**不需要**结论 —— 落账成败都在内部处置
 * （成功即台账列非 NULL，失败即保持 NULL + 一行 warn），把结论回给调用方只会诱出第二份判据。
 */
export async function captureSquadRunUsage(
  deps: SquadRunUsageCaptureDeps,
  input: SquadRunUsageCaptureInput,
): Promise<void> {
  if (input.sessionId === null) return;
  const sessionId = input.sessionId;
  try {
    const usage = await deps.zcodeTaskService.getTaskTokenUsage({
      taskId: sessionId,
      workspacePath: input.target.path,
      // identity 空白 ⇒ 不传（口径单源在 `resolveWorkspaceKey`：identity 非空白优先，否则 path）。
      ...(input.target.identity ? { workspaceIdentity: input.target.identity } : {}),
    });
    await deps.squadRuntime.recordSquadRunUsage(input.target, {
      runId: input.runId,
      usage: toSquadRunUsageSnapshot(usage),
    });
  } catch (error) {
    /* 记账失败**不反噬事实流**：终态 / 通知 / Inbox 全部照旧，这里只留一行 warn（带 runId）。
       不带用量明细：明细可能含大段数字，且「哪些列没写」由台账 NULL 自己说。 */
    deps.logger.warn(
      `[squad] run 用量捕获失败（台账保持 NULL，不阻断收尾）：runId=${input.runId} session=${sessionId}`,
      error,
    );
  }
}
