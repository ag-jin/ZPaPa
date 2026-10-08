import assert from "node:assert/strict";
import test from "node:test";
import { PULL_REQUEST_STATES, type PullRequestRecord } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  EMPTY_PULL_REQUEST_LINK_DRAFT,
  PULL_REQUEST_STATE_MESSAGE_IDS,
  PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID,
  pullRequestLinkDraftProblemId,
  pullRequestGateNoticeMessageId,
  pullRequestRefreshSummary,
  pullRequestRowFacts,
} from "../src/squad/workItemPullRequestsViewModel.js";

/* #8 D2：详情页 **PR 区**的纯逻辑（状态徽标映射 / 行事实 / 登记表单判据 / 刷新结果摘要）。

   与交付物区同一条分工：组件不做判断，全部判据在纯函数里（可独立测、可独立复验）。
   状态闭集用**服务面导出的同一个** `PULL_REQUEST_STATES`（不硬编码四个字符串：
   闭集增删时硬编码会在界面上静默漂移 —— 同 Activity kind 映射的既有手法）。 */

function record(over: Partial<PullRequestRecord> = {}): PullRequestRecord {
  return {
    id: "pr-wi-1-acme-widget-7",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    repoOwner: "acme",
    repoName: "widget",
    prNumber: 7,
    title: "acme/widget#7",
    htmlUrl: "https://github.com/acme/widget/pull/7",
    branch: null,
    state: null,
    mergedAt: null,
    apiMergeable: null,
    apiMergeStateStatus: null,
    snapshotHeadSha: "",
    snapshotFetchedAt: null,
    linkedBy: { kind: "human", id: "u-1" },
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("呈现｜状态闭集映射穷尽（对服务面导出的同一份闭集）+ 未拉取单独一档，双语齐备", () => {
  assert.deepEqual(
    Object.keys(PULL_REQUEST_STATE_MESSAGE_IDS).sort(),
    [...PULL_REQUEST_STATES].sort(),
    "界面映射必须与服务面闭集逐值对应（硬编码会静默漂移）",
  );
  for (const messageId of [
    ...Object.values(PULL_REQUEST_STATE_MESSAGE_IDS),
    PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID,
  ]) {
    assert.ok(messageId in zhCN, `zh-CN 缺键 ${messageId}`);
    assert.ok(messageId in enUS, `en-US 缺键 ${messageId}`);
  }
});

test("呈现｜行事实：状态 → 文案键；分支/短 sha/快照时刻读自行，缺则 null（不猜）", () => {
  const fetched = pullRequestRowFacts(
    record({
      state: "open",
      branch: "feat/widget",
      snapshotHeadSha: "0123456789abcdef",
      snapshotFetchedAt: 1735787045000,
    }),
    "zh-CN",
  );
  assert.equal(fetched.stateMessageId, "squad.workItemDetail.pullRequests.state.open");
  assert.equal(fetched.branch, "feat/widget");
  assert.equal(fetched.headShaShort, "0123456", "短 sha 取前 7 位");
  assert.equal(fetched.url, "https://github.com/acme/widget/pull/7");
  assert.ok(fetched.snapshotAt !== null && fetched.snapshotAt.length > 0, "快照时刻要有可见文案");
  assert.equal(fetched.neverFetched, false);

  const never = pullRequestRowFacts(record(), "zh-CN");
  assert.equal(never.stateMessageId, PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID, "从未拉取 ⇒ 单独一档");
  assert.equal(never.branch, null);
  assert.equal(never.headShaShort, null, "空 pin 不得显示成一个空 sha");
  assert.equal(never.snapshotAt, null);
  assert.equal(never.neverFetched, true);
});

test("呈现｜登记表单判据：空 URL / 非 GitHub PR 地址各有定位（判据 = 服务面同一个归一化函数）", () => {
  assert.equal(
    pullRequestLinkDraftProblemId({ ...EMPTY_PULL_REQUEST_LINK_DRAFT, url: "  " }),
    "squad.workItemDetail.pullRequests.form.urlRequired",
  );
  for (const url of [
    "https://gitlab.com/acme/widget/merge_requests/7",
    "https://github.com/acme/widget/issues/7",
    "not a url",
    "https://github.com/acme/widget/pull/0",
  ]) {
    assert.equal(
      pullRequestLinkDraftProblemId({ ...EMPTY_PULL_REQUEST_LINK_DRAFT, url }),
      "squad.workItemDetail.pullRequests.form.urlInvalid",
      `形态不对的地址必须拦住：${url}`,
    );
  }
  assert.equal(
    pullRequestLinkDraftProblemId({
      url: "https://github.com/acme/widget/pulls/7/files",
      title: "",
    }),
    null,
    "标题可省（省略时服务面派生），URL 合法即可提交",
  );
});

test("呈现｜刷新结果摘要：四类结局各自计数，失败原因原样带出（不吞）", () => {
  const summary = pullRequestRefreshSummary({
    workItemId: "wi-1",
    providerAvailable: true,
    providerUnavailableReason: null,
    items: [
      {
        pullRequestId: "a",
        repoOwner: "acme",
        repoName: "widget",
        prNumber: 1,
        htmlUrl: "https://github.com/acme/widget/pull/1",
        outcome: "updated",
        reason: null,
        state: "open",
        snapshotFetchedAt: 2,
      },
      {
        pullRequestId: "b",
        repoOwner: "acme",
        repoName: "widget",
        prNumber: 2,
        htmlUrl: "https://github.com/acme/widget/pull/2",
        outcome: "discarded_stale",
        reason: "本次响应基于 head 1234567，而库里已被更新的快照取代。",
        state: "merged",
        snapshotFetchedAt: 3,
      },
      {
        pullRequestId: "c",
        repoOwner: "acme",
        repoName: "widget",
        prNumber: 3,
        htmlUrl: "https://github.com/acme/widget/pull/3",
        outcome: "failed",
        reason: "GitHub 返回 401（acme/widget#3）：访问令牌无效或已过期。",
        state: null,
        snapshotFetchedAt: null,
      },
      {
        pullRequestId: "d",
        repoOwner: "acme",
        repoName: "widget",
        prNumber: 4,
        htmlUrl: "https://github.com/acme/widget/pull/4",
        outcome: "unavailable",
        reason: "未配置 GitHub 访问令牌（PAT）。",
        state: null,
        snapshotFetchedAt: null,
      },
    ],
    mergedPullRequests: [],
  });
  assert.equal(summary.updated, 1);
  assert.equal(summary.discarded, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.unavailable, 1);
  assert.deepEqual(summary.failureReasons, [
    "GitHub 返回 401（acme/widget#3）：访问令牌无效或已过期。",
  ]);
  assert.equal(summary.discardReasons.length, 1, "陈旧拒写单列一档（不是失败，但必须可见）");
});

/* ---------- #8 D3：pr-gate 状态提示（等待 PR merge 的横幅 / 降级说明） ---------- */

test("D3 提示｜pr-gate + 等验收 + 有未合并的 PR ⇒ 等 merge 横幅；已合并/已关闭/非 in_review 都不提示", () => {
  const base = { workItemStatus: "in_review", mergeMode: "pr-gate" as const, providerAvailable: true };
  assert.equal(
    pullRequestGateNoticeMessageId({ ...base, pullRequests: [record({ state: "open" })] }),
    "squad.workItemDetail.pullRequests.gate.awaitingMerge",
  );
  assert.equal(
    pullRequestGateNoticeMessageId({ ...base, pullRequests: [record({ state: "draft" })] }),
    "squad.workItemDetail.pullRequests.gate.awaitingMerge",
    "草稿 PR 也是「还没合并」（draft 档与 open 同为未合并）",
  );
  for (const state of ["merged", "closed", null] as const) {
    assert.equal(
      pullRequestGateNoticeMessageId({ ...base, pullRequests: [record({ state })] }),
      null,
      `${String(state)} 不是「等合并」`,
    );
  }
  assert.equal(pullRequestGateNoticeMessageId({ ...base, pullRequests: [] }), null, "没有 PR 就没有等待");
  assert.equal(
    pullRequestGateNoticeMessageId({
      ...base,
      workItemStatus: "in_progress",
      pullRequests: [record({ state: "open" })],
    }),
    null,
    "只有等验收（in_review）的工作项才由 PR merge 驱动终态",
  );
  // 终态驱动与模式无关（local 模式下手工挂的 PR 同样会驱动终态）——提示照给。
  assert.equal(
    pullRequestGateNoticeMessageId({
      workItemStatus: "in_review",
      mergeMode: "local",
      providerAvailable: true,
      pullRequests: [record({ state: "open" })],
    }),
    "squad.workItemDetail.pullRequests.gate.awaitingMerge",
  );
});

test("D3 提示｜pr-gate 但没配 token ⇒ 降级说明优先于等待横幅；local 模式没 token 不提示（离线缺省是正常形态）", () => {
  assert.equal(
    pullRequestGateNoticeMessageId({
      workItemStatus: "in_review",
      mergeMode: "pr-gate",
      providerAvailable: false,
      pullRequests: [record({ state: "open" })],
    }),
    "squad.workItemDetail.pullRequests.gate.tokenMissing",
    "pr-gate 的前置不满足 ⇒ 必须说清「收尾会降级为本地合并」（否则用户以为 PR 会开出来）",
  );
  assert.equal(
    pullRequestGateNoticeMessageId({
      workItemStatus: "in_review",
      mergeMode: "local",
      providerAvailable: false,
      pullRequests: [record({ state: "open" })],
    }),
    "squad.workItemDetail.pullRequests.gate.awaitingMerge",
    "local 模式没 token：不提示降级（本就该走本地），但「等待合并」这条事实照给",
  );
  assert.equal(
    pullRequestGateNoticeMessageId({
      workItemStatus: "todo",
      mergeMode: "local",
      providerAvailable: false,
      pullRequests: [],
    }),
    null,
  );
});
