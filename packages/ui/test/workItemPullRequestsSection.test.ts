import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PullRequestRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkItemPullRequestsSection } from "../src/squad/WorkItemPullRequestsSection.js";
import {
  PULL_REQUEST_STATE_MESSAGE_IDS,
  PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID,
} from "../src/squad/workItemPullRequestsViewModel.js";

/* #8 D2：详情页**关联 PR 区**的真渲染（`renderToStaticMarkup` + 真 `ZCodeIntlProvider`，
   D1 复验确立的先例）。这里钉的是**离线缺省的完整呈现**（任务卡的核心体验）：
   · 没配 token ⇒ 说明行 + 照常列出已登记的 PR（**不是**错误红条）；
   · 已登记的 PR ⇒ 状态徽标（未拉取/开放/已合并）+ 外链 + 解除关联；
   · 归档/读取失败 ⇒ 入口禁用并给原因（不静默消失）。 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

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

const NO_PROVIDER = {
  available: false,
  reason: "未配置 GitHub 访问令牌（PAT）：PR 快照不可用，PR 区只显示手动登记的链接。",
};

function render(props: {
  pullRequests: PullRequestRecord[];
  provider?: { available: boolean; reason: string | null };
  registerDisabledReasonMessageId?: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemPullRequestsSection, {
        pullRequests: props.pullRequests,
        provider: props.provider ?? NO_PROVIDER,
        registerDisabledReasonMessageId: props.registerDisabledReasonMessageId ?? null,
        onLink: async () => {},
        onUnlink: async () => {},
        onRefresh: async () => ({
          workItemId: "wi-1",
          providerAvailable: false,
          providerUnavailableReason: NO_PROVIDER.reason,
          items: [],
          mergedPullRequests: [],
        }),
      }),
    }),
  );
}

function buttonTag(html: string, testId: string): string {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  assert.ok(tag, `找不到按钮 ${testId}：\n${html}`);
  return tag!;
}

test("PR-① 真渲染｜未配置 token：说明行出现、**没有**错误样式，登记入口照常可用", () => {
  const html = render({ pullRequests: [] });
  assert.ok(html.includes('data-testid="work-item-pull-requests"'), "PR 区必须渲染");
  assert.ok(html.includes('data-testid="work-item-pull-requests-token-missing"'), "说明行必现");
  assert.ok(html.includes("未配置 GitHub 访问令牌"), `说明行用真文案：\n${html}`);
  assert.ok(html.includes("还没有关联 PR"), "空态文案");
  assert.equal(
    html.includes('data-testid="work-item-pull-requests-refresh-failure"'),
    false,
    "离线缺省**不是**错误：不得出现失败红条",
  );
  assert.equal(
    buttonTag(html, "work-item-pull-request-link-toggle").includes("disabled="),
    false,
    "没配 token 也照常能手动登记链接（用户裁定）",
  );
  assert.equal(
    buttonTag(html, "work-item-pull-requests-refresh").includes("disabled="),
    false,
    "刷新按钮可用（点了会得到「未配置 token」的报告，不是错误）",
  );
});

test("PR-② 真渲染｜已登记但未拉取：状态徽标 = 未拉取、外链原样、解除关联在、无错误文案", () => {
  const html = render({ pullRequests: [record()] });
  assert.ok(html.includes('data-testid="work-item-pull-request"'));
  assert.ok(html.includes('data-testid="work-item-pull-request-state"'));
  assert.ok(html.includes("未拉取"), "从未拉取单独一档（不得显示成「开放」）");
  const anchor = html.match(/<a[^>]*data-testid="work-item-pull-request-link"[^>]*>/)?.[0];
  assert.ok(anchor, `必须渲染外链：\n${html}`);
  assert.ok(anchor!.includes('href="https://github.com/acme/widget/pull/7"'), "URL 原样进 href");
  assert.ok(
    anchor!.includes('target="_blank"') && anchor!.includes('rel="noreferrer"'),
    "外链安全属性",
  );
  assert.ok(html.includes('data-testid="work-item-pull-request-unlink"'), "解除关联在");
  assert.ok(html.includes("从未拉取"), "快照时刻显示「从未拉取」（不谎报时间）");
});

test("PR-③ 真渲染｜有快照：状态徽标 = 已合并、分支/短 sha/快照时刻可见（原生值原样）", () => {
  const html = render({
    pullRequests: [
      record({
        state: "merged",
        branch: "feat/widget",
        apiMergeStateStatus: "CLEAN",
        snapshotHeadSha: "0123456789abcdef",
        snapshotFetchedAt: 1735787045000,
      }),
    ],
    provider: { available: true, reason: null },
  });
  assert.ok(html.includes("已合并"), "状态徽标用真文案");
  assert.ok(html.includes("feat/widget"), "分支名");
  assert.ok(html.includes("0123456"), "短 sha（7 位）");
  assert.ok(html.includes("CLEAN"), "mergeable_state 原值（呈现用，不翻译）");
  assert.ok(html.includes("快照于"), "快照时刻");
  assert.equal(
    html.includes('data-testid="work-item-pull-requests-token-missing"'),
    false,
    "配了 token 就不显示说明行",
  );
});

test("PR-④ 真渲染｜归档/读取失败：登记与解除入口禁用并给原因（不静默消失）", () => {
  for (const [reasonId, text] of [
    ["squad.workItemDetail.pullRequest.disabled.archived", "工作项已归档"],
    ["squad.workItemDetail.pullRequest.disabled.readFailed", "读取活动失败"],
  ] as const) {
    const html = render({
      pullRequests: [record()],
      registerDisabledReasonMessageId: reasonId,
    });
    assert.ok(html.includes(text), `原因文案必现：${text}\n${html}`);
    assert.ok(
      buttonTag(html, "work-item-pull-request-link-toggle").includes("disabled="),
      "登记禁用",
    );
    assert.ok(buttonTag(html, "work-item-pull-request-unlink").includes("disabled="), "解除禁用");
    assert.ok(buttonTag(html, "work-item-pull-requests-refresh").includes("disabled="), "刷新禁用");
  }
});

test("呈现｜本区用到的文案键双语齐备（状态五档 + 标题/空态/说明/刷新/表单）", () => {
  const ids = [
    "squad.workItemDetail.pullRequests.title",
    "squad.workItemDetail.pullRequests.empty",
    "squad.workItemDetail.pullRequests.tokenMissing",
    "squad.workItemDetail.pullRequests.refresh",
    "squad.workItemDetail.pullRequests.refreshResult",
    "squad.workItemDetail.pullRequests.snapshot.at",
    "squad.workItemDetail.pullRequests.snapshot.never",
    "squad.workItemDetail.pullRequests.unlink",
    "squad.workItemDetail.pullRequests.form.open",
    "squad.workItemDetail.pullRequests.form.urlPlaceholder",
    "squad.workItemDetail.pullRequests.form.titlePlaceholder",
    "squad.workItemDetail.pullRequests.form.urlRequired",
    "squad.workItemDetail.pullRequests.form.urlInvalid",
    "squad.workItemDetail.pullRequests.form.submit",
    "squad.workItemDetail.pullRequests.form.cancel",
    "squad.workItemDetail.pullRequest.disabled.archived",
    "squad.workItemDetail.pullRequest.disabled.readFailed",
    ...Object.values(PULL_REQUEST_STATE_MESSAGE_IDS),
    PULL_REQUEST_STATE_UNKNOWN_MESSAGE_ID,
  ];
  for (const id of ids) {
    assert.ok(id in zhCN, `zh-CN 缺键 ${id}`);
    assert.ok(id in enUS, `en-US 缺键 ${id}`);
  }
});

test("守卫｜详情页把 PR 区**紧接**交付物区挂在同一屏，且三个回调都经页面唯一执行器", () => {
  const source = readFileSync(resolve(SRC, "squad/WorkItemDetailPage.tsx"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const deliverablesAt = code.indexOf("<WorkItemDeliverablesSection");
  const pullRequestsAt = code.indexOf("<WorkItemPullRequestsSection");
  assert.ok(deliverablesAt >= 0 && pullRequestsAt > deliverablesAt, "PR 区必须紧接交付物区之后");
  // 三个回调都转给 runCollaborationAction（页面唯一的服务调用执行器）；组件拿回调、不拿服务。
  for (const call of [
    "service.linkWorkItemPullRequest(currentTarget",
    "service.unlinkWorkItemPullRequest(currentTarget",
    "service.refreshWorkItemPullRequests(currentTarget",
  ]) {
    assert.ok(code.includes(call), `详情页必须有 ${call} 的调用点（经唯一执行器）`);
  }
  const section = readFileSync(resolve(SRC, "squad/WorkItemPullRequestsSection.tsx"), "utf8");
  assert.equal(
    /resolveWorkItemCollaborationService|useServices\(/.test(section),
    false,
    "PR 区组件不得自己取服务（服务调用只在详情页）",
  );
});
