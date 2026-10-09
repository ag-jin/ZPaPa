import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  PullRequestRecord,
  PullRequestSyncReport,
  WorkItemDeliverableRecord,
} from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { GitHubIntegrationSettingsRow } from "../src/settings/GitHubIntegrationSettingsRow.js";
import { WorkItemDeliverablesSection } from "../src/squad/WorkItemDeliverablesSection.js";
import { WorkItemPullRequestsSection } from "../src/squad/WorkItemPullRequestsSection.js";
import { writeDisabledReason } from "../src/squad/workItemCollaborationViewModel.js";

/* #8 D2 **独立复验**（test-verifier）：详请页 PR 区的**真渲染**（离线缺省说明行 vs 已登记照常）、
   设置区 secret 行的**注入式复跑**（抽二：把两种真凭据形态灌进渲染路径，HTML 里不许出现）、
   以及 D1 交付物区与 D2 PR 区**同树渲染**的回归（D2 接入不得打坏 D1 的呈现）。

   渲染设施与既有先例一致：`renderToStaticMarkup` + 真 `ZCodeIntlProvider`（不是 mock locale）。 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

const NULL_PROVIDER = {
  available: false,
  reason: "未配置 GitHub 访问令牌（PAT）：PR 快照不可用，PR 区只显示手动登记的链接。",
};

function prRecord(over: Partial<PullRequestRecord> = {}): PullRequestRecord {
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

function deliverableRecord(
  over: Partial<WorkItemDeliverableRecord> = {},
): WorkItemDeliverableRecord {
  return {
    id: "deliverable-d2-indep",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    runId: null,
    kind: "diff",
    title: "D1 交付物标题",
    meta: { branch: "squad/member/wi-1/agent-a", base: "main", commitCount: 2, statSummary: "x" },
    contentRef: ".zcode/squad/deliverables/x.diff",
    contentSha: "sha",
    contentSize: 2048,
    actor: { kind: "system", id: "squad-runtime" },
    dedupKey: "deliverable:x:diff",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function emptyReport(): PullRequestSyncReport {
  return {
    workItemId: "wi-1",
    providerAvailable: false,
    providerUnavailableReason: NULL_PROVIDER.reason,
    items: [],
    mergedPullRequests: [],
  };
}

function renderTree(
  children: ReturnType<typeof createElement>,
  locale: "zh-CN" | "en-US" = "zh-CN",
) {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale, children }),
  );
}

function prSection(props: {
  pullRequests?: PullRequestRecord[];
  provider?: { available: boolean; reason: string | null };
  disabled?: string | null;
}) {
  return createElement(WorkItemPullRequestsSection, {
    pullRequests: props.pullRequests ?? [],
    provider: props.provider ?? NULL_PROVIDER,
    registerDisabledReasonMessageId: props.disabled ?? null,
    // #8 D3：PR 区多了一格「pr-gate 状态提示」（纯函数算好；本文件不测它 ⇒ null）。
    noticeMessageId: null,
    onLink: async () => {},
    onUnlink: async () => {},
    onRefresh: async () => emptyReport(),
  });
}

/* ---------------- ① 离线缺省：说明行不是错误，已登记照常 ---------------- */

test("真渲染｜未配 token + 已登记 PR：说明行在场、**无**错误红条、条目与登记入口照常（用户裁定）", () => {
  const html = renderTree(prSection({ pullRequests: [prRecord()] }));
  assert.ok(html.includes('data-testid="work-item-pull-requests"'));
  assert.ok(
    html.includes('data-testid="work-item-pull-requests-token-missing"'),
    "未配置 token 必须有说明行（配置状态，不是错误）",
  );
  assert.equal(
    html.includes('data-testid="work-item-pull-requests-refresh-failure"'),
    false,
    "离线缺省**不得**出现失败红条",
  );
  assert.equal(
    html.includes('data-testid="work-item-pull-request-link-failure"'),
    false,
    "离线缺省下登记表单若未展开，也不得有失败条",
  );
  assert.equal(html.includes('role="alert"'), false, "离线缺省不渲染任何 alert 角色元素");
  assert.equal(
    /class="[^"]*text-destructive/.test(html),
    false,
    "离线缺省不得用错误色文本（状态是「未配置」，不是「失败」）",
  );
  assert.ok(html.includes('data-testid="work-item-pull-request"'), "已登记的 PR 照常列出");
  assert.ok(html.includes("https://github.com/acme/widget/pull/7"), "外链原样");
  assert.ok(html.includes("未拉取"), "从未拉取单独一档（不显示成 open）");
  assert.ok(!html.includes(">已合并<"), "没拉取过不许显示终态");
});

test("真渲染｜配了 token + 有快照：说明行消失、快照事实呈现（双语各跑一次）", () => {
  const merged = prRecord({
    state: "merged",
    branch: "feat/widget",
    apiMergeStateStatus: "CLEAN",
    snapshotHeadSha: "0123456789abcdef",
    snapshotFetchedAt: 1735787045000,
    mergedAt: 1735787045000,
  });
  const expectedStateLabel = { "zh-CN": "已合并", "en-US": "Merged" } as const;
  const expectedNever = { "zh-CN": "从未拉取", "en-US": "Never fetched" } as const;
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderTree(
      prSection({ pullRequests: [merged], provider: { available: true, reason: null } }),
      locale,
    );
    assert.equal(
      html.includes('data-testid="work-item-pull-requests-token-missing"'),
      false,
      `${locale}：配了 token 就不显示说明行`,
    );
    assert.ok(html.includes("0123456"), `${locale}：短 sha 可见`);
    assert.ok(html.includes("CLEAN"), `${locale}：远端原值原样`);
    assert.ok(html.includes("feat/widget"), `${locale}：分支可见`);
    assert.ok(
      html.includes(expectedStateLabel[locale]),
      `${locale}：状态徽标走真 locale 文案（期望「${expectedStateLabel[locale]}」）`,
    );
    assert.equal(
      html.includes(expectedNever[locale]),
      false,
      `${locale}：有快照就不说「从未拉取」`,
    );
  }
  // 未拉取那条在两个 locale 下各说各的话（证明 render 真的换了 locale 资源）。
  const zhNever = renderTree(prSection({ pullRequests: [prRecord()] }), "zh-CN");
  const enNever = renderTree(prSection({ pullRequests: [prRecord()] }), "en-US");
  assert.ok(zhNever.includes(expectedNever["zh-CN"]));
  assert.ok(enNever.includes(expectedNever["en-US"]));
  assert.notEqual(zhNever, enNever, "两种 locale 的渲染结果必须不同（不是同一份资源）");
});

/* ---------------- ② SEC：注入式复跑，抽二（两种真凭据形态） ---------------- */

test("SEC 注入式复跑（抽二）｜把 ghp_/github_pat_ 两种真凭据灌进设置行渲染路径，HTML 零回显", () => {
  const secrets = [
    "ghp_IndependentVerifySecret_9f8e7d6c5b4a",
    "github_pat_11ABCDEFG0aBcDeFgHiJkL_7XyZqPoNmLk3RtUvWxYz",
  ];
  for (const secret of secrets) {
    // 走的正是容器那条路：设置里的 token 值只用于算布尔事实，不进渲染层。
    const html = renderTree(
      createElement(GitHubIntegrationSettingsRow, {
        tokenConfigured: secret.trim() !== "",
        saving: false,
        // #8 D3：模式行随之落在同一组件里（本用例只查凭据零回显 ⇒ 用缺省档）。
        mergeMode: "local",
        onSave: async () => {},
        onClear: async () => {},
        onSelectMergeMode: async () => {},
      }),
    );
    assert.equal(html.includes(secret), false, "整段 HTML 不得出现凭据明文");
    assert.equal(/ghp_[A-Za-z0-9]/.test(html), false, "形态级：任何 ghp_ 串都不得出现");
    assert.equal(
      /github_pat_[A-Za-z0-9]/.test(html),
      false,
      "形态级：任何 github_pat_ 串都不得出现",
    );
    const input = html.match(/<input[^>]*data-testid="github-integration-token-input"[^>]*>/)?.[0];
    assert.ok(input, "输入框必须渲染");
    assert.ok(input!.includes('type="password"'), "masks 输入");
    assert.ok(input!.includes('value=""'), "值恒为空串（不预填已保存的 token）");
    assert.ok(html.includes("已配置"), "只给布尔事实的状态行");
  }
});

test("SEC 结构守卫｜PR 区与设置行都拿不到 token 值；容器只传布尔事实（回显在结构上不可能）", () => {
  const strip = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const relative of [
    "squad/WorkItemPullRequestsSection.tsx",
    "squad/workItemPullRequestsViewModel.ts",
  ]) {
    const code = strip(readFileSync(resolve(SRC, relative), "utf8"));
    assert.equal(
      /githubPullRequestToken|useSettings\(|settingsService/.test(code),
      false,
      `${relative} 不得触碰 token 值（只经布尔事实与行数据）`,
    );
  }
  // 设置行：不读设置（值进不来）；props 解构里只有布尔事实 + 两个回调；草稿活在本地 state 里。
  const row = strip(
    readFileSync(resolve(SRC, "settings/GitHubIntegrationSettingsRow.tsx"), "utf8"),
  );
  assert.equal(row.includes("useSettings"), false, "呈现组件不读设置（token 值进不来）");
  assert.equal(row.includes("githubPullRequestToken"), false);
  const destructure = row.match(
    /export function GitHubIntegrationSettingsRow\(\{([\s\S]*?)\}: \{/,
  )?.[1];
  assert.ok(destructure);
  assert.equal(
    /(^|\s)token\s*[,:]/.test(destructure!),
    false,
    "props 里不得有名为 token 的**数据**字段（只许 tokenConfigured 布尔事实）",
  );
  assert.ok(destructure!.includes("tokenConfigured"));
  assert.match(row, /useState\(""\)/, "输入值恒以空串起步（本次草稿，绝不预填）");
  // 容器：token 只作为判据函数的实参出现，绝不作为属性值传下去。
  const section = strip(readFileSync(resolve(SRC, "settings/ExperimentsSection.tsx"), "utf8"));
  const callSite = section.match(/<GitHubIntegrationSettingsRow[\s\S]*?\/>/)?.[0];
  assert.ok(callSite, "找不到容器调用点");
  assert.equal(
    /=\{\s*settings\??\.githubPullRequestToken\s*\}/.test(callSite!),
    false,
    "不得把 token 值直接作为属性值传给渲染层（回显的入口形态）",
  );
  assert.ok(
    callSite!.includes("isGithubPullRequestTokenConfigured(settings?.githubPullRequestToken)"),
    "容器必须用 shared 的唯一判据把值折成布尔事实",
  );
});

/* ---------------- ③ D1 交付物区与 D2 PR 区同树渲染（回归） ---------------- */

test("回归｜D1 交付物区与 D2 PR 区同树渲染：两区都在，D1 的行事实与入口不被 PR 区打坏", () => {
  const html = renderTree(
    createElement(
      "div",
      null,
      createElement(WorkItemDeliverablesSection, {
        deliverables: [deliverableRecord()],
        registerDisabledReasonMessageId: null,
        onRegisterLink: async () => {},
        onLoadContent: async () => null,
      }),
      prSection({ pullRequests: [prRecord()] }),
    ),
  );
  assert.ok(html.includes('data-testid="work-item-deliverables"'), "D1 交付物区必须在");
  assert.ok(html.includes('data-testid="work-item-pull-requests"'), "D2 PR 区必须在");
  assert.ok(html.includes("D1 交付物标题"), "D1 的行事实照常渲染");
  assert.ok(html.includes("squad/member/wi-1/agent-a"), "D1 的分支事实照常渲染");
  assert.ok(
    html.includes('data-testid="work-item-deliverable-register-toggle"') ||
      html.includes("D1 交付物标题"),
    "D1 的入口/行不被 PR 区挤掉",
  );
  // 顺序：交付物在前、PR 在后（与详情页挂载次序一致）。
  assert.ok(
    html.indexOf('data-testid="work-item-deliverables"') <
      html.indexOf('data-testid="work-item-pull-requests"'),
    "同屏相邻且次序与详情页一致",
  );
  assert.equal(html.includes('data-testid="work-item-pull-requests-refresh-failure"'), false);
});

test("回归｜writeDisabledReason 四面（comment/decision/deliverable/pullRequest）优先级一致，PR 面文案双语齐备", () => {
  const surfaces = ["comment", "decision", "deliverable", "pullRequest"] as const;
  for (const surface of surfaces) {
    assert.equal(
      writeDisabledReason(surface, { archivedAt: 1 }, "读失败"),
      `squad.workItemDetail.${surface}.disabled.archived`,
      `${surface}：归档优先`,
    );
    assert.equal(
      writeDisabledReason(surface, {}, "读失败"),
      `squad.workItemDetail.${surface}.disabled.readFailed`,
      `${surface}：其次读失败`,
    );
    assert.equal(writeDisabledReason(surface, {}, null), null, `${surface}：可写`);
  }
  for (const surface of surfaces) {
    for (const messageId of [
      `squad.workItemDetail.${surface}.disabled.archived`,
      `squad.workItemDetail.${surface}.disabled.readFailed`,
    ]) {
      assert.ok(messageId in zhCN, `zh-CN 缺键 ${messageId}`);
      assert.ok(messageId in enUS, `en-US 缺键 ${messageId}`);
    }
  }
});

/* ---------------- ④ 文案与命名空间（D2 的 12 键 / 20 键） ----------------
 *
 * D3 重算（2026-10-08，与 experimentsSquadEntry.test.ts 同一纪律）：
 * · `settings.experiments.*` 12 → **17**（新增整批收尾模式 5 键：label/description/两档/degrade）；
 * · PR 区命名空间 20 → **22**（新增 gate.awaitingMerge 与 gate.tokenMissing）。
 * 两处都是**有意的增长**（pr-gate 的开关与「在等什么」的说明要能在界面上看见），
 * 故按同一纪律把确数重算并写死新集合 —— 不是放宽断言。 */

test("文案｜settings.experiments.* 恰 17 条（D2 的 GitHub 8 键 + D3 模式 5 键 + 既有 4 键）且两语键集逐字相等", () => {
  const keysOf = (locale: Record<string, string>, prefix: string) =>
    Object.keys(locale)
      .filter((key) => key.startsWith(prefix))
      .sort();
  const zh = keysOf(zhCN, "settings.experiments.");
  const en = keysOf(enUS, "settings.experiments.");
  assert.deepEqual(en, zh, "两语键集必须逐字相等");
  assert.deepEqual(zh, [
    "settings.experiments.githubIntegration.description",
    "settings.experiments.githubIntegration.label",
    "settings.experiments.githubIntegration.mergeMode.degrade",
    "settings.experiments.githubIntegration.mergeMode.description",
    "settings.experiments.githubIntegration.mergeMode.label",
    "settings.experiments.githubIntegration.mergeMode.local",
    "settings.experiments.githubIntegration.mergeMode.prGate",
    "settings.experiments.githubIntegration.saveFailed",
    "settings.experiments.githubIntegration.tokenClear",
    "settings.experiments.githubIntegration.tokenConfigured",
    "settings.experiments.githubIntegration.tokenNotConfigured",
    "settings.experiments.githubIntegration.tokenPlaceholder",
    "settings.experiments.githubIntegration.tokenSave",
    "settings.experiments.saveFailed",
    "settings.experiments.squadToggle.description",
    "settings.experiments.squadToggle.label",
    "settings.experiments.title",
  ]);
});

test("文案｜PR 区命名空间 22 键两语齐平（含状态五档、禁用两因与 D3 两档提示），且没有落到别的命名空间", () => {
  const keysOf = (locale: Record<string, string>, prefix: string) =>
    Object.keys(locale)
      .filter((key) => key.startsWith(prefix))
      .sort();
  const zh = keysOf(zhCN, "squad.workItemDetail.pullRequests.");
  const en = keysOf(enUS, "squad.workItemDetail.pullRequests.");
  assert.deepEqual(en, zh, "两语键集必须逐字相等");
  assert.equal(zh.length, 22, `PR 区键数：${zh.join(", ")}`);
  for (const state of ["open", "closed", "merged", "draft", "notFetched"]) {
    assert.ok(zh.includes(`squad.workItemDetail.pullRequests.state.${state}`), `状态档缺 ${state}`);
  }
  for (const surfaceKey of [
    "squad.workItemDetail.pullRequest.disabled.archived",
    "squad.workItemDetail.pullRequest.disabled.readFailed",
  ]) {
    assert.ok(surfaceKey in zhCN && surfaceKey in enUS, `禁用因缺 ${surfaceKey}`);
  }
});
