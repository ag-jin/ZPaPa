import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  COMMENT_DISPATCH_OUTCOMES,
  type CommentDispatchOutcome,
  type CommentDispatchReceiptRecord,
  type WorkItemActivityRecord,
} from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS,
  COMMENT_DISPATCH_OUTCOME_TONES,
  commentDispatchNote,
  summarizeCommentDispatches,
} from "../src/squad/workItemCollaborationViewModel.js";

/* B5.2 独立复验（test-verifier，不消费实现者断言）：三组验证。
   ① receipt 七值穷尽与互斥 —— 用**服务面运行时闭集**比对映射 key 集，文案/色调按设计案表逐格核；
   ② viewerActor 链路 —— 全仓单一定义点 + UI 零身份拼装（我自己的判定式）+ 写请求形状无身份字段；
   ③ 独立负向守卫 —— 注入式变异对既有 R1/R2 守卫的咬合在复验流程里单独执行（见报告），
      这里补一条我自己的结构判据作为常驻回归。

   期望值来源：设计案 §5/§6 表与任务卡 §5.3-3 / §7.3，全部手写；不拿实现再算一遍。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 需求给出的七值闭集（任务卡 §5.3-3 / 设计案 §5 表；手抄，独立真源）。 */
const REQUIRED_OUTCOMES: CommentDispatchOutcome[] = [
  "pending",
  "opened",
  "queued",
  "coalesced",
  "deferred",
  "blocked",
  "failed",
];

function receipt(
  dispatchKey: string,
  outcome: CommentDispatchOutcome,
  commentId = "c-recheck",
): CommentDispatchReceiptRecord {
  return {
    dispatchKey,
    workspaceKey: "ws",
    workItemId: "wi-recheck",
    targetAgentId: "ag-recheck",
    commentId,
    threadId: commentId,
    source: "issue_assignee",
    outcome,
    detail: {},
    attemptCount: 1,
    createdAt: 1,
    updatedAt: 1,
  };
}

function suppressedActivity(
  id: string,
  commentId: string,
  reason: unknown,
): WorkItemActivityRecord {
  return {
    id,
    workspaceKey: "ws",
    workspacePath: "/w",
    workItemId: "wi-recheck",
    kind: "comment_dispatch_suppressed",
    sequence: 1,
    occurredAt: 1,
    actor: { kind: "human", id: "verify-human-77" },
    initiatedBy: { kind: "human", id: "verify-human-77" },
    commentId,
    payload: { reason },
    dedupKey: `k-${id}`,
    createdAt: 1,
  } as unknown as WorkItemActivityRecord;
}

/* ---------- ① receipt 七值穷尽与互斥 ---------- */

test("复验｜receipt 映射 key 集 == 服务面运行时闭集，且闭集恰为需求七值", () => {
  assert.deepEqual(
    Object.keys(COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS).sort(),
    [...COMMENT_DISPATCH_OUTCOMES].sort(),
    "映射必须与 COMMENT_DISPATCH_OUTCOMES 同集（服务面导出真集，运行期比对）",
  );
  assert.deepEqual(
    [...COMMENT_DISPATCH_OUTCOMES].sort(),
    [...REQUIRED_OUTCOMES].sort(),
    "服务面闭集必须恰为需求列出的七值（增删值时这里必须显式改，不得静默漂移）",
  );
  assert.equal(COMMENT_DISPATCH_OUTCOMES.length, 7, "闭集大小 = 7（七值穷尽是实体的断言）");
  assert.equal(new Set(COMMENT_DISPATCH_OUTCOMES).size, 7, "闭集内不得有重复值");
});

test("复验｜七值各自映射到 dispatch.<outcome> 文案，两语齐、文本两两互异，blocked≠failed", () => {
  const zhTexts: string[] = [];
  const enTexts: string[] = [];
  for (const outcome of COMMENT_DISPATCH_OUTCOMES) {
    const messageId = COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS[outcome];
    assert.equal(
      messageId,
      `squad.workItemDetail.dispatch.${outcome}`,
      `${outcome} 必须指到自己的文案键（换到别人的键 = 界面说错话且不报错）`,
    );
    const zh = zhCN[messageId]!;
    const en = enUS[messageId]!;
    assert.ok(typeof zh === "string" && zh.length > 0, `zh-CN 缺 ${messageId}`);
    assert.ok(typeof en === "string" && en.length > 0, `en-US 缺 ${messageId}`);
    zhTexts.push(zh);
    enTexts.push(en);
  }
  assert.equal(new Set(zhTexts).size, 7, "七值不得共用同一句中文文案");
  assert.equal(new Set(enTexts).size, 7, "七值不得共用同一句英文文案");
  assert.notEqual(
    COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS.blocked,
    COMMENT_DISPATCH_OUTCOME_MESSAGE_IDS.failed,
    "blocked 与 failed 不得合并文案（未派发 ≠ 派发失败）",
  );
  assert.notEqual(
    zhCN["squad.workItemDetail.dispatch.blocked"],
    zhCN["squad.workItemDetail.dispatch.failed"],
  );
  assert.notEqual(
    enUS["squad.workItemDetail.dispatch.blocked"],
    enUS["squad.workItemDetail.dispatch.failed"],
  );
  // suppressed 是 receipt 之外的第八个消息（两族分离，不并进插槽）。
  const suppressedZh = zhCN["squad.workItemDetail.dispatch.suppressed"];
  const suppressedEn = enUS["squad.workItemDetail.dispatch.suppressed"];
  assert.ok(typeof suppressedZh === "string" && typeof suppressedEn === "string");
  assert.ok(
    !zhTexts.includes(suppressedZh) && !enTexts.includes(suppressedEn),
    "「未请求派发」不得复用七值中的任何一句",
  );
});

test("复验｜色调语义按设计案：只有 blocked/failed 是 destructive，等待/排期不得显示为失败", () => {
  assert.deepEqual(
    Object.keys(COMMENT_DISPATCH_OUTCOME_TONES).sort(),
    [...COMMENT_DISPATCH_OUTCOMES].sort(),
    "色调映射同样必须穷尽闭集",
  );
  const destructive = (
    Object.keys(COMMENT_DISPATCH_OUTCOME_TONES) as CommentDispatchOutcome[]
  ).filter((outcome) => COMMENT_DISPATCH_OUTCOME_TONES[outcome] === "destructive");
  assert.deepEqual(
    destructive.sort(),
    ["blocked", "failed"],
    "设计案 §6：只有 blocked/failed 用 destructive（pending/queued/coalesced/deferred 都不是失败）",
  );
  // 设计案 §5 表：blocked=Ban、failed=CircleX —— 两值同色调但图标与文案必须不同（不合并）。
  const summarySource = readSource("squad/WorkItemCommentDispatchSummary.tsx");
  const iconsBlock = summarySource.slice(
    summarySource.indexOf("const OUTCOME_ICONS"),
    summarySource.indexOf("const TONE_CLASSNAME"),
  );
  assert.match(iconsBlock, /blocked:\s*Ban/, "blocked 的图标是 Ban（未派发）");
  assert.match(iconsBlock, /failed:\s*CircleX/, "failed 的图标是 CircleX（派发失败）");
  assert.ok(!/blocked:\s*CircleX/.test(iconsBlock) && !/failed:\s*Ban/.test(iconsBlock));
});

test("复验｜投影逐值不串键：每个 outcome 的 messageId/tone 都来自自己的那一格", () => {
  for (const outcome of COMMENT_DISPATCH_OUTCOMES) {
    const presentation = summarizeCommentDispatches([receipt(`k-${outcome}`, outcome)]);
    assert.equal(presentation.inline.length, 1);
    assert.equal(presentation.inline[0]!.outcome, outcome);
    assert.equal(presentation.inline[0]!.messageId, `squad.workItemDetail.dispatch.${outcome}`);
    assert.equal(presentation.inline[0]!.tone, COMMENT_DISPATCH_OUTCOME_TONES[outcome]);
  }
  // 超过两项收「另 N 个目标」（按输入顺序取前二，不重排）。
  const three = summarizeCommentDispatches(
    REQUIRED_OUTCOMES.slice(0, 3).map((outcome) => receipt(`k-${outcome}`, outcome)),
  );
  assert.deepEqual(
    three.inline.map((item) => item.outcome),
    REQUIRED_OUTCOMES.slice(0, 2),
    "inline 取前两项且顺序不变",
  );
  assert.equal(three.moreCount, 1);
  assert.deepEqual(summarizeCommentDispatches([]), { inline: [], moreCount: 0 });
});

test("复验｜抑制注记与 receipt 互斥：有 receipt（任何主/被拒 outcome）一律不渲染注记", () => {
  const noteActivity = suppressedActivity("a-note", "c-recheck", "note");
  for (const outcome of COMMENT_DISPATCH_OUTCOMES) {
    assert.equal(
      commentDispatchNote({
        commentId: "c-recheck",
        activities: [noteActivity],
        receipts: [receipt("k", outcome)],
      }),
      null,
      `同一条评论有 ${outcome} receipt 时不得再渲染「未请求派发」注记`,
    );
  }
  // blocked 的抑制 Activity 由 receipt 承接：即便没有 receipt 也不冒充「未请求派发」。
  assert.equal(
    commentDispatchNote({
      commentId: "c-recheck",
      activities: [suppressedActivity("a-blocked", "c-recheck", "blocked")],
      receipts: [],
    }),
    null,
  );
  // 无 receipt + 真抑制原因 ⇒ 注记；别条评论的活动不得串台；闭集外原因响亮抛。
  for (const reason of ["note", "all_mention", "human_mention"]) {
    assert.equal(
      commentDispatchNote({
        commentId: "c-recheck",
        activities: [suppressedActivity("a", "c-recheck", reason)],
        receipts: [],
      }),
      "squad.workItemDetail.dispatch.suppressed",
    );
  }
  assert.equal(
    commentDispatchNote({
      commentId: "c-other",
      activities: [noteActivity],
      receipts: [],
    }),
    null,
  );
  assert.throws(
    () =>
      commentDispatchNote({
        commentId: "c-recheck",
        activities: [suppressedActivity("a-bad", "c-recheck", "mystery_reason")],
        receipts: [],
      }),
    /reason/,
  );
});

test("复验｜组件层互斥结构：插槽与注记各自只在事实存在时渲染，判定只经纯函数", () => {
  const summary = readSource("squad/WorkItemCommentDispatchSummary.tsx");
  assert.ok(
    summary.includes("commentDispatchNote({ commentId, activities, receipts })"),
    "注记判定必须经纯函数（互斥判据只有一处实现）",
  );
  const noteAnchor = summary.indexOf('data-testid="work-item-comment-suppressed"');
  assert.ok(noteAnchor > 0, "注记锚点必须存在");
  assert.ok(
    summary.slice(noteAnchor - 300, noteAnchor).includes("noteMessageId === null ? null :"),
    "注记必须渲染在 noteMessageId 非空的分支里（纯函数返回 null 即不渲染）",
  );
  const listAnchor = summary.indexOf('data-testid="work-item-comment-dispatch-summary"');
  assert.ok(
    summary.slice(listAnchor - 400, listAnchor).includes("summary.inline.length === 0 ? null :"),
    "receipt 列表必须渲染在 inline 非空的分支里（无 receipt 不留空壳）",
  );
  // 只读：插槽文件不得出现任何派发写入/推进调用。
  for (const forbidden of [
    "settleCommentDispatchReceipt",
    "settleIfUnsettled",
    "planDispatch",
    "openMemberRun",
    "recordLeaderRun",
  ]) {
    assert.ok(!summary.includes(forbidden), `插槽是只读的，不得出现 ${forbidden}`);
  }
});

/* ---------- ② viewerActor 链路（D1-A） ---------- */

test("复验｜LOCAL_HUMAN_ACTOR 全仓（src 树）唯一定义点，且只被组合根注入一次", () => {
  const root = resolve(SRC_DIR, "..", "..", "..");
  const roots = [
    "packages/services/src",
    "packages/ui/src",
    "packages/desktop/src",
    "packages/shared/src",
  ];
  const hits: Array<{ file: string; line: string }> = [];
  for (const dir of roots) {
    const absolute = resolve(root, dir);
    for (const entry of readdirSync(absolute, { recursive: true, encoding: "utf8" })) {
      if (typeof entry !== "string") continue;
      if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
      const filePath = resolve(absolute, entry);
      for (const [index, line] of readFileSync(filePath, "utf8").split("\n").entries()) {
        if (line.includes("LOCAL_HUMAN_ACTOR")) {
          hits.push({ file: `${dir}/${entry}`, line: `${index + 1}: ${line.trim()}` });
        }
      }
    }
  }
  assert.deepEqual(
    [...new Set(hits.map((hit) => hit.file))],
    ["packages/services/src/node.ts"],
    "身份常量只能出现在组合根 node.ts（第二处定义/引用 = 身份分叉的开始）",
  );
  const definitions = hits.filter((hit) => /const LOCAL_HUMAN_ACTOR\b/.test(hit.line));
  assert.equal(definitions.length, 1, "定义点必须唯一");
  assert.match(
    definitions[0]!.line,
    /kind:\s*"human",\s*id:\s*"[^"]+"/,
    "定义值必须是 (kind=human, 非空 id)",
  );
  const injections = hits.filter((hit) =>
    /localHumanActor:\s*\(\)\s*=>\s*LOCAL_HUMAN_ACTOR/.test(hit.line),
  );
  assert.equal(
    injections.length,
    2,
    "注入点=门面 viewerActor + 工作项创建人（0018 起）——两处注入的是同一个常量，身份仍单源不新造",
  );
});

test("复验｜UI 源码零身份拼装（我的判定式）：不引用常量、不写身份字面量、不知道注入值", () => {
  const uiCollabFiles = readdirSync(resolve(SRC_DIR, "squad"), { encoding: "utf8" }).filter(
    (entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"),
  );
  assert.ok(uiCollabFiles.length >= 10, "协作 UI 源码扫描面（少于 10 个文件说明扫错目录）");
  // 我自己的三个判定式：带引号字面量 id 的人类身份构造（正序与反序写法）——mention 展示里的
  // `{ kind: "human", id: mention.id }` 用的是数据标识符，不是身份拼装，故不匹配。
  const literalIdentity = [
    /\bkind\s*:\s*["']human["']\s*,\s*id\s*:\s*["'][^"']+["']/,
    /\bid\s*:\s*["'][^"']+["']\s*,\s*kind\s*:\s*["']human["']/,
  ];
  for (const entry of uiCollabFiles) {
    const source = readSource(`squad/${entry}`);
    assert.ok(!source.includes("LOCAL_HUMAN_ACTOR"), `${entry} 不得引用身份常量`);
    assert.ok(!source.includes('"local-user"'), `${entry} 不得知道注入值本身`);
    for (const pattern of literalIdentity) {
      assert.ok(!pattern.test(source), `${entry} 不得用字面量构造人类身份（身份只从读面转发）`);
    }
  }
  // 正向证据：身份只能来自读面（页面转发 viewerActor，条目用同一份身份算 mine）。
  assert.ok(readSource("squad/WorkItemDetailPage.tsx").includes("viewerActor={read.viewerActor}"));
  assert.ok(
    readSource("squad/WorkItemCommentEntry.tsx").includes(
      "groupCommentReactions(reactions, viewerActor)",
    ),
  );
});

test("复验｜四个写请求形状无身份/无 workspace 字段：UI 只给「写到哪、写什么、幂等键」", () => {
  const page = readSource("squad/WorkItemDetailPage.tsx");
  const viewModel = readSource("squad/workItemCollaborationViewModel.ts");

  // create：调用切片里不得出现任何身份/workspace 键（形状由服务面类型决定，UI 不补位）。
  const createStart = page.indexOf("service.createWorkItemComment(");
  assert.ok(createStart >= 0);
  const createSlice = page.slice(createStart, createStart + 700);
  for (const key of ["workItemId", "body", "parentCommentId", "clientRequestId"]) {
    assert.ok(createSlice.includes(key), `create 请求必须带 ${key}`);
  }
  for (const forbidden of [
    "actor",
    "author",
    "initiatedBy",
    "viewerActor",
    "workspaceKey",
    "workspacePath",
  ]) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\b`).test(createSlice),
      `create 请求形状不得出现 ${forbidden}`,
    );
  }

  // resolve / react / soft-delete：对象字面量的键集必须精确（多一个键就是多一个身份位）。
  // 识别两种写法：`key: value` 与速记 `key`（`resolved` 是速记属性，正则偷懒会漏掉它）。
  const objectKeys = (body: string): string[] =>
    body
      .split(/[,\n]/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const withValue = part.match(/^(\w+)\s*:/);
        if (withValue) return withValue[1]!;
        const shorthand = part.match(/^(\w+)$/);
        return shorthand ? shorthand[1]! : `unparsed(${part})`;
      })
      .sort();
  const keySet = (source: string, pattern: RegExp, label: string): string[] => {
    const match = source.match(pattern);
    assert.ok(match, `找不到 ${label} 的调用`);
    return objectKeys(match![1]!);
  };
  assert.deepEqual(
    keySet(page, /service\.setWorkItemCommentResolved\(currentTarget,\s*\{([^}]*)\}/, "resolve"),
    ["commentId", "resolved"],
  );
  assert.deepEqual(
    keySet(page, /service\.addWorkItemCommentReaction\(currentTarget,\s*\{([^}]*)\}/, "react"),
    ["commentId", "emoji"],
  );
  assert.deepEqual(
    keySet(viewModel, /softDeleteWorkItemComment\(input\.target,\s*\{([^}]*)\}/, "soft delete"),
    ["commentId"],
  );

  // 服务面类型本身也不得带身份字段（UI 想拼也拼不出来 —— 编译期就该挡住）。
  const serviceSource = readFileSync(
    resolve(SRC_DIR, "..", "..", "services", "src", "workitem", "workItemCollaborationService.ts"),
    "utf8",
  );
  const typeStart = serviceSource.indexOf("export type CreateWorkItemCommentRequest = {");
  assert.ok(typeStart >= 0, "服务面必须导出 CreateWorkItemCommentRequest");
  const typeSlice = serviceSource.slice(typeStart, serviceSource.indexOf("};", typeStart));
  for (const forbidden of ["actor", "author", "initiatedBy", "workspaceKey", "workspacePath"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(typeSlice), `写请求类型不得含 ${forbidden}`);
  }
});

/* ---------- ③ 常驻结构判据（注入式咬合见复验报告；这里钉住不变量本身） ---------- */

test("复验｜UI 反向守卫语料仍在：R1 禁用面覆盖本轮全部新文件，R2 禁用词覆盖派发写入口", () => {
  const guard = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "workItemDetailPage.test.ts"),
    "utf8",
  );
  // 本轮新增/修改的 UI 文件必须都在 R1/R2 的扫描名单里（漏一个 = 那一个文件可以偷偷 import repo）。
  for (const file of [
    "squad/WorkItemDetailPage.tsx",
    "squad/WorkItemCommentComposer.tsx",
    "squad/WorkItemCommentEntry.tsx",
    "squad/WorkItemCommentDeleteDialog.tsx",
    "squad/WorkItemCommentDispatchSummary.tsx",
    "squad/workItemCollaborationViewModel.ts",
  ]) {
    assert.ok(guard.includes(`"${file}"`), `守卫扫描名单缺 ${file}`);
  }
  for (const forbidden of ["@zcode/services/node", "node:sqlite", "workItemCommentRepo"]) {
    assert.ok(guard.includes(`"${forbidden}"`), `R1 禁用面缺 ${forbidden}`);
  }
  for (const forbidden of [
    "openMemberRun",
    "recordLeaderRun",
    "planDispatch",
    "settleCommentDispatchReceipt",
  ]) {
    assert.ok(guard.includes(`"${forbidden}"`), `R2 禁用面缺 ${forbidden}`);
  }
  // 扫描面与真实文件一致（守卫名单里的文件必须都真实存在）。
  for (const match of guard.matchAll(/"squad\/[\w.]+\.tsx?"/g)) {
    const file = match[0]!.replaceAll('"', "");
    assert.ok(readSource(file).length > 0, `守卫扫描名单里的 ${file} 必须存在`);
  }
});
