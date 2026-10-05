import { SQUAD_DISPATCH_DISABLED_CODE } from "@zcode/services";
import type { RunClass } from "@zcode/services/node";

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
 * **只收队长行**：队员行的归宿是它自己的终态回调 + 启动回收器（它有树有枝，规则不同），
 * 在这里顺手收会绕开「产出必须活到合并」（§6.2 / S5）——那正是回收器按命名空间限域要保护的东西。
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
