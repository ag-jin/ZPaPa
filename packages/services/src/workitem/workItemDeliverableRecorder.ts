import { randomUUID } from "node:crypto";
import type { GitRunner } from "../worktree/gitRunner.js";
import {
  SYSTEM_ACTIVITY_ACTOR,
  type WorkItemActivityProjector,
} from "./workItemActivityProjector.js";
import type {
  RegisterDeliverableInput,
  WorkItemDeliverableRecord,
  WorkItemDeliverableRepo,
} from "./workItemDeliverableRepo.js";
import type { AuthorRef } from "./workItemCommentRepo.js";
import type { SquadRunRecord } from "./squadRunRepo.js";
import {
  computeBatchDiffDeliverableDedupKey,
  computeRunDiffDeliverableDedupKey,
  createDeliverableCapture,
  deliverableIdForDedupKey,
  type DiffCaptureResult,
} from "./workItemDeliverableCapture.js";

/* #7 交付物（D1b）的**登记面**：把 D1a 的两半（git 侧捕获函数 + 存储面 repo）与第 20 枚回声
   组装成**一个**深模块，供三类调用点共用（设计 §3.1 的 `runDeliverableCapture` 的落点）：

   · run 级自动（`squadRunLifecycle` 的 approved 臂：合并成功后、队员分支被删之前）；
   · 批级自动（`squadOrchestrator` 的 finalize 落地臂：finalize 前后 target 的 sha 差）；
   · 手动（服务面 `registerWorkItemDeliverableLink`：人工贴一条外部链接）。

   删掉它会发生什么（深度判据）：diff 生成、id/键派生、正文落盘、表登记、回声五件事会在
   N 个调用点各长一份 —— 而它们的幂等键与 actor 归因**必须逐字一致**，分叉的表现是
   「同一次合并产生两条交付物」或「人工登记被记成系统登记」，都不报错。

   三条纪律（与投影模块同向）：
   ① **自动路径失败不抛不阻断**（设计 §8）：调用点都在「已经成功」之后（合并已落地 / 整批已合回），
      留痕失败（git 报错、磁盘满、库写失败）不得把已落地的事实翻转成失败 —— 一律 logWarn 留痕；
   ② **手动路径响亮**：人贴链接时静默失败等于「以为记下了」，故 registerLink 的失败原样抛出；
   ③ **键与 id 同源**（D1a 冻结的键函数 + `deliverableIdForDedupKey` 机械替换），本模块不拼第二份形状。

   手动登记**不做幂等**（设计 §3.2）：人贴链接是意图行为，同 URL 重复贴应由 UI 确认，
   而不是被键约束静默吞掉 —— 故 id 每登记一次新生成一个（`newId` 注入面就是为了这一格可测）。 */

/** 自动捕获的**标题**（呈现用；形状固定：`<来源> diff（<revision>）`）。 */
function runDiffTitle(branch: string): string {
  return `队员 run 产出 diff（${branch}）`;
}
function batchDiffTitle(target: string): string {
  return `整批合回 diff（${target}）`;
}

/**
 * 手动 link 行的 dedupKey：**不是**幂等语义（手动登记每次一条新行），只是
 * `UNIQUE(workspace_key, dedup_key)` 这个存储不变式要求的唯一载体 —— 由本次新生成的 id 派生，
 * 故两条不同的链接（哪怕 URL 相同）各占一行。
 */
export function computeManualLinkDeliverableDedupKey(id: string): string {
  return `deliverable:${id}:link`;
}

export interface WorkItemDeliverableRecorder {
  /**
   * run 级自动捕获（调用点：`reviewMemberRun` approved 臂 —— 合并成功之后、`settleStatus` 之前）。
   * **record 级闸**：`branch === null` 的行（队长 run）没有可捕获的分支，静默跳过 —— 不猜、
   * 不为它造一条空 diff。失败（git / 落盘 / 登记）只 warn，不上抛。
   */
  recordRunDiff(input: { record: SquadRunRecord; base: string }): Promise<void>;
  /**
   * 批级自动捕获（调用点：`advanceAfterChildrenDone` 的 finalize 落地之后）。`baseSha` 是
   * **finalize 之前**读到的 target sha：集成分支与队员分支此刻都已删/待删，按分支名捕获在这一步
   * 已经不可能（设计 §3.3）。失败只 warn，不上抛。
   */
  recordBatchDiff(input: {
    parentWorkItemId: string;
    target: string;
    baseSha: string;
  }): Promise<void>;
  /**
   * 手动登记一条 link 交付物（服务面唯一入口）。`actor` = 操作者（注入身份，非系统）：
   * 时间线回声的 actor 因此可分辨「谁登记的」。标题空白 ⇒ 响亮抛（一条没有标题的交付物
   * 在清单里查不出是什么）；URL 的空白闸在存储面（repo）。
   */
  registerLink(input: {
    workItemId: string;
    title: string;
    url: string;
    note?: string;
    actor: AuthorRef;
  }): WorkItemDeliverableRecord;
}

export function createWorkItemDeliverableRecorder(deps: {
  /** 捕获模块的 git 侧（设计 §3.1）：由组合根注入 runner 与仓库根，本模块不自建第二份 runner。 */
  git: GitRunner;
  repo: WorkItemDeliverableRepo;
  /** 本 runtime 绑定的 workspace（`workspace_key` 与正文根都由它派生）。 */
  workspace: { key: string; path: string };
  /** 回声面（可选加法，同生命周期/组合根先例）：缺省 = 不投影，事实仍照落。 */
  projector?: WorkItemActivityProjector;
  now?: () => number;
  /** 手动登记的 id 源（缺省 `randomUUID`）：注入面存在的唯一理由是让「每次新 id」这一格可测。 */
  newId?: () => string;
  logWarn?: (message: string, error?: unknown) => void;
}): WorkItemDeliverableRecorder {
  const { repo } = deps;
  const capture = createDeliverableCapture({ git: deps.git, repoRoot: deps.workspace.path });
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => randomUUID());
  const logWarn = deps.logWarn ?? ((message: string) => console.warn(message));

  /** 自动路径的**唯一**落库+回声：成功返回，失败只 warn（见文件头纪律①）。 */
  function record(
    input: { dedupKey: string; title: string; workItemId: string; runId?: string },
    captured: DiffCaptureResult,
    metaOf: () => Record<string, unknown>,
  ): void {
    if (!captured.ok) {
      /* 捕获失败（git 报错 / 参数形态被拒）：留一条 warn 就够 —— 合并与收尾照常，
         复盘时能从这条看到「这次为什么没有交付物」。 */
      logWarn(
        `[squad] 交付物捕获失败（工作项=${input.workItemId}, dedupKey=${input.dedupKey}）：` +
          `${captured.reason}。已落地的合并/收尾不因此改变，但这一次的产出**没有**留痕。`,
      );
      return;
    }
    const record = repo.register({
      id: deliverableIdForDedupKey(input.dedupKey),
      workspaceKey: deps.workspace.key,
      workspacePath: deps.workspace.path,
      workItemId: input.workItemId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      kind: "diff",
      title: input.title,
      meta: { ...metaOf(), statSummary: captured.stat, commitCount: captured.commitCount },
      content: captured.diff,
      actor: SYSTEM_ACTIVITY_ACTOR,
      dedupKey: input.dedupKey,
      createdAt: now(),
    });
    echoRegistered(record);
  }

  /** 第 20 枚回声（键形状与 payload 组装全在投影模块；本模块只交「已经落库的那一行」）。 */
  function echoRegistered(record: WorkItemDeliverableRecord): void {
    deps.projector?.deliverableRegistered({
      workspaceKey: record.workspaceKey,
      workspacePath: record.workspacePath,
      workItemId: record.workItemId,
      deliverableId: record.id,
      kind: record.kind,
      title: record.title,
      runId: record.runId,
      actor: record.actor,
    });
  }

  return {
    async recordRunDiff({ record: runRecord, base }) {
      /* **record 级闸**：队长 run（`branch === null`）没有分支可捕 —— 它直接在目标工作区执行，
         产出不在任何分支上。这里静默跳过（不是失败）：调用点不必各自再判一次同一件事。 */
      if (runRecord.branch === null) return;
      const member = runRecord.branch;
      try {
        const captured = await capture.captureRunDiff({ base, member });
        record(
          {
            dedupKey: computeRunDiffDeliverableDedupKey(runRecord.runId),
            title: runDiffTitle(member),
            workItemId: runRecord.workItemId,
            runId: runRecord.runId,
          },
          captured,
          () => ({ branch: member, base, agentId: runRecord.agentId }),
        );
      } catch (error) {
        logWarn(
          `[squad] run 级交付物登记失败（runId=${runRecord.runId}）：合并不因此回滚，` +
            "但这一次的产出没有留痕（见 workItemDeliverableRepo 的正文根与库约束）。",
          error,
        );
      }
    },

    async recordBatchDiff({ parentWorkItemId, target, baseSha }) {
      try {
        const captured = await capture.captureBatchDiff({ target, baseSha });
        record(
          {
            dedupKey: computeBatchDiffDeliverableDedupKey(parentWorkItemId),
            title: batchDiffTitle(target),
            workItemId: parentWorkItemId,
          },
          captured,
          () => ({ batchLevel: true, target, baseSha }),
        );
      } catch (error) {
        logWarn(
          `[squad] 批级交付物登记失败（父项=${parentWorkItemId}）：整批合回不因此回滚，` +
            "但这一批的产出没有留痕。",
          error,
        );
      }
    },

    registerLink({ workItemId, title, url, note, actor }) {
      /* 标题空白 ⇒ 抛：清单里一条查不出是什么的行比没有这条更糟（URL 的空白闸在 repo）。 */
      const trimmedTitle = title.trim();
      if (trimmedTitle === "") {
        throw new Error(
          "手动登记的交付物必须有标题（title）：清单上一条查不出是什么的链接没有任何可复查性。",
        );
      }
      const id = `deliverable-link-${newId()}`;
      // 手动登记**不做幂等**（每条新 id / 新键）：人贴链接是意图行为，重复由 UI 确认而不是被静默吞掉。
      const input: RegisterDeliverableInput = {
        id,
        workspaceKey: deps.workspace.key,
        workspacePath: deps.workspace.path,
        workItemId,
        kind: "link",
        title: trimmedTitle,
        url,
        ...(note !== undefined && note.trim() !== "" ? { meta: { note: note.trim() } } : {}),
        actor,
        dedupKey: computeManualLinkDeliverableDedupKey(id),
        createdAt: now(),
      };
      const record = repo.register(input);
      echoRegistered(record);
      return record;
    },
  };
}
