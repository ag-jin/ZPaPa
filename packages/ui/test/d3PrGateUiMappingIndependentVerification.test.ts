import assert from "node:assert/strict";
import test from "node:test";
import { WORK_ITEM_ACTIVITY_KINDS, type PullRequestState } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { INBOX_KIND_MESSAGE_IDS } from "../src/squad/inboxViewModel.js";
import { WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS } from "../src/squad/workItemCollaborationViewModel.js";
import {
  PULL_REQUEST_AWAITING_MERGE_MESSAGE_ID,
  PULL_REQUEST_GATE_TOKEN_MISSING_MESSAGE_ID,
  pullRequestGateNoticeMessageId,
} from "../src/squad/workItemPullRequestsViewModel.js";

/* #8 D3 **UI 映射面**的独立核对（任务 6 的「映射/键」）：
   · 第 21 枚 pr_merged 在 Activity 文案映射里、映射键集与**服务面闭集**同一份（区间不漂移）；
   · Inbox 的 pr_gate_degraded 文案键（手写表核对）；
   · 两语（zh-CN / en-US）确实带上了 D3 新增的每一句（漏译不静默）；
   · PR 区「pr-gate 状态提示」两档判据的四象限矩阵（含优先级）。 */

/** D3 新增的全部文案键（手写；漏一句即红）。 */
const D3_MESSAGE_IDS = [
  "settings.experiments.githubIntegration.mergeMode.label",
  "settings.experiments.githubIntegration.mergeMode.description",
  "settings.experiments.githubIntegration.mergeMode.local",
  "settings.experiments.githubIntegration.mergeMode.prGate",
  "settings.experiments.githubIntegration.mergeMode.degrade",
  "squad.inbox.kind.pr_gate_degraded",
  "squad.workItemDetail.pullRequests.gate.awaitingMerge",
  "squad.workItemDetail.pullRequests.gate.tokenMissing",
  "squad.workItemDetail.activity.kind.pr_merged",
];

test("独立复验｜Activity 文案映射：键集 = 服务面闭集（恰 21），pr_merged 的键与其余各枚齐备", () => {
  assert.deepEqual(
    Object.keys(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS).sort(),
    [...WORK_ITEM_ACTIVITY_KINDS].sort(),
    "UI 映射必须与服务面同一份闭集（硬编码枚数会在闭集增删时静默漂移）",
  );
  assert.equal(Object.keys(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS).length, 21);
  assert.equal(
    WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS["pr_merged"],
    "squad.workItemDetail.activity.kind.pr_merged",
    "第 21 枚的映射键（独立核）",
  );
});

test("独立复验｜Inbox 文案映射：六枚（手写表），pr_gate_degraded 的键独立核", () => {
  const handWritten = [
    "merge_conflict",
    "member_failed",
    "run_orphaned",
    "dispatch_skipped",
    "run_stalled",
    "pr_gate_degraded",
  ];
  assert.deepEqual(Object.keys(INBOX_KIND_MESSAGE_IDS).sort(), [...handWritten].sort());
  assert.equal(INBOX_KIND_MESSAGE_IDS["pr_gate_degraded"], "squad.inbox.kind.pr_gate_degraded");
});

test("独立复验｜两语齐备：D3 的每一句（含映射值）在 zh-CN 与 en-US 都存在且非空", () => {
  const referenced = [
    ...D3_MESSAGE_IDS,
    WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS["pr_merged"],
    INBOX_KIND_MESSAGE_IDS["pr_gate_degraded"],
    PULL_REQUEST_GATE_TOKEN_MISSING_MESSAGE_ID,
    PULL_REQUEST_AWAITING_MERGE_MESSAGE_ID,
  ];
  for (const id of referenced) {
    for (const [locale, table] of [
      ["zh-CN", zhCN],
      ["en-US", enUS],
    ] as const) {
      const text = table[id];
      assert.equal(typeof text, "string", `${locale} 缺文案：${id}`);
      assert.ok(text !== undefined && text.trim() !== "", `${locale} 文案为空：${id}`);
    }
  }
});

test("独立复验｜PR 区状态提示四象限：pr-gate 缺 token 优先，等验收且有未合并 PR 提示，其余不渲染", () => {
  const call = (input: {
    status: string;
    mode: "local" | "pr-gate";
    available: boolean;
    states: Array<PullRequestState | null>;
  }) =>
    pullRequestGateNoticeMessageId({
      workItemStatus: input.status,
      mergeMode: input.mode,
      providerAvailable: input.available,
      pullRequests: input.states.map((state) => ({ state })),
    });

  // ① pr-gate + 没配 token ⇒ 降级说明（优先级最高：连「等合并」都提示不到点子上）。
  assert.equal(
    call({ status: "in_review", mode: "pr-gate", available: false, states: ["open"] }),
    PULL_REQUEST_GATE_TOKEN_MISSING_MESSAGE_ID,
  );
  assert.equal(
    call({ status: "todo", mode: "pr-gate", available: false, states: [] }),
    PULL_REQUEST_GATE_TOKEN_MISSING_MESSAGE_ID,
  );
  // ② 等验收 + 有未合并 PR（open/draft）⇒ 等待说明（与模式无关：local 手工挂的 PR 同样驱动）。
  for (const mode of ["local", "pr-gate"] as const) {
    assert.equal(
      call({ status: "in_review", mode, available: true, states: ["open"] }),
      PULL_REQUEST_AWAITING_MERGE_MESSAGE_ID,
    );
    assert.equal(
      call({ status: "in_review", mode, available: true, states: [null, "draft"] }),
      PULL_REQUEST_AWAITING_MERGE_MESSAGE_ID,
      "null（未拉取）不算未合并；draft 算",
    );
  }
  // ③ 其余一律不渲染容器。
  assert.equal(
    call({ status: "in_review", mode: "local", available: true, states: ["merged"] }),
    null,
  );
  assert.equal(call({ status: "todo", mode: "local", available: true, states: ["open"] }), null);
  assert.equal(call({ status: "done", mode: "pr-gate", available: true, states: ["open"] }), null);
  assert.equal(call({ status: "in_review", mode: "pr-gate", available: true, states: [] }), null);
});
