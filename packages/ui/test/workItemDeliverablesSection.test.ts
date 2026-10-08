import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { WorkItemDeliverableRecord } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  DELIVERABLE_KIND_MESSAGE_IDS,
  deliverableFacts,
  deliverableLinkDraftProblemId,
} from "../src/squad/workItemDeliverablesViewModel.js";

/* #7 D1b：详情页**交付物区**（设计 §3.4 呈现半边）的纯逻辑与接线守卫。

   ui 包没有渲染测试设施 ⇒ 三件必须在纯函数上钉住的事：
   ① kind 双语的**穷尽映射**（`Record<DeliverableKind, string>`：闭集一长，这里直接编译失败）；
   ② 行的事实读取（分支/提交数/大小/stat 原文/URL）——缺字段即缺，**不猜默认值**；
   ③ 手动登记表单的**可提交判据**（title/url 的非空与形态）。
   接线守卫盯两件事：交付物区**挂在详情页上**、服务调用**只出现一处**（一次动作一个执行器）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

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
    contentSize: 2048,
    actor: { kind: "system", id: "squad-runtime" },
    dedupKey: "deliverable:x:diff",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("呈现｜kind 闭集（diff|link）的文案映射穷尽，且两语齐备", () => {
  assert.deepEqual(Object.keys(DELIVERABLE_KIND_MESSAGE_IDS).sort(), ["diff", "link"]);
  for (const messageId of Object.values(DELIVERABLE_KIND_MESSAGE_IDS)) {
    assert.ok(messageId in zhCN, `zh-CN 缺键 ${messageId}`);
    assert.ok(messageId in enUS, `en-US 缺键 ${messageId}`);
  }
});

test("呈现｜行的事实：diff 读分支/提交数/大小/stat 原文；link 读 URL 且 size 恒 null", () => {
  assert.deepEqual(
    deliverableFacts(
      record({
        meta: {
          branch: "squad/member/wi-1/agent-a",
          base: "main",
          commitCount: 3,
          statSummary: " payload.txt | 1 +\n 1 file changed, 1 insertion(+)",
        },
        contentSize: 2048,
      }),
    ),
    {
      branch: "squad/member/wi-1/agent-a",
      commits: 3,
      size: "2.0 KB",
      statSummary: " payload.txt | 1 +\n 1 file changed, 1 insertion(+)",
      url: null,
    },
  );
  assert.deepEqual(
    deliverableFacts(
      record({
        kind: "link",
        meta: {},
        contentRef: "https://example.test/pr/1",
        contentSha: null,
        contentSize: null,
      }),
    ),
    {
      branch: null,
      commits: null,
      size: null,
      statSummary: null,
      url: "https://example.test/pr/1",
    },
  );
  // 缺 meta / 形态不对 ⇒ 该格为 null（不猜：写死 0 会让「没记提交数」看起来像「零提交」）。
  assert.deepEqual(deliverableFacts(record({ meta: { commitCount: "3" }, contentSize: null })), {
    branch: null,
    commits: null,
    size: null,
    statSummary: null,
    url: null,
  });
});

test("呈现｜手动登记的可提交判据：标题/URL 空与 URL 形态各有定位（返回文案键，非空即禁提交）", () => {
  assert.equal(deliverableLinkDraftProblemId({ title: "PR #1", url: "https://x.test/1" }), null);
  assert.equal(
    deliverableLinkDraftProblemId({ title: "  ", url: "https://x.test/1" }),
    "squad.workItemDetail.deliverables.form.titleRequired",
  );
  assert.equal(
    deliverableLinkDraftProblemId({ title: "PR", url: "   " }),
    "squad.workItemDetail.deliverables.form.urlRequired",
  );
  assert.equal(
    deliverableLinkDraftProblemId({ title: "PR", url: "ftp://x.test/1" }),
    "squad.workItemDetail.deliverables.form.urlInvalid",
  );
});

test("i18n｜交付物区文案两语齐备（键集合逐字相同，含空态/缺失态/表单/禁用原因）", () => {
  const keysOf = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith("squad.workItemDetail.deliverable"));
  const zh = keysOf(zhCN).sort();
  const en = keysOf(enUS).sort();
  assert.ok(zh.length >= 14, `交付物区文案不该只有 ${zh.length} 条`);
  assert.deepEqual(zh, en, "zh-CN 与 en-US 的交付物区键必须一一对应");
});

/* ---------- 接线守卫 ---------- */

const PAGE = readFileSync(resolve(SRC_DIR, "squad/WorkItemDetailPage.tsx"), "utf8");
const SECTION = readFileSync(resolve(SRC_DIR, "squad/WorkItemDeliverablesSection.tsx"), "utf8");

test("接线｜交付物区挂在详情页：概览与协作区之间，且拿得到读模型与两个回调", () => {
  const overviewIndex = PAGE.indexOf('data-testid="work-item-detail-overview"');
  const deliverablesIndex = PAGE.indexOf("<WorkItemDeliverablesSection");
  const collaborationIndex = PAGE.indexOf('data-testid="work-item-collaboration"');
  assert.ok(deliverablesIndex > 0, "详情页必须挂上交付物区");
  assert.ok(
    overviewIndex < deliverablesIndex && deliverablesIndex < collaborationIndex,
    "交付物区落在「概览」之后、「协作」之前（设计 §3.4 的挂载点）",
  );
  for (const prop of ["deliverables={read.deliverables}", "onRegisterLink=", "onLoadContent="]) {
    assert.ok(PAGE.includes(prop), `详情页必须把 ${prop} 交给交付物区`);
  }
});

test("接线｜服务调用只在一处：登记与正文读取都经页面回调，组件自己不碰服务对象", () => {
  const SECTION_CALLS = [
    ...SECTION.matchAll(/registerWorkItemDeliverableLink|getWorkItemDeliverable\b/g),
  ];
  assert.equal(SECTION_CALLS.length, 0, "组件不得直接调服务（页面是唯一执行器）");
  for (const method of ["registerWorkItemDeliverableLink", "getWorkItemDeliverable"]) {
    const occurrences = [...PAGE.matchAll(new RegExp(`${method}\\(`, "g"))].length;
    assert.equal(occurrences, 1, `详情页里 ${method} 恰一处调用（一次动作一个执行器）`);
  }
  // 手动登记**只开 link**：UI 侧不得出现任何 diff 型的登记意图。
  assert.ok(
    !/registerWorkItemDeliverableLink\([^)]*kind/s.test(PAGE),
    "手动登记不得带 kind（手动只开 link，diff 型只由自动捕获产生）",
  );
});

test("接线｜正文三态**不谎报**：file 渲染正文、missing 提示缺失、external 走外链", () => {
  for (const marker of [
    'presence === "file"',
    'presence === "missing"',
    'presence === "external"',
  ]) {
    assert.ok(SECTION.includes(marker), `交付物区必须显式处理 ${marker}`);
  }
  assert.ok(
    SECTION.includes("deliverables.contentMissing"),
    "缺正文时显示「正文缺失」而不是空框（元数据在库，不谎报也不重建）",
  );
});
