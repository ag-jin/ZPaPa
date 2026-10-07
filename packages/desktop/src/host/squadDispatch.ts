import { SQUAD_DISPATCH_DISABLED_CODE, type IZCodeTaskService } from "@zcode/services";
import {
  COMMENT_DISPATCH_UNSETTLED_OUTCOMES,
  type CommentDispatchOutcome,
  type CommentDispatchReceiptRecord,
  type DeferredDispatchOrigin,
  type RunClass,
  type SquadDeferredDispatchRecord,
} from "@zcode/services/node";

/* 小队派发的**决策**（spec §5.7.6 门禁 / §6.1 隔离承诺 / 硬约束 1 忙检查）。

   为什么要把这一格从 host 的派发分支里抽出来做成纯函数：这里叠着三条**沉默的**判断——
   门禁结论怎么翻成回执、与会话忙是「等」还是「失败」、队员 run 没有工作树是不是可放行。
   放在 async 分支里，它们只能靠读代码相信；抽出来之后就是三个可断言的值。

   本函数**不读任何设置**：`dispatchEnabled` 是「服务层说可以派发」这一事实的**搬运**
   （判据的唯一实现在 `ISquadRuntimeService.assertDispatchEnabled`，spec §5.7.6 / 确认 2）。
   入参刻意不叫 `enabled`，免得下一个人以为可以在这里自己读一次 appSettings——
   读第二遍就多一份判据，改一处漏一处正是「关掉实验照旧派发」的形态。 */

/**
 * run 的类别 —— **直接取自** `planDispatch` 的显式判别字段 `runClass`（加法的单一来源）。
 *
 * 为什么是别名而不是就地再写一个联合：类别是**规划**（`planDispatch`）的结论，派发桥只做搬运；
 * 在这里抄一份三值联合，改了那边忘了这边**不会有任何编译错**，表现的正是本次要消灭的
 * 「两类 run 长得一样」形态。名字保留 `SquadDispatchKind` 只为不动既有调用点的读法。
 */
export type SquadDispatchKind = RunClass;

/**
 * 台账动作（**类别的函数**）：派发桥在「开树 / 登记台账」这一格要做什么。
 *
 * 为什么把它抽成纯函数而不是散在 host 的 `if` 链里：这是本次缺陷的落点 ——
 * 旧写法是「非队长 ⇒ `openMemberRun`」，于是**单独安排的智能体也开了一棵树**（§6.1 落空、
 * 孤立分支永不合并也永不回收，且不报错）。抽成一个按 `runClass` 查表的纯函数后，
 * 「standalone ⇒ 无台账动作」变成一条**可直接断言的值**（不必起 Electron / 真实 git）。
 */
export type SquadLedgerAction = "open_member_run" | "record_leader_run" | "none";

export function ledgerActionForRunClass(runClass: SquadDispatchKind): SquadLedgerAction {
  switch (runClass) {
    // 队员：开工作树（`openMemberRun` 内含 `isLeaderTask: false`）+ 登记台账行 —— 既有路径不变。
    case "member":
      return "open_member_run";
    // 队长：只登记台账行（§5.7(1) 判「进行中」），**不开树** —— 既有路径不变。
    case "leader":
      return "record_leader_run";
    // 单独安排的智能体：**不开工作树、不开分支、不登记台账**（§6.1）。
    // 台账是**小队**运行台账，而它不在任何小队里；且它无分支 ⇒ 对 `activeBranches` 零贡献，
    // 台账存在的理由（被回收的口径 / 产出活到合并）对它一样都不成立。会话照发（见 host 派发桥）。
    case "standalone":
      return "none";
  }
}

export type SquadDispatchDecision =
  | {
      action: "dispatch";
      kind: SquadDispatchKind;
      prompt: string;
      /**
       * 会话要落在哪个 workspace：队员 run 是**工作树**（spec §6.1 的隔离承诺落点），
       * 队长 run 与单独安排的智能体是 undefined——它们直接在目标工作区执行，
       * 而目标工作区在派发消息里，本函数不持有它（由调用点回填）。
       */
      workspacePath?: string;
    }
  | { action: "defer"; reason: "bound_session_busy" }
  | { action: "skip"; reason: "disabled_by_service" | "not_ready" | "leader_run_merged" }
  | { action: "fail"; reason: "member_run_requires_worktree" };

/**
 * 判定次序**本身是契约**（自上而下）：
 *
 * 1. `!databaseReady` → skip(`not_ready`)：库没就绪时任何写入都会失败，这是最基础的前提。
 * 2. `!dispatchEnabled` → skip(`disabled_by_service`)：服务层说门禁关了。**skip 不是失败**
 *    （spec §3.9 `dispatch_skipped` 不进失败率），关掉实验是确定性状态，不该计进失败。
 * 3. **队员** run 没有工作树 → fail：没有工作树就派发，等于让队员直接改**主工作区**——
 *    spec §6.1 的隔离承诺当场落空，而且不报错。这是最该响亮的一条，所以排在忙检查**之前**
 *    （忙是「等一会」，缺树是「这次派发的配置错了」，后者更严重）。
 *    **只对 `member` 判**：队长与**单独安排的智能体**本来就**没有**工作树（§6.1/§6.2，
 *    `worktree === undefined` 是它们的正确形状），把这条判据套到它们身上会把正确的派发判成失败。
 * 4. **队长** run 进行中 → skip(`leader_run_merged`)：§5.7(1)/S13 的「重复指派合并为同一次」。
 *    位置**必须**在忙检查之前 —— 见函数体里的理由（否则会先 defer、等队长跑完再起第二次 run）。
 * 5. `busy` → defer：绑定会话正在执行（**强探测**的结论，见 host 分支）。等待型重投：
 *    既不投递也不判失败（与 cron 的 deferred 同义），避免长任务期间唤醒被重试预算判死。
 * 6. 否则 → dispatch。
 */
export function decideSquadDispatch(input: {
  /** 服务层门禁调用的结论（判据只有服务层一处，见文件头注释）。 */
  dispatchEnabled: boolean;
  databaseReady: boolean;
  /** 绑定会话是否正在执行：只接受**强探测**（Agent runtime 快照）的结论，不是 tasks-index 投影。 */
  busy: boolean;
  kind: SquadDispatchKind;
  /**
   * 该工作项**有没有进行中的队长 run** —— 服务层台账给出的事实（唯一读法是 `hasInProgressLeaderRun`，
   * 随包入口导出；本函数既不读台账、也不另写一份「怎么算进行中」的判据）。
   * 用途见下面的第 4 条判据（§5.7(1)/S13 的重复指派合并）。
   */
  leaderRunInProgress: boolean;
  /** 队长 run 的 prompt（三段简报渲染出来的）。 */
  briefingPrompt: string;
  /** 队员 run 的 prompt（工作项标题+正文+**工作树**要求）。 */
  memberPrompt: string;
  /** 单独安排的智能体 run 的 prompt（工作项标题+正文+**直接在工作区改**的要求，§6.1）。 */
  standalonePrompt: string;
  /** 队员 run 先开树的结果；队长与单独安排的智能体恒为 undefined（这两类不建树）。 */
  /* 已开树的形态（C3 起 openMemberRun 的返回是判别联合，走到这里的一定是 opened 变体；
     纯函数只消费「树在哪」，不消费排队/并入结论——那些在 host 派发桥分流）。 */
  worktree: { branch: string; worktreePath: string } | undefined;
}): SquadDispatchDecision {
  if (!input.databaseReady) return { action: "skip", reason: "not_ready" };
  if (!input.dispatchEnabled) return { action: "skip", reason: "disabled_by_service" };
  if (input.kind === "member" && input.worktree === undefined) {
    return { action: "fail", reason: "member_run_requires_worktree" };
  }
  /* §5.7(1)/S13：队长 run 进行中 ⇒ **合并**（吸收这次指派），不新起一条队长 run。
     为什么**必须**在 `busy` 之前：忙是「等一会再投」⇒ 排在它后面的话，这次指派会先被 defer，
     等那条队长 run 跑完（会话空闲）后**照样起第二次 run** —— 那正是 S13 要禁的「排队的第二次 run」。
     而且忙着的那次很可能**正是**这条进行中的队长 run 本身（同一工作项、同一个绑定会话）。
     为什么**只对队长**：队员的幂等靠台账主键（同一 `eventKey` 重投撞主键、响亮回执），
     单独安排的智能体压根不登记台账行（§6.1，没有「进行中」可言）—— 把这条判据套到那两类身上，
     会让一次**正常**的派发被静默吞掉（用户看到「指派了但什么都没发生」）。 */
  if (input.kind === "leader" && input.leaderRunInProgress) {
    return { action: "skip", reason: "leader_run_merged" };
  }
  if (input.busy) return { action: "defer", reason: "bound_session_busy" };
  return {
    action: "dispatch",
    kind: input.kind,
    /* prompt 按类别选：只有队长拿到三段简报；队员与单独安排的智能体都拿工作项的 prompt，
       但两者的**工作方式要求不同**（队员在独立工作树里干活、单独安排的智能体直接改工作区），
       故是两个不同的串 —— 混用会把「不要改主工作区」发给一个本就该改主工作区的智能体。 */
    prompt:
      input.kind === "leader"
        ? input.briefingPrompt
        : input.kind === "member"
          ? input.memberPrompt
          : input.standalonePrompt,
    ...(input.worktree !== undefined ? { workspacePath: input.worktree.worktreePath } : {}),
  };
}

/**
 * 启动**和解**的判据：活跃队长行里，哪些**已经没有东西会把它推向终态**（⇒ 必须收口）。
 *
 * 为什么必须有这一步：队长行的终态由「该 run 的会话终态回调」送入。进程在队长 run 进行中被强杀 /
 * 重启后，**那个回调永远不会来** ⇒ 行永远停在 `open`；而 §5.7(1) 的合并判据（第 14 轮接上行为、
 * 第 15 轮又落到存储层）会因此把该工作项的**后续所有指派静默并入** —— 用户看到的是
 * 「点了指派没反应」，而且**永久**如此。静默 + 永久是本项目最忌讳的形态（见台账第 15 轮）。
 *
 * 判据 = **不在执行**（`executingSessionIds` 里没有它）。启动时刻这条判据可靠：重启后没有任何
 * 自动恢复会把队长会话接着跑（`resumeTask` 只在真正要派发时按需冷恢复，见 host 的绑定会话分支）。
 * **未绑会话的行**（`sessionId === null`：本次改动之前登记的历史行）同样按「没有东西会推进它」处置
 * —— 启动时刻它们只可能来自上一个进程。
 *
 * **只收队长行**（W2 契约修订：这段注释此前写的是「队员行的归宿是它自己的终态回调 + 启动回收器」，
 * 而 W2 之后队员行多了一个**合法归宿**）：队员行的结算约束 = **只经 `failMemberRun`**（唯一写者）
 * **+ 树/分支归回收器**（按活跃集口径收，spec §6.2/S5）。**看门狗结算**（启动队员臂 / 在线 tick）
 * 是第二个合法归宿 —— 它同样只经 `failMemberRun`、同样不碰 git。换言之这条注释真正排除的从来不是
 * 「谁结算」，而是「绕开 `failMemberRun` 去删树」：那会绕开 S5（产出必须活到合并）。
 * 队长行仍在这里收：它无树无枝，判据「不在执行」在启动时刻恒可靠（见上面两段）。
 */
export function selectStaleLeaderRuns(input: {
  activeRuns: ReadonlyArray<{ runId: string; isLeaderTask: boolean; sessionId: string | null }>;
  /** 此刻**真的在执行**的会话 id（host 侧强探测的结论；探测不到的会话不在集合里）。 */
  executingSessionIds: ReadonlySet<string>;
}): string[] {
  return input.activeRuns
    .filter((run) => run.isLeaderTask)
    .filter((run) => run.sessionId === null || !input.executingSessionIds.has(run.sessionId))
    .map((run) => run.runId);
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

/**
 * 一次 task 输入轮次的终态（`IZCodeTaskService.onDynamicTaskTerminalOutcome` 的结构子集）。
 * 只取收口需要的字段：`inputId` 认「是不是本次派发」，`outcome` 判有没有产出。
 *
 * 名字里的 `Member` 是历史命名：队长 run 也是**一次真实会话**，终态落在**同一条出口**上
 * （`onDynamicTaskTerminalOutcome` + `inputId === traceId`），故两种 run 共用这个形状。
 */
export type SquadMemberRunTerminalOutcome = {
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  error?: string;
};

/**
 * run 的终态订阅句柄（照 cron 侧 `cronRunSubscriptions` 的形态：存起来、终态后 dispose）。
 *
 * 按 `runId`（= 一次派发的 `eventKey`，也就是幂等键的稳定一半）分账：
 * - 终态（成功 / 失败 / 中止）到达 ⇒ 收口结束，撤下句柄（否则每次派发都新增一个永不解绑的监听器，
 *   随派发次数累积）；
 * - 重投同一条事实会**重新订阅**（可能换了 taskId）⇒ 先撤下旧句柄再存新的，避免叠加。
 *
 * **队员与队长 run 共用这一张表**：两者的 `runId` 都取 `eventKey`（同一次派发只有一个身份，
 * 不可能相撞），而「终态后 dispose / 重投先撤旧」这套生死管理对两种 run **完全一样** ——
 * 分开两张表就多一套需要各自维护的规则（迟早一边漏了 dispose）。
 *
 * 为什么用模块级 Map 而不是把句柄交回调用点：与 cron 侧同形（那边也是模块级 Map + dispose 助手），
 * 且这里的调用点（`host/index.ts` 的派发桥）不持有生命周期钩子；收口本身就在这里发生，
 * 句柄的生死也在这里闭环。
 */
const runSettlementSubscriptions = new Map<string, { dispose(): void }>();

function disposeRunSettlementSubscription(runId: string): void {
  const disposable = runSettlementSubscriptions.get(runId);
  if (!disposable) return;
  runSettlementSubscriptions.delete(runId);
  disposable.dispose();
}

/**
 * run **终态收口**的**公共骨架**（队员 / 队长共用）：订阅该 task 的终态 → 按 `inputId` 认本次派发
 * → 成功则入账、失败/中止则留痕 → 终态后撤下句柄（重投先撤旧）。
 *
 * 为什么抽成一处而不是各写一份：两种 run 的差别**只有两格** —— 成功的入账动作（`settleOnSuccess`）
 * 与几句日志文案。订阅/认轮/解绑/异常处理这些是**同一套规则**；抄成两份后，任何一份的修补
 * （例如某个路径忘了 dispose）都不会被另一份继承，而表现是「监听器随派发累积」这类不报错的泄漏。
 *
 * 失败/中止**不得**冒充成功：本骨架只负责「未产出就留痕」，**不负责**动用失败出口 ——
 * 那是**调用方的订阅闭包**的事（host 收到 `outcome !== "succeeded"` 时调 `failMemberRun`，
 * 裁定 Important-3）。本骨架的 `logError` 因此是**第二道**留痕，不是唯一归宿。
 */
function watchRunSettlement(params: {
  /** 幂等键里稳定的那一半（`eventKey`），也是台账行的 runId。 */
  runId: string;
  /** 本次派发用的 trace（= sendPrompt 的 traceId）：只认这一轮，别轮的终态不算本次 run 的终态。 */
  traceId: string;
  subscribe: (listener: (outcome: SquadMemberRunTerminalOutcome) => void) => { dispose(): void };
  /** 成功时的入账动作（队员 = `completeMemberRun`；队长 = `completeLeaderRun`）。 */
  settleOnSuccess: (runId: string) => Promise<void>;
  /** 「未产出」的留痕文案（只有两种 run 的措辞不同，格式一致，故由调用方给）。 */
  notProducedLog: (outcome: SquadMemberRunTerminalOutcome) => string;
  /** 成功入账后的留痕文案。 */
  settledLog: string;
  /** 入账动作本身失败时的留痕文案（run 会停在 `open`，必须响亮）。 */
  settleFailedLog: string;
  /** 订阅本身抛错时的留痕文案（没有订阅就没有收口）。 */
  subscribeFailedLog: string;
  logInfo: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
}): void {
  // 重投同一条事实会再次订阅 ⇒ 先撤下旧句柄，避免监听器随重投次数叠加（照 cron 的 dispose-before-set）。
  disposeRunSettlementSubscription(params.runId);
  try {
    const disposable = params.subscribe((outcome) => {
      // inputId 缺失或不是本轮 ⇒ 不是这次派发的终态（用户插话、上一轮残留），**继续等**：不解绑。
      if (outcome.inputId !== params.traceId) return;
      // 本轮终态（成功 / 失败 / 中止）到达 ⇒ 收口结束，撤下句柄（否则每次派发累积一个监听器）。
      disposeRunSettlementSubscription(params.runId);
      if (outcome.outcome !== "succeeded") {
        params.logError(params.notProducedLog(outcome), outcome.error);
        return;
      }
      void params.settleOnSuccess(params.runId).then(
        () => params.logInfo(params.settledLog),
        (error) => params.logError(params.settleFailedLog, error),
      );
    });
    runSettlementSubscriptions.set(params.runId, disposable);
  } catch (error) {
    // 订阅本身失败也要响亮：没有订阅就没有收口，run 会停在 open。也不留下半个句柄。
    disposeRunSettlementSubscription(params.runId);
    params.logError(params.subscribeFailedLog, error);
  }
}

/**
 * 队员 run 的**终态收口**（照 `trackCronRunOutcome` 的形态：订阅该 task 的终态 → 按 inputId 认本次派发）。
 *
 * 为什么必须有这一步：`openMemberRun` 写下的台账行只有经 `completeMemberRun` 才会从 `open` 前进到
 * `produced`（产出入账）。没有它，每条队员 run 都**永远停在 open**、永远算「活跃」
 * （`SquadRunRepo.listActive`），于是工作树与分支永远不被回收，而且没人能从台账看出它早就跑完了。
 * 冻结面把 `completeMemberRun` 的调用者写明是「host 派发桥」——就是这里。
 *
 * 失败/中止**不得**冒充产出：`completeMemberRun` 会把 run 置 `produced` 并把工作项推到 `in_review`，
 * 那等于凭空宣布「队员交了东西」。失败那一支的归宿在**调用方的订阅闭包**里：host 收到
 * `outcome !== "succeeded"` 时调服务面的 `failMemberRun` 把该 run 移出活跃集（裁定 Important-3，
 * 2026-10-02；见 `squadRuntimeRecovery.test.ts` 与 `squadWiring.test.ts` 的接线守卫），工作树/分支
 * 随后由启动回收器按「不在活跃集」回收（spec §6.6）。本函数**不负责**动用那个出口（它只做成功入账），
 * 故这里的 `logError` 是**第二道**留痕（人能看到「哪一次没产出」），不是唯一归宿。
 *
 * 依赖全部注入（订阅出口 / 收口动作 / 日志）：本函数因此能在没有 Electron、没有 sqlite 的进程里
 * 被直接驱动 —— 「run 真的从 open 走到产出入账」这一格必须由**实体状态**断言，而不是读源码相信。
 */
export function watchMemberRunSettlement(params: {
  /** 幂等键里稳定的那一半（`eventKey`），也是台账行的 runId。 */
  runId: string;
  /** 本次派发用的 trace（= sendPrompt 的 traceId）：只认这一轮，别轮的终态不算本次 run 的产出。 */
  traceId: string;
  subscribe: (listener: (outcome: SquadMemberRunTerminalOutcome) => void) => { dispose(): void };
  /** `ISquadRuntimeService.completeMemberRun` 的绑定形态（已绑定 target）。 */
  completeMemberRun: (runId: string) => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
}): void {
  watchRunSettlement({
    runId: params.runId,
    traceId: params.traceId,
    subscribe: params.subscribe,
    settleOnSuccess: params.completeMemberRun,
    notProducedLog: (outcome) =>
      `[squad] member run 未产出（终态=${outcome.outcome}）：runId=${params.runId}` +
      " —— 失败那一支由 host 的订阅闭包调 `failMemberRun` 移出活跃集（工作树/分支交给启动回收）",
    settledLog: `[squad] member run 产出入账：runId=${params.runId} ⇒ produced`,
    settleFailedLog: `[squad] member run 终态入账失败：runId=${params.runId} 停在 open（台账需人工/后续任务处置）`,
    subscribeFailedLog: `[squad] member run 终态订阅失败：runId=${params.runId} 的收口会丢失`,
    logInfo: params.logInfo,
    logError: params.logError,
  });
}

/**
 * 队长 run 的**终态收口**：与队员走**同一条出口**（`onDynamicTaskTerminalOutcome` + `inputId === traceId`）
 * —— 队长 run 也是一次真实会话（会话与 trace 都在派发桥里建/发），终态一样能被观察到。
 *
 * 为什么队长也必须收口（否则 §5.7(1) 的判据被架空）：`recordLeaderRun` 只把行登记成 `open`，而队长
 * run **没有队员那一步 review/merge**（无分支可合、无树可抛）⇒ 没有任何东西会在它跑完后把这条行
 * 移出活跃集（`SQUAD_RUN_ACTIVE_STATUSES` 含 `open`）⇒ **成功的队长行长驻 `open`** ⇒
 * 「该工作项有没有进行中的队长 run」（`hasInProgressLeaderRun`）**恒为真**，于是「重复指派合并为一次」
 * 会把该工作项**所有后续指派永久吃掉**（不报错）。成功那一支的入账动作用 `completeLeaderRun`。
 *
 * 与队员的**唯一差别**是成功的入账动作：队员 ⇒ `completeMemberRun`（产出入账 + 工作项推 `in_review`）；
 * 队长 ⇒ `completeLeaderRun`（**只把台账行移到终态**，不碰工作项 —— spec §5.7(2)）。失败/中止那一支
 * 两者相同：host 的订阅闭包调 `failMemberRun` 把该 run 移出活跃集（队长无树无枝，`discarded` 之后
 * 不产生任何需要回收的东西，§6.2）。
 */
export function watchLeaderRunSettlement(params: {
  /** 幂等键里稳定的那一半（`eventKey`），也是台账行的 runId。 */
  runId: string;
  /** 本次派发用的 trace（= sendPrompt 的 traceId）：只认这一轮。 */
  traceId: string;
  subscribe: (listener: (outcome: SquadMemberRunTerminalOutcome) => void) => { dispose(): void };
  /** `ISquadRuntimeService.completeLeaderRun` 的绑定形态（已绑定 target）。 */
  completeLeaderRun: (runId: string) => Promise<void>;
  logInfo: (message: string) => void;
  logError: (message: string, error?: unknown) => void;
}): void {
  watchRunSettlement({
    runId: params.runId,
    traceId: params.traceId,
    subscribe: params.subscribe,
    settleOnSuccess: params.completeLeaderRun,
    notProducedLog: (outcome) =>
      `[squad] leader run 未产出（终态=${outcome.outcome}）：runId=${params.runId}` +
      " —— 失败那一支由 host 的订阅闭包调 `failMemberRun` 移出活跃集（队长无工作树/分支）",
    settledLog: `[squad] leader run 收口入账：runId=${params.runId} ⇒ merged（队长 run 不改父项状态）`,
    // 队长行停在 open 的后果比队员更重：§5.7(1) 的「进行中」会**永真**（重复指派被永久合并）。
    settleFailedLog:
      `[squad] leader run 终态入账失败：runId=${params.runId} 停在 open` +
      "（§5.7(1) 的「进行中」会永真 —— 该工作项的后续指派会被永久合并）",
    subscribeFailedLog: `[squad] leader run 终态订阅失败：runId=${params.runId} 的收口会丢失`,
    logInfo: params.logInfo,
    logError: params.logError,
  });
}

/* ───────────────────────── X2.1：评论派发通道（B/C） ─────────────────────────

   评论触发的派发与规则/改派共用**唯一**派发实现（`runSquadDispatch`），本模块只放两件
   可独立断言的东西：① 重放回路按义务 `origin` 的**分流判据**；② 一次派发落点 → receipt
   outcome 的**落定映射**。放在这里而不是散在 host 的 async 分支里：这两处各有一个静默失败形态
   （评论义务被 R2 账重放 ⇒ 目标被换回 assignee / 义务静默丢弃；queued 记成 failed ⇒
   可推进的排队被写成终局失败），抽成纯函数才能被穷举钉住。 */

/**
 * 重放通道（`advanceSquadQueueAfterSettlement` 的 `claimDue` 结果分流）：
 * · `reassign_replay`：既有 R2 回路（改派义务）—— 以 `obligation.runId` 为 eventKey 重投，
 *   派发目标仍是 assignee（A1 重验要求 `assignee.id === agentId`）；
 * · `comment_replay`：评论重放账 —— **重投评论派发入口**（按 receipt 事实：目标、工作项、
 *   dispatchKey 都从 receipt 取，再走 `targetOverride`），**不得**把义务行当 R2 请求现造 run
 *   （评论目标 ≠ assignee 是常态格，走 R2 会先被 A1 重验丢弃）；
 * · `watchdog_replay`：看门狗**自动重试**义务（W3 §3.5）—— 与被结算的那条 run 同 `(workItem, agent)` 对，
 *   重放用**新 runId**（义务登记时铸定）作 eventKey：重试是**新**派发决策，与既有义务重放同一实现
 *   （A1 重验 + `trigger:"replay"`）。它的独立分支值不是装饰：重放的**归属留痕**必须能说出
 *   「这是看门狗自动重试」而不是「有人改派了」，否则一次自动重试与一次用户改派重放在日志里一模一样。
 */
export type DeferredReplayChannel = "reassign_replay" | "comment_replay" | "watchdog_replay";

export function replayChannelForObligationOrigin(
  origin: DeferredDispatchOrigin,
): DeferredReplayChannel {
  switch (origin) {
    case "reassign":
      return "reassign_replay";
    case "comment":
      return "comment_replay";
    case "watchdog":
      return "watchdog_replay";
    default: {
      /* 闭集外来源**响亮抛**（读回闸已在 repo 层拦一道，这里是不依赖 DB 的第二道）：
         静默落到任何一条通道都意味着「评论义务被 R2 重放」或反之 —— 两者都不报错。
         `never` 守卫同时是**编译期**保险：origin 闭集加值而这里没加分支 ⇒ 编译错。 */
      const raw: never = origin;
      throw new Error(
        `未知的 deferred 义务来源「${String(raw)}」：origin 闭集只有 reassign/comment/watchdog，` +
          "静默按某条通道重放会让评论义务走 R2 账（目标被换回 assignee / 义务静默丢弃）。",
      );
    }
  }
}

/**
 * 派发桥执行一次的**落点**（`runSquadDispatch` 在每个出口如实标注）——
 * 评论 receipt 的回写判据面。`retry` = 本次未收敛（transient / 桥不可用 / 库未就绪）。
 */
export type SquadDispatchBridgeResult =
  | { kind: "dispatched" }
  | { kind: "queued" }
  /** 并入既有执行载体（排队行 / **义务行**）。`coalescedInto` = 被并入的 runId（X2.2：R2 义务
   *  分支的并入窗口 —— receipt 必须落终局 coalesced，而不是停在 deferred 等一个不会来的重放）。 */
  | { kind: "coalesced"; coalescedInto?: string }
  | { kind: "deferred" }
  /** 受限状态（门禁关闭 / planDispatch 的 skip：归档、停用、无人可派…）：可审计、不可派发。 */
  | { kind: "blocked"; reason: string }
  /** 确定性失败（数据/接线违例）：重投不自愈。 */
  | { kind: "failed"; error: string }
  /** 等待型：保持 receipt 未收敛，等重投（不得记 failed）。 */
  | { kind: "retry" };

/**
 * 落点 → 评论 receipt outcome（七值闭集；`null` = **不落定**，保持 pending 等重投）。
 *
 * 逐格口径（§5.6 用例 4/7 与 §12.1-12）：
 * · 已派出会话 ⇒ `opened`；容量满 ⇒ `queued`；并入既有待开 ⇒ `coalesced`；登记完成重放 ⇒ `deferred`；
 * · skip / 门禁关闭 ⇒ `blocked`（评论已发、目标未触发，如实回传，**不是**失败）；
 * · 其它确定性失败 ⇒ `failed`；`retry` ⇒ `null`（transient 记 failed 会把可重试写成终局失败，
 *   并把这条请求从重投面里摘掉）。
 */
export function commentReceiptSettlementFor(
  result: SquadDispatchBridgeResult,
): { outcome: CommentDispatchOutcome; detail?: Record<string, unknown> } | null {
  switch (result.kind) {
    case "dispatched":
      return { outcome: "opened" };
    case "queued":
      return { outcome: "queued" };
    case "coalesced":
      // 并入目标随 detail 落回收据（与源头修同一形状：并入是终局事实，读据要能回答「并进了哪一次」）。
      return result.coalescedInto !== undefined
        ? { outcome: "coalesced", detail: { coalescedInto: result.coalescedInto } }
        : { outcome: "coalesced" };
    case "deferred":
      return { outcome: "deferred" };
    case "blocked":
      return { outcome: "blocked", detail: { reason: result.reason } };
    case "failed":
      return { outcome: "failed", detail: { reason: result.error } };
    case "retry":
      return null;
  }
}

/** receipt 是否**未收敛**（可被本次执行认领回写）：判据与存储面的条件更新同源（常量同出一处）。 */
export function isUnsettledCommentDispatchReceipt(outcome: CommentDispatchOutcome): boolean {
  return (COMMENT_DISPATCH_UNSETTLED_OUTCOMES as readonly string[]).includes(outcome);
}

/* ───────────────── D6（§6/§11-C2）：评论目标的身份核对（队长 vs 普通智能体）─────────────────

   评论请求从 D6 起携带「这条请求的目标是哪支小队解析出来的」（receipt.detail.squadId）——
   但**是不是队长**还必须与**当前名册**对表：receipt 是首写事实，而小队可能在那之后换队长 /
   被删。核不出队长就退回既有的 agent 覆盖（旧契约），绝不夹带简报：
   简报是「你是队长，去派单」的机制段（`LEADER_PROTOCOL_TEXT`），发给一个不是队长的人 = 让它去派单。 */

/**
 * 评论目标是否是**该小队的队长**（是 ⇒ 返回那支小队，供 host 交给 `planDispatch.leaderOverride`；
 * 否 ⇒ `null`，host 走既有的 `targetOverride` 普通智能体覆盖）。
 *
 * 三条事实（全部是持久/名册事实，不从 `source` 反推）：
 * · `squadId`：receipt 记下的「哪支小队」（D6 起落库；缺席 = 目标不是从小队解析出来的）；
 * · `targetAgentId`：这次要跑的智能体（点名者 = 队长解析出来的那个 id）；
 * · `squads`：**当前**名册里的小队（host 从派发快照取，与工作项/小队用同一份快照）。
 * 判据 = `squad.leaderAgentId === targetAgentId`。
 *
 * 为什么「查不到小队」也退回普通覆盖（而不是跳过这条请求）：目标是一个**真实存在的智能体**
 * （它是 receipt 里的点名者），小队被删只说明「简报来源没了」；把请求丢掉会让一条评论请求
 * 无声消失，而按普通 agent 起 run 至少执行了用户点名的那个人（D6 之前的行为）。
 */
export function resolveCommentLeaderOverride<
  TSquad extends { id: string; leaderAgentId: string },
>(input: {
  targetAgentId: string;
  /** receipt.detail.squadId（读法只有 `commentReceiptSquadId` 一处；这里只收结果值）。 */
  squadId: string | undefined;
  /** 当前名册里的小队（结构子集：只用到 id 与 leaderAgentId 两条事实）。 */
  squads: readonly TSquad[];
}): TSquad | null {
  if (input.squadId === undefined) return null;
  const squad = input.squads.find((candidate) => candidate.id === input.squadId);
  if (squad === undefined) return null;
  return squad.leaderAgentId === input.targetAgentId ? squad : null;
}

/* ───────────────── X2.2：未收敛 receipt 的补投判据（结算事件 / 启动扫描共用）─────────────────

   补投 = 对「还没有执行者 / 还在等义务重放」的评论请求再走一次评论派发入口。它必须**幂等**
   （不重复建 run、不重复发 prompt、不从队列/义务通道手里抢执行），因为触发源是
   「workspace 里某条 run 结算了」与「进程启动」——两者都不携带「这条 receipt 现在该不该投」的判据，
   判据只能由持久事实（receipt 状态 + 台账 run 行 + 义务表）现算。三条错法的共同后果是
   「同一条请求跑两次」或「回执永停未收敛」，且都不报错。
   故本判据抽成纯函数：入参全是事实快照，结论是可直接断言的判别值。 */

/**
 * 义务表唯一键 `(workspace, workItem, agent)` 在内存里的投影（只取对内的两列）：
 * 补投判据与 host 的取数面共用这一处拼法 —— 两处各拼一份字符串迟早漂移，
 * 而漂移的表现是「义务归属判错」（把别的请求的义务当成自己的）且不报错。
 */
export function commentReceiptObligationPairKey(workItemId: string, agentId: string): string {
  return `${workItemId}\u0000${agentId}`;
}

/**
 * 「工作项查不到」的**稳定原因码**（X2.2 §7 统一终局）：在线入口、到期义务重放、补投扫描三处
 * 对同一事实必须给同一结论 —— `blocked`（受限状态：可审计、不可派发）。此前在线入口记 `failed`，
 * 而义务重放记 `blocked`：同一事实两种终局，重投行为与界面读法都不一致。
 */
export const WORK_ITEM_MISSING_REASON = "work_item_missing";

/** 一条未收敛 receipt 此刻的补投结论（判别值，无副作用）。 */
export type UnsettledReceiptRedispatchDecision =
  /** 安全：走评论派发入口重投（入口按 receipt 事实取数，派发桥负责幂等与落定）。 */
  | { action: "redispatch" }
  /** 跳过（本轮不再执行它）：reason 说明是哪条持久事实挡住了。 */
  | {
      action: "skip";
      reason:
        /** 该请求身份的 run 正在执行（重发会重复一次 prompt —— 复验 §5.4-5）。 */
        | "session_executing"
        /** 有绑定会话但探测能力不可得（agent 服务未注册）：不可知时不重发（不猜）。 */
        | "session_unprobeable"
        /** 该请求身份已有非 open 的 run 行（排队/已产出/被打回/终态）：执行已发生或已排上，重投会重复。 */
        | "own_run_not_open"
        /** 该请求自己的义务还挂在义务表上：重放通道拥有这次执行（扫描不得抢跑）。 */
        | "own_obligation_pending";
    }
  /** 同键义务属于**另一个请求**（历史行 / 并入窗口）：按 B-3「同键合并 = 一次执行」终局收敛。 */
  | { action: "settle_coalesced"; coalescedInto: string };

/**
 * 判据次序（自上而下，每一格都有专门的静默失败形态）：
 *
 * 1. **自己的 run 行**（`runId === dispatchKey`，取全量台账而非仅活跃集 —— 终态行同样是
 *    「这条请求已经有 run 身份」的证据）：
 *    · 非 `open`（queued / produced / rejected / merged / discarded）⇒ skip：执行已发生或已排上，
 *      重投会重复建会话/重复发 prompt（排队行的推进由结算回调的排队臂负责，不在这里抢）；
 *    · `open` 且绑定了会话：探测在执行 ⇒ skip；探测不可得 ⇒ skip（不猜）；否则**重投**
 *      （进程在「登记台账 → 建会话 / 发 prompt」之间中断时，重投正是续完那次派发的路径）；
 *    · `open` 且未绑会话 ⇒ 重投（崩溃恢复：续建会话并绑定）。
 * 2. 没有自己的 run 行时看义务表：自己的义务在表上 ⇒ skip（重放通道拥有执行）；
 *    同键但**别的**请求的义务 ⇒ 终局 coalesced（并入那次执行，与 X2.2 源头修同语义）。
 * 3. 都没有 ⇒ 重投（transient 失败 / 桥不可用留下的 pending 就是这一格）。
 */
export function decideUnsettledReceiptRedispatch(input: {
  receipt: Pick<CommentDispatchReceiptRecord, "dispatchKey" | "workItemId" | "targetAgentId">;
  /**
   * 本 workspace 的**全量** run 行（`listSquadRuns` 口径，含终态）：只读 runId/status/sessionId
   * 三列。为什么不用活跃快照：非活跃行（queued / 终态）同样是「该身份已有 run」的证据，
   * 拿掉它们会把「已完成/已排队」的请求判成可重投（重复执行）。
   */
  runHistory: ReadonlyArray<{ runId: string; status: string; sessionId: string | null }>;
  /** 此刻确证在执行中的会话 id（host 强探测结论；探测不可得的**不得**放进来自证清白）。 */
  executingSessionIds: ReadonlySet<string>;
  /** 探测能力是否可用（agent 服务是否注册）；不可用时有绑定会话的行一律跳过。 */
  sessionProbeAvailable: boolean;
  /** 本 workspace 全部义务行按 (workItem, agent) 的投影（值 = 义务 runId）。 */
  obligationsByPair: ReadonlyMap<string, string>;
}): UnsettledReceiptRedispatchDecision {
  const own = input.runHistory.find((run) => run.runId === input.receipt.dispatchKey);
  if (own !== undefined && own.status !== "open") {
    return { action: "skip", reason: "own_run_not_open" };
  }
  if (own !== undefined && own.sessionId !== null) {
    if (!input.sessionProbeAvailable) return { action: "skip", reason: "session_unprobeable" };
    if (input.executingSessionIds.has(own.sessionId)) {
      return { action: "skip", reason: "session_executing" };
    }
  }
  if (own === undefined) {
    const obligationRunId = input.obligationsByPair.get(
      commentReceiptObligationPairKey(input.receipt.workItemId, input.receipt.targetAgentId),
    );
    if (obligationRunId !== undefined) {
      return obligationRunId === input.receipt.dispatchKey
        ? { action: "skip", reason: "own_obligation_pending" }
        : { action: "settle_coalesced", coalescedInto: obligationRunId };
    }
  }
  return { action: "redispatch" };
}

/**
 * 评论义务重放的**事实校验**（三条恒等式）：义务行与 receipt 是同一条请求的两个面，
 * 对不上就**不派发**（响亮留痕）—— 凭义务行现造 run 会把评论派给一个不是 receipt 里那个目标的人，
 * 或把请求挂到别的工作项上，而两条路径都不报错。
 */
export type CommentObligationReplayFacts =
  | { ok: true; dispatchKey: string; targetAgentId: string; workItemId: string }
  | { ok: false; error: string };

export function commentObligationReplayFacts(input: {
  receipt: Pick<
    CommentDispatchReceiptRecord,
    "dispatchKey" | "workItemId" | "targetAgentId"
  > | null;
  obligation: Pick<SquadDeferredDispatchRecord, "runId" | "workItemId" | "agentId">;
}): CommentObligationReplayFacts {
  const { receipt, obligation } = input;
  if (receipt === null) {
    return {
      ok: false,
      error: `评论派发义务「${obligation.runId}」找不到 receipt（数据被清 / 取错 workspace）：不得凭义务行现造 run`,
    };
  }
  if (receipt.dispatchKey !== obligation.runId) {
    return {
      ok: false,
      error: `义务 id「${obligation.runId}」与 receipt 主键「${receipt.dispatchKey}」不一致：两者必须是同一条请求`,
    };
  }
  if (receipt.targetAgentId !== obligation.agentId) {
    return {
      ok: false,
      error:
        `评论派发目标不一致（receipt=${receipt.targetAgentId}、义务=${obligation.agentId}）：` +
        "派发目标必须取 receipt 里点名的那个人",
    };
  }
  if (receipt.workItemId !== obligation.workItemId) {
    return {
      ok: false,
      error:
        `评论派发工作项不一致（receipt=${receipt.workItemId}、义务=${obligation.workItemId}）：` +
        "请求不得挂到别的工作项上",
    };
  }
  return {
    ok: true,
    dispatchKey: receipt.dispatchKey,
    targetAgentId: receipt.targetAgentId,
    workItemId: receipt.workItemId,
  };
}

/* ------------------------------------------------------------------------------------------------
   取消 / 停会话（L2 半边，W2）：**唯一**一处把协议 stop 发给某个会话（host 全树 `stopGeneration(` 恰 1 处）。
   ------------------------------------------------------------------------------------------------ */

export type SquadRunSessionStopTarget = { path: string; identity: string };

/** L2 停会话的注入形态（实现只有 `createSquadRunSessionStopper` 一处）。 */
export type SquadSessionStop = (input: {
  target: SquadRunSessionStopTarget;
  runId: string;
  sessionId: string;
}) => Promise<boolean>;

/**
 * **唯一的** `IZCodeTaskService.stopGeneration` 调用点（R-2 的结论：服务面早有这个方法，
 * host 侧只缺一个调用点 —— 0 新传输层、0 新协议）。
 *
 * 为什么必须是**一处**：停会话有两个消费者（看门狗空闲档 / 用户取消的 L2），它们对「停谁」的判据
 * 必须一致（都是「这条 run 绑定的那个会话」）。各写一份的下场是「一处补了 workspaceIdentity、
 * 另一处没补」，在远端 workspace 上表现为「stop 发了但打到了别的会话」，且两端都不报错。
 *
 * 失败语义：**best-effort**（返回 `false` + 一条 warn）。理由（R-2 / 设计 §3.4）：L1 台账结算才是
 * 取消的必达半边；stop 只是让会话早点停，失败不该把「已取消」变成「取消失败」。看门狗空闲档同理 ——
 * stop 失败由宽限后的兜底结算接住。
 *
 * 无栅栏是**刻意的**（R-1/R-2）：带 `expectedForegroundExecutionId` 的定向 stop 需要中间层拿不到的
 * 栅栏值（UI 的 activeWorks 不进 services），而「停当前前台执行」正是这里要的语义。
 */
export function createSquadRunSessionStopper(params: {
  taskService: Pick<IZCodeTaskService, "stopGeneration"> | null;
  logWarn: (message: string, error?: unknown) => void;
}): SquadSessionStop {
  return async ({ target, runId, sessionId }) => {
    if (!params.taskService) {
      params.logWarn(
        `[squad] stop 会话失败：code task service 未注册 run=${runId} session=${sessionId}`,
      );
      return false;
    }
    try {
      await params.taskService.stopGeneration({
        taskId: sessionId,
        workspacePath: target.path,
        ...(target.identity ? { workspaceIdentity: target.identity } : {}),
      });
      return true;
    } catch (error) {
      // ACK 被拒 / 会话已终结都到这里：只 warn（L1 已生效；空闲档由宽限兜底）。
      params.logWarn(`[squad] stop 会话未成功 run=${runId} session=${sessionId}`, error);
      return false;
    }
  };
}

/** 取消的结论：`stop` 如实上报 L2 的结果（`skipped` = 这条 run 不需要停会话）。 */
export type SquadRunCancelOutcome = {
  status: "settled";
  stop: "skipped" | "stopped" | "failed";
};

/**
 * **per-run 取消的 host 半边**（设计 §3.4 的分层：L1 必达 + L2 best-effort）。
 *
 * 次序是契约：**先 L1 再 L2**。L1（服务面 `cancelSquadRun` ⇒ `failMemberRun`）把行移出活跃集，
 * 于是「会话随后跑到自然终态」这类迟到回写会被跨终态守卫（W2 / R-3 修复①）接住 —— 与
 * `offPeakTaskService` 既有的「先落终态再停 loop」同一条理由。反过来（先 stop 再结算）会留出
 * 「stop 到结算之间会话成功收口 ⇒ run 走成功入账」的窗口。
 *
 * L2 只在「读到的行是 open 且有绑定会话」时发起：已 `discarded`（重复取消）不重复 stop、
 * 已 `produced` / `merged` 的行由 L1 响亮拒绝（保护已产出的活）时也不会去停会话 —— 用户要的是
 * 「别再等它」，不是「把已经做出来的东西停掉」。
 *
 * **入口留 UI 轮（Q2 裁定）**：今日没有 UI/工具触发通路，故本函数在 host 里**没有调用点**，
 * 由接缝用例直接驱动。接线时（UI 轮）只需：取到 target + runId，调本函数，把结论回给界面。
 */
export function createSquadRunCanceller(params: {
  /** 读该 run 的当时状态（服务面 `listSquadRuns` 口径：全量台账）。 */
  readRun: (
    target: SquadRunSessionStopTarget,
    runId: string,
  ) => Promise<{ status: string; sessionId: string | null } | null>;
  /** L1：服务面 `cancelSquadRun`（queued ⇒ 丢弃 / open ⇒ failMemberRun(user_cancel) / 其余响亮抛）。 */
  cancelRun: (
    target: SquadRunSessionStopTarget,
    input: { runId: string; reason?: string },
  ) => Promise<void>;
  stopSession: SquadSessionStop;
  logInfo: (message: string) => void;
  logWarn: (message: string, error?: unknown) => void;
}): (
  target: SquadRunSessionStopTarget,
  input: { runId: string; reason?: string },
) => Promise<SquadRunCancelOutcome> {
  return async (target, input) => {
    /* 读一次当时状态（L2 要用 sessionId；「要不要 stop」也按读到的状态定 —— 不猜）。 */
    const run = await params.readRun(target, input.runId);
    const sessionId = run?.status === "open" ? run.sessionId : null;

    // L1：必达半边（失败会响亮抛给调用方 —— 取消没生效不能装成功）。
    await params.cancelRun(target, {
      runId: input.runId,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    if (sessionId === null) {
      params.logInfo(
        `[squad] 取消 run=${input.runId}：L1 已结算；该行无需停会话（无绑定会话 / 已收口）`,
      );
      return { status: "settled", stop: "skipped" };
    }
    // L2：best-effort（失败只如实上报，不回滚 L1）。
    const stopped = await params.stopSession({ target, runId: input.runId, sessionId });
    params.logInfo(
      `[squad] 取消 run=${input.runId}：L1 已结算；L2 stop session=${sessionId} = ${stopped ? "已发出" : "未成功"}`,
    );
    return { status: "settled", stop: stopped ? "stopped" : "failed" };
  };
}
