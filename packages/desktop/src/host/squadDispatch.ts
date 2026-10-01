import { SQUAD_DISPATCH_DISABLED_CODE, type OpenMemberRunResult } from "@zcode/services";

/* 小队派发的**决策**（spec §5.7.6 门禁 / §6.1 隔离承诺 / 硬约束 1 忙检查）。

   为什么要把这一格从 host 的派发分支里抽出来做成纯函数：这里叠着三条**沉默的**判断——
   门禁结论怎么翻成回执、与会话忙是「等」还是「失败」、队员 run 没有工作树是不是可放行。
   放在 async 分支里，它们只能靠读代码相信；抽出来之后就是三个可断言的值。

   本函数**不读任何设置**：`dispatchEnabled` 是「服务层说可以派发」这一事实的**搬运**
   （判据的唯一实现在 `ISquadRuntimeService.assertDispatchEnabled`，spec §5.7.6 / 确认 2）。
   入参刻意不叫 `enabled`，免得下一个人以为可以在这里自己读一次 appSettings——
   读第二遍就多一份判据，改一处漏一处正是「关掉实验照旧派发」的形态。 */

export type SquadDispatchKind = "leader" | "member";

export type SquadDispatchDecision =
  | {
      action: "dispatch";
      kind: SquadDispatchKind;
      prompt: string;
      /**
       * 会话要落在哪个 workspace：队员 run 是**工作树**（spec §6.1 的隔离承诺落点），
       * 队长 run 是 undefined——它直接在目标工作区执行，而目标工作区在派发消息里，
       * 本函数不持有它（由调用点回填）。
       */
      workspacePath?: string;
    }
  | { action: "defer"; reason: "bound_session_busy" }
  | { action: "skip"; reason: "disabled_by_service" | "not_ready" }
  | { action: "fail"; reason: "member_run_requires_worktree" };

/**
 * 判定次序**本身是契约**（自上而下）：
 *
 * 1. `!databaseReady` → skip(`not_ready`)：库没就绪时任何写入都会失败，这是最基础的前提。
 * 2. `!dispatchEnabled` → skip(`disabled_by_service`)：服务层说门禁关了。**skip 不是失败**
 *    （spec §3.9 `dispatch_skipped` 不进失败率），关掉实验是确定性状态，不该计进失败。
 * 3. 队员 run 没有工作树 → fail：没有工作树就派发，等于让队员直接改**主工作区**——
 *    spec §6.1 的隔离承诺当场落空，而且不报错。这是最该响亮的一条，所以排在忙检查**之前**
 *    （忙是「等一会」，缺树是「这次派发的配置错了」，后者更严重）。
 * 4. `busy` → defer：绑定会话正在执行（**强探测**的结论，见 host 分支）。等待型重投：
 *    既不投递也不判失败（与 cron 的 deferred 同义），避免长任务期间唤醒被重试预算判死。
 * 5. 否则 → dispatch。
 */
export function decideSquadDispatch(input: {
  /** 服务层门禁调用的结论（判据只有服务层一处，见文件头注释）。 */
  dispatchEnabled: boolean;
  databaseReady: boolean;
  /** 绑定会话是否正在执行：只接受**强探测**（Agent runtime 快照）的结论，不是 tasks-index 投影。 */
  busy: boolean;
  kind: SquadDispatchKind;
  /** 队长 run 的 prompt（三段简报渲染出来的）。 */
  briefingPrompt: string;
  /** 队员 run 的 prompt（工作项标题+正文+汇报要求）。 */
  memberPrompt: string;
  /** 队员 run 先开树的结果；队长 run 恒为 undefined（队长不建树）。 */
  worktree: OpenMemberRunResult | undefined;
}): SquadDispatchDecision {
  if (!input.databaseReady) return { action: "skip", reason: "not_ready" };
  if (!input.dispatchEnabled) return { action: "skip", reason: "disabled_by_service" };
  if (input.kind === "member" && input.worktree === undefined) {
    return { action: "fail", reason: "member_run_requires_worktree" };
  }
  if (input.busy) return { action: "defer", reason: "bound_session_busy" };
  return {
    action: "dispatch",
    kind: input.kind,
    prompt: input.kind === "leader" ? input.briefingPrompt : input.memberPrompt,
    ...(input.worktree !== undefined ? { workspacePath: input.worktree.worktreePath } : {}),
  };
}

/**
 * 门禁错误按**稳定 code** 判，不按文案（spec §5.7.6：错误码跨进程传到上层后要继续可分流）。
 *
 * 为什么不能匹配 message：文案是给人看的，会随措辞改动漂移；一旦按文案判，
 * 「哪天把「实验功能已关闭」改成别的说法」就变成「门禁结论悄悄失效、改按 transient 退避空转」。
 * 也不用 `instanceof`：错误从 host 的服务层抛出来，跨实现边界时靠 `code` 才是稳定契约
 * （与 AUTOMATION_BOUND_SESSION_BUSY_ERROR_CODE 的既有做法一致）。
 */
export function isSquadDispatchDisabledError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === SQUAD_DISPATCH_DISABLED_CODE
  );
}
