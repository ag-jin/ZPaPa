import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkItemDeliverableRecord } from "@zcode/services";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { WorkItemDeliverablesSection } from "../src/squad/WorkItemDeliverablesSection.js";
import {
  buildWorkItemTimelineEntries,
  WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS,
  writeDisabledReason,
} from "../src/squad/workItemCollaborationViewModel.js";
import {
  DELIVERABLE_KIND_MESSAGE_IDS,
  deliverableFacts,
  deliverableLinkDraftProblemId,
} from "../src/squad/workItemDeliverablesViewModel.js";

/* #7 D1b **交付物区**的独立复验（与实现者那份 `workItemDeliverablesSection.test.ts` 分开）。

   关键差别：这里**真渲染**（`react-dom/server` 的 `renderToStaticMarkup` + 真 `ZCodeIntlProvider` + 真
   zh-CN 文案）——渲染层的行为不再只靠源码扫描间接推断。展开态（点「查看 diff」后的正文三态）需要
   交互，而 ui 包没有 DOM 环境，故那一格仍是**源码切片**断言（本报告如实计入覆盖缺口）。 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function renderSection(props: {
  deliverables: WorkItemDeliverableRecord[];
  registerDisabledReasonMessageId: string | null;
}): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN" as const,
      children: createElement(WorkItemDeliverablesSection, {
        deliverables: props.deliverables,
        registerDisabledReasonMessageId: props.registerDisabledReasonMessageId,
        onRegisterLink: async () => {},
        onLoadContent: async () => null,
      }),
    }),
  );
}

/** 按钮的**开标签**（属性判据用）：类名里含 `disabled:` 变体，故只看属性不看整串。 */
function buttonTag(html: string, testId: string): string {
  const tag = html.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0];
  assert.ok(tag, `找不到按钮 ${testId}：\n${html}`);
  return tag!;
}

/** 源码切片用：先去掉注释（注释里提到的标签不是渲染行为），与仓库既有守卫同一手法。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function record(over: Partial<WorkItemDeliverableRecord>): WorkItemDeliverableRecord {
  return {
    id: "deliverable-x",
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    runId: null,
    kind: "diff",
    title: "标题",
    meta: {},
    contentRef: ".zcode/squad/deliverables/deliverable-x.diff",
    contentSha: "sha",
    contentSize: null,
    actor: { kind: "system", id: "squad-runtime" },
    dedupKey: "deliverable:x:diff",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

const noop = { registerDisabledReasonMessageId: null };

test("UI-① 真渲染｜空态用真文案，登记入口存在且可用（不静默消失）", () => {
  const html = renderSection({ deliverables: [], ...noop });
  assert.ok(html.includes('data-testid="work-item-deliverables"'), "交付物区必须渲染出来");
  assert.ok(html.includes("还没有交付物"), `空态文案必现：\n${html}`);
  const toggle = buttonTag(html, "work-item-deliverable-link-toggle");
  assert.equal(toggle.includes("disabled="), false, "可写时可登记");
  assert.ok(html.includes("登记链接"), "入口文案");
});

test("UI-② 真渲染｜link 行：外链可点、URL 原样、无「查看 diff」按钮", () => {
  const html = renderSection({
    deliverables: [
      record({
        id: "deliverable-link-1",
        kind: "link",
        title: "PR #7",
        meta: {},
        contentRef: "https://example.test/pr/7",
        contentSha: null,
        contentSize: null,
      }),
    ],
    ...noop,
  });
  const anchor = html.match(/<a[^>]*data-testid="work-item-deliverable-link"[^>]*>/)?.[0];
  assert.ok(anchor, `link 行必须渲染成外链：\n${html}`);
  assert.ok(anchor!.includes('href="https://example.test/pr/7"'), "URL 原样进 href");
  assert.ok(
    anchor!.includes('target="_blank"') && anchor!.includes('rel="noreferrer"'),
    "外链安全属性",
  );
  assert.ok(html.includes("链接"), "kind 徽标 = link 的文案");
  assert.equal(
    html.includes('data-testid="work-item-deliverable-toggle"'),
    false,
    "link 没有本地正文：不得出现「查看 diff」按钮",
  );
});

test("UI-③ 真渲染｜diff 行：徽标/分支/提交数/大小/stat 原文 + 「查看 diff」按钮", () => {
  const html = renderSection({
    deliverables: [
      record({
        id: "deliverable-diff-1",
        kind: "diff",
        title: "队员 run 产出 diff（squad/member/wi-1/a）",
        meta: {
          branch: "squad/member/wi-1/a",
          base: "main",
          commitCount: 3,
          statSummary: " payload.txt | 1 +\n 1 file changed, 1 insertion(+)",
        },
        contentSize: 2048,
      }),
    ],
    ...noop,
  });
  assert.ok(html.includes("squad/member/wi-1/a"), "分支事实必须呈现");
  assert.ok(html.includes("3 个提交"), `提交数按文案插值：\n${html}`);
  assert.ok(html.includes("2.0 KB"), "大小格式化呈现");
  assert.ok(html.includes("1 file changed, 1 insertion(+)"), "stat 原文原样呈现（不解析、不重排）");
  assert.ok(html.includes("查看 diff"), "diff 行有查看按钮");
  assert.ok(html.includes('data-testid="work-item-deliverable-toggle"'));
  assert.equal(
    html.includes('data-testid="work-item-deliverable-link"'),
    false,
    "diff 行不渲染外链",
  );
});

test("UI-④ 真渲染｜登记闸：归档 ⇒ 入口禁用**并给原因**（不静默消失）", () => {
  const archivedKey = "squad.workItemDetail.deliverable.disabled.archived";
  const html = renderSection({
    deliverables: [],
    registerDisabledReasonMessageId: archivedKey,
  });
  const toggle = buttonTag(html, "work-item-deliverable-link-toggle");
  assert.ok(toggle.includes("disabled="), "归档时按钮必须禁用");
  assert.ok(html.includes("工作项已归档，不能登记交付物"), `禁用原因必须就地呈现：\n${html}`);
  // 三个面（评论/决定/交付物）共用一条判据：优先级 = 归档 > 读取失败 > null。
  assert.equal(writeDisabledReason("deliverable", { archivedAt: 1 }, "boom"), archivedKey);
  assert.equal(
    writeDisabledReason("deliverable", {}, "boom"),
    "squad.workItemDetail.deliverable.disabled.readFailed",
  );
  assert.equal(writeDisabledReason("deliverable", { archivedAt: 1 }, null), archivedKey);
  assert.equal(writeDisabledReason("deliverable", {}, null), null);
  for (const key of [archivedKey, "squad.workItemDetail.deliverable.disabled.readFailed"]) {
    assert.ok(key in zhCN && key in enUS, `两语都必须有 ${key}`);
  }
});

/** 取文案原文（缺键返回空串，让下面「非空」的断言如实变红）。 */
function textOf(locale: Record<string, string>, key: string): string {
  return locale[key] ?? "";
}

test("UI-⑤ kind 映射穷尽：闭集两型两语齐备（编译期 Record 之外再加运行期闸）", () => {
  assert.deepEqual(Object.keys(DELIVERABLE_KIND_MESSAGE_IDS).sort(), ["diff", "link"]);
  for (const messageId of Object.values(DELIVERABLE_KIND_MESSAGE_IDS)) {
    assert.equal(textOf(zhCN, messageId).trim().length > 0, true, `zh-CN 缺/空 ${messageId}`);
    assert.equal(textOf(enUS, messageId).trim().length > 0, true, `en-US 缺/空 ${messageId}`);
  }
  // 正文三态与表单文案：两语键集合逐字相同（漏一语的键在另一处会读成 id 本身）。
  const keys = (locale: Record<string, string>) =>
    Object.keys(locale)
      .filter((key) => key.startsWith("squad.workItemDetail.deliverable"))
      .sort();
  assert.deepEqual(keys(zhCN), keys(enUS));
  for (const stateKey of ["contentMissing", "contentFailed", "contentLoading"]) {
    assert.ok(`squad.workItemDetail.deliverables.${stateKey}` in zhCN, stateKey);
  }
});

test("UI-⑥ 第 20 枚在 UI 面穷尽：活动 kind 映射 20 枚、双语齐备、时间线图标已接", () => {
  const kinds = Object.keys(WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS);
  assert.equal(kinds.length, 20, "活动闭集 20 枚必须全部有文案");
  assert.ok(kinds.includes("deliverable_registered"));
  for (const kind of kinds) {
    const messageId =
      WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS[kind as keyof typeof WORK_ITEM_ACTIVITY_KIND_MESSAGE_IDS];
    assert.equal(textOf(zhCN, messageId).trim().length > 0, true, `zh-CN 缺/空 ${messageId}`);
    assert.equal(textOf(enUS, messageId).trim().length > 0, true, `en-US 缺/空 ${messageId}`);
  }
  assert.equal(zhCN["squad.workItemDetail.activity.kind.deliverable_registered"], "登记了交付物");
  const timeline = readFileSync(resolve(SRC, "squad/WorkItemCollaborationTimeline.tsx"), "utf8");
  assert.match(timeline, /deliverable_registered:\s*FileDiff/, "时间线必须给第 20 枚一个图标");
});

test("UI-⑦ 正文三态不谎报（源码切片，去注释）：file 渲染正文、missing 无空框、external 走外链", () => {
  const section = stripComments(
    readFileSync(resolve(SRC, "squad/WorkItemDeliverablesSection.tsx"), "utf8"),
  );
  const fileIndex = section.indexOf('detail.content.presence === "file"');
  const missingIndex = section.indexOf('detail.content.presence === "missing"');
  const externalIndex = section.indexOf('detail.content.presence === "external"');
  assert.ok(
    fileIndex > 0 && missingIndex > fileIndex && externalIndex > missingIndex,
    "三态分支必须都在",
  );
  const fileRegion = section.slice(fileIndex, missingIndex);
  const missingRegion = section.slice(missingIndex, externalIndex);
  const externalRegion = section.slice(externalIndex, section.indexOf("不可达（三态穷尽）"));
  assert.ok(
    fileRegion.includes("<pre") && fileRegion.includes("detail.content.text"),
    "file ⇒ 正文",
  );
  assert.ok(missingRegion.includes("contentMissing"), "missing ⇒ 「正文缺失」文案");
  assert.equal(
    missingRegion.includes("<pre"),
    false,
    "missing **不得**渲染空 pre（空框会被读成「这个 diff 是空的」）",
  );
  assert.ok(externalRegion.includes("<a") && externalRegion.includes("detail.content.url"));
  assert.ok(externalRegion.includes('rel="noreferrer"'));
  // 服务面读回 null（这条交付物在库里不存在）与「正文缺失」分开呈现。
  assert.ok(section.includes("detail === null") && section.includes("contentMissing"));
});

test("UI-⑧ 登记闸（纯函数，独立字面量集）：非 http(s) 一律拒，且提交与禁用同一判据", () => {
  const problem = (title: string, url: string) => deliverableLinkDraftProblemId({ title, url });
  assert.equal(problem("PR", "https://example.test/1"), null);
  assert.equal(problem("PR", "HTTPS://EXAMPLE.TEST/1"), null, "大小写不敏感");
  assert.equal(problem("PR", "http://example.test/1"), null);
  assert.equal(
    problem("PR", "ftp://example.test/1"),
    "squad.workItemDetail.deliverables.form.urlInvalid",
  );
  assert.equal(
    problem("PR", "javascript:alert(1)"),
    "squad.workItemDetail.deliverables.form.urlInvalid",
  );
  assert.equal(
    problem("PR", "//example.test/1"),
    "squad.workItemDetail.deliverables.form.urlInvalid",
  );
  assert.equal(
    problem("PR", "example.test/1"),
    "squad.workItemDetail.deliverables.form.urlInvalid",
  );
  assert.equal(problem("PR", "   "), "squad.workItemDetail.deliverables.form.urlRequired");
  assert.equal(
    problem("", "https://example.test/1"),
    "squad.workItemDetail.deliverables.form.titleRequired",
  );
  assert.equal(
    problem("  ", "  "),
    "squad.workItemDetail.deliverables.form.titleRequired",
    "标题优先定位",
  );

  // 组件侧：禁用与提交**同一份判据**（两处各写一份会分叉成「按钮亮着，点了没反应/点了报错」）。
  const section = readFileSync(resolve(SRC, "squad/WorkItemDeliverablesSection.tsx"), "utf8");
  assert.match(section, /const problemId = deliverableLinkDraftProblemId\(draft\);/);
  assert.match(section, /disabled=\{problemId !== null \|\| submitting\}/);
  assert.match(section, /if \(deliverableLinkDraftProblemId\(draft\) !== null\) return;/);
});

test("UI-⑩ 时间线条目：第 20 枚成主序一条、actor 原样保留（system / human 在界面上分得开）", () => {
  const activity = (over: {
    id: string;
    sequence: number;
    actor: { kind: "system" | "human"; id: string };
    payload: Record<string, unknown>;
  }) => ({
    id: over.id,
    workspaceKey: "ws",
    workspacePath: "/tmp/ws",
    workItemId: "wi-1",
    kind: "deliverable_registered" as const,
    sequence: over.sequence,
    occurredAt: 1_000 + over.sequence,
    actor: over.actor,
    sourceRun: null,
    initiatedBy: over.actor,
    commentId: null,
    decisionId: null,
    dispatchEventId: null,
    payload: over.payload,
    dedupKey: `deliverable:${over.id}:registered`,
    createdAt: 1_000 + over.sequence,
    updatedAt: 1_000 + over.sequence,
  });
  const entries = buildWorkItemTimelineEntries({
    comments: [],
    decisions: [],
    activities: [
      activity({
        id: "deliverable-auto",
        sequence: 1,
        actor: { kind: "system", id: "squad-runtime" },
        payload: {
          kind: "diff",
          title: "队员 run 产出 diff（squad/member/wi-1/a）",
          deliverableId: "deliverable-auto",
        },
      }),
      activity({
        id: "deliverable-manual",
        sequence: 2,
        actor: { kind: "human", id: "local-user" },
        payload: { kind: "link", title: "PR #7", deliverableId: "deliverable-manual" },
      }),
    ],
  });
  assert.equal(entries.length, 2, "两枚都不是评论/决定的附注：各占一条主序");
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "system" ? entry.activity.kind : entry.kind)),
    ["deliverable_registered", "deliverable_registered"],
  );
  assert.deepEqual(
    entries.map((entry) => (entry.kind === "system" ? entry.activity.actor : null)),
    [
      { kind: "system", id: "squad-runtime" },
      { kind: "human", id: "local-user" },
    ],
    "actor 原样进条目：时间线上「谁登记的」可分辨",
  );
  // 主序原样保留（repo 已排序，UI 不得重排）。
  assert.deepEqual(
    entries.map((entry) => entry.sequence),
    [1, 2],
  );
});

test("UI-⑨ 行事实读取独立复核：缺字段读 null（不猜默认值），link 的 size 恒 null", () => {
  assert.deepEqual(deliverableFacts(record({ meta: { commitCount: 0 }, contentSize: 0 })), {
    branch: null,
    commits: 0,
    size: "0 B",
    statSummary: null,
    url: null,
  });
  // 「没记提交数」不得显示成 0；形态不对（字符串/负数/小数）同样读 null。
  for (const value of ["3", -1, 1.5, null, undefined]) {
    assert.equal(
      deliverableFacts(record({ meta: { commitCount: value } })).commits,
      null,
      `commitCount=${String(value)} 应读 null`,
    );
  }
  assert.equal(deliverableFacts(record({ meta: { branch: "  " } })).branch, null);
  assert.deepEqual(
    deliverableFacts(
      record({ kind: "link", contentRef: "https://example.test/x", contentSize: 12 }),
    ),
    { branch: null, commits: null, size: "12 B", statSummary: null, url: "https://example.test/x" },
    "link 的 url 取自 contentRef；diff 的 url 恒 null",
  );
});
