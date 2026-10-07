import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORK_ITEM_DECISION_KINDS,
  createWorkItemCollaborationService,
  type WorkItemDecisionKind,
  type WorkItemDecisionRecord,
} from "@zcode/services";
/* 真库真服务的 node 侧工厂只能按相对路径取（services 的 node 入口不导出它们）——与既有接线测试同款。 */
import { runTasksDatabaseMigrations } from "../../services/src/session/tasksDatabase/migrations.js";
import { createCommentDispatchReceiptRepo } from "../../services/src/workitem/commentDispatchReceiptRepo.js";
import { createWorkItemActivityRepo } from "../../services/src/workitem/workItemActivityRepo.js";
import { createWorkItemCommentReactionRepo } from "../../services/src/workitem/workItemCommentReactionRepo.js";
import { createWorkItemCommentRepo } from "../../services/src/workitem/workItemCommentRepo.js";
import { createWorkItemDecisionRepo } from "../../services/src/workitem/workItemDecisionRepo.js";
import {
  createWorkItemDecisionService,
  type WorkItemDecisionServiceDeps,
} from "../../services/src/workitem/workItemDecisionService.js";
import { createWorkItemRepo } from "../../services/src/workitem/workItemRepo.js";
import type { SquadRuntime } from "../../services/src/workitem/squadContracts.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  buildWorkItemTimelineEntries,
  writeDisabledReason,
} from "../src/squad/workItemCollaborationViewModel.js";
import {
  DECISION_KIND_MESSAGE_IDS,
  DECISION_PARENT_PREFIX_MESSAGE_IDS,
  decisionKindMessageId,
  decisionParentCandidates,
  decisionParentReference,
  decisionSubmitParentId,
} from "../src/squad/workItemDecisionViewModel.js";

/* C3 线独立复验（test-verifier）：C3.2 决定面。
 *
 * 与实现者的 ui 用例**刻意不同源**：
 * · 闭集核对到**翻译字符串**一层（不只是文案键互异），并从源码里**独立提取**被引用的键再去比对 locale；
 * · 父候选除了纯函数逐格，还用**真服务**反证「UI 候选集不宽于服务面」（R2 风险的正向验证）；
 * · U3 单点用**全树遍历**（不是固定文件名单）；
 * · 时间线激活另加两条**负控**（悬空锚 / 无锚决定 ⇒ link-error），证明「锚」是承重的而不是摆设。 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 依赖集封顶的类型层断言：加 runs/receipts 到 deps ⇒ `pnpm typecheck` 在本文件报错（编译期红线）。 */
type DepsCapHolds = Equal<
  keyof WorkItemDecisionServiceDeps,
  "activities" | "decisions" | "newId" | "now" | "workItems"
>;
const DEPS_CAP_HOLDS: DepsCapHolds = true;
/** 判据自检（保证上面的 Equal 会真的区分）：若 Equal 退化成恒 true，下面这行赋值即编译错。 */
const EQUAL_DISCRIMINATES: Equal<"a" | "b", "a"> = false;

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSourceFiles(full, out);
    else if (/\.tsx?$/.test(full) && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const UI_SOURCES = walkSourceFiles(SRC_DIR).map((file) => ({
  file,
  relative: file.slice(SRC_DIR.length + 1),
  source: readFileSync(file, "utf8"),
}));

const WANTED_FILES = [
  "squad/WorkItemDetailPage.tsx",
  "squad/WorkItemDecisionDialog.tsx",
  "squad/workItemDecisionViewModel.ts",
  "squad/WorkItemCollaborationTimeline.tsx",
];

/* ---------- 1：kind 闭集穷尽（键集 + 翻译串两层） ---------- */

test("kind 映射｜键集 == 服务面运行时闭集，且五键的**两语文案串**各自两两互异（闭集外响亮抛）", () => {
  assert.deepEqual(
    Object.keys(DECISION_KIND_MESSAGE_IDS).sort(),
    [...WORK_ITEM_DECISION_KINDS].sort(),
    "映射键集必须与服务面闭集同集（少一个值 ⇒ 界面少一句话而仍显示）",
  );
  assert.deepEqual(
    Object.keys(DECISION_PARENT_PREFIX_MESSAGE_IDS).sort(),
    [...WORK_ITEM_DECISION_KINDS].sort(),
    "父引用前缀映射同样必须闭集穷尽（否则某 kind 的父链会凭空消失）",
  );
  for (const locale of [
    { name: "zh-CN", messages: zhCN },
    { name: "en-US", messages: enUS },
  ]) {
    const texts = WORK_ITEM_DECISION_KINDS.map(
      (kind) => locale.messages[DECISION_KIND_MESSAGE_IDS[kind]] ?? "",
    );
    for (const text of texts) assert.ok(text.length > 0, `${locale.name} 的 kind 文案不得为空`);
    assert.equal(
      new Set(texts).size,
      WORK_ITEM_DECISION_KINDS.length,
      `${locale.name}：五键必须各说各话（两个 kind 共用一句 = 界面说错话）`,
    );
  }
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    assert.equal(decisionKindMessageId(kind), DECISION_KIND_MESSAGE_IDS[kind]);
  }
  assert.throws(
    () => decisionKindMessageId("accepted_later"),
    /闭集外/,
    "闭集外的 kind 不猜标签（B5.1 的 else 兜底正是「确定的假话」）",
  );
});

/* ---------- 2：i18n（独立提取源码引用的键，再比对两语） ---------- */

const placeholders = (value: string) =>
  [...value.matchAll(/\{(\w+)\}/g)]
    .map((match) => match[1])
    .sort()
    .join(",");

test("i18n｜从 C3.2 源码独立提取的 decision.* 键全部两语齐备、占位符成对；子树整体成对", () => {
  const referenced = new Set<string>();
  for (const { relative, source } of UI_SOURCES) {
    if (!WANTED_FILES.includes(relative.replace(/\\/g, "/"))) continue;
    for (const match of source.matchAll(/"(squad\.workItemDetail\.decision\.[A-Za-z.]+)"/g)) {
      referenced.add(match[1]!);
    }
  }
  // 映射表里的键（kind 五键 + 父引用三前缀）也要算进来。
  for (const id of Object.values(DECISION_KIND_MESSAGE_IDS)) referenced.add(id);
  for (const id of Object.values(DECISION_PARENT_PREFIX_MESSAGE_IDS)) referenced.add(id);
  // writeDisabledReason 拼出的两个禁用键（判据在纯函数里，源码里是模板串）。
  referenced.add(writeDisabledReason("decision", { archivedAt: 1 }, null)!);
  referenced.add(writeDisabledReason("decision", {}, "boom")!);
  assert.ok(referenced.size >= 19, `独立提取到的决定面文案键应 ≥ 19，实际 ${referenced.size}`);
  for (const id of referenced) {
    const zh = zhCN[id];
    const en = enUS[id];
    assert.ok(zh && zh.length > 0, `zh-CN 缺键或空值 ${id}`);
    assert.ok(en && en.length > 0, `en-US 缺键或空值 ${id}`);
    assert.equal(placeholders(zh), placeholders(en), `${id} 占位符不成对`);
  }
  const prefix = "squad.workItemDetail.decision.";
  const zhKeys = Object.keys(zhCN).filter((key) => key.startsWith(prefix));
  const enKeys = Object.keys(enUS).filter((key) => key.startsWith(prefix));
  assert.deepEqual(zhKeys.sort(), enKeys.sort(), "decision.* 子树两语键集必须相等");
  for (const key of zhKeys) {
    assert.ok((enUS[key] ?? "").length > 0, `${key} 的英文值不得为空`);
  }
});

/* ---------- 3：父候选（纯函数逐格 + 真服务反证「UI 不宽于服务面」） ---------- */

function decisionRow(
  id: string,
  kind: WorkItemDecisionKind,
  parentDecisionId: string | null = null,
): WorkItemDecisionRecord {
  return {
    id,
    workspaceKey: "c3v-ui-ws",
    workspacePath: "/tmp/c3v-ui-ws",
    workItemId: "wi-1",
    threadId: null,
    parentDecisionId,
    author: { kind: "human", id: "local-user" },
    sourceRunId: null,
    initiatedBy: { kind: "human", id: "local-user" },
    kind,
    subject: `事项 ${id}`,
    selection: {},
    rationale: null,
    evidence: [],
    effectiveAt: 100,
    dedupKey: `decision:${id}`,
    createdAt: 100,
    updatedAt: 100,
  };
}

test("父候选｜superseded ⇒ 全部（保序）；reopened ⇒ 仅 {accepted,rejected,superseded}（保序）；其余 ⇒ 空数组", () => {
  // 输入顺序故意打乱（不按 kind 分组）：候选必须原样保序，不得重排。
  const rows = [
    decisionRow("d-sup", "superseded"),
    decisionRow("d-pro", "proposal"),
    decisionRow("d-acc", "accepted"),
    decisionRow("d-reo", "reopened"),
    decisionRow("d-rej", "rejected"),
  ];
  assert.deepEqual(
    decisionParentCandidates("superseded", rows).map((row) => row.id),
    ["d-sup", "d-pro", "d-acc", "d-reo", "d-rej"],
    "取代的候选 = 全部既有决定（含 superseded 自身族：允许链式取代）",
  );
  assert.deepEqual(
    decisionParentCandidates("reopened", rows).map((row) => row.id),
    ["d-sup", "d-acc", "d-rej"],
    "重审的候选 = 仅已结的三键，且顺序原样（proposal/reopened 是服务面必然拒的死格）",
  );
  for (const kind of ["proposal", "accepted", "rejected"] as const) {
    assert.deepEqual(
      decisionParentCandidates(kind, rows),
      [],
      `${kind} 的父是可选的、v1 不给选择器 ⇒ 不渲染候选`,
    );
  }
  assert.deepEqual(decisionParentCandidates("superseded", []), [], "空集合不炸");
  const supersededCandidates = decisionParentCandidates("superseded", rows);
  assert.notEqual(supersededCandidates, rows, "返回的是新数组（不把输入数组交给调用方去改）");
});

test("父候选｜真服务反证：superseded 的每个候选都被服务接受；reopened 的三候选接受、被滤掉的两键必拒（UI 不宽于服务面）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const activities = createWorkItemActivityRepo(db);
  workItems.insert({
    id: "wi-1",
    workspaceIdentity: "c3v-oracle-ws",
    workspacePath: "/tmp/c3v-oracle-ws",
    title: "标题",
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  });
  let generated = 0;
  const service = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: () => 1_760_000_100_000,
    newId: () => `c3v-oracle-${++generated}`,
  });
  const write = (kind: WorkItemDecisionKind, parentDecisionId?: string) =>
    service.createDecision({
      workspaceKey: "c3v-oracle-ws",
      workspacePath: "/tmp/c3v-oracle-ws",
      workItemId: "wi-1",
      kind,
      subject: `oracle ${kind} ${parentDecisionId ?? "root"}`,
      author: { kind: "human", id: "local-user" },
      sourceRequestId: `oracle-${kind}-${parentDecisionId ?? "root"}`,
      ...(parentDecisionId === undefined ? {} : { parentDecisionId }),
    });

  const proposal = write("proposal");
  const accepted = write("accepted");
  const rejected = write("rejected");
  const superseded = write("superseded", accepted.id);
  const reopened = write("reopened", rejected.id);
  const rows = [superseded, proposal, accepted, reopened, rejected];
  const byKind = { proposal, accepted, rejected, superseded, reopened };

  // UI 给出的 reopened 候选：服务面必须全部接受（否则用户能选到一个必然被拒的父）。
  const reopenedCandidates = decisionParentCandidates("reopened", rows);
  assert.deepEqual(reopenedCandidates.map((row) => row.kind).sort(), [
    "accepted",
    "rejected",
    "superseded",
  ]);
  for (const candidate of reopenedCandidates) {
    const child = write("reopened", candidate.id);
    assert.equal(child.parentDecisionId, candidate.id, `重审父 ${candidate.kind} 必须被服务接受`);
  }
  // UI 滤掉的两键：服务面必然拒（这就是「UI 不宽于服务面」的反向确认）。
  for (const kind of ["proposal", "reopened"] as const) {
    assert.throws(
      () => write("reopened", byKind[kind].id),
      /不在 \{accepted, rejected, superseded\}/,
      `${kind} 不在重审候选里，服务面也必然拒（UI 与服务的判据同集）`,
    );
  }
  // superseded 的全部候选：服务面全部接受（链式取代合法）。
  for (const candidate of decisionParentCandidates("superseded", rows)) {
    const child = write("superseded", candidate.id);
    assert.equal(child.parentDecisionId, candidate.id);
  }
  // 父引用解析：可解析 ⇒ resolved；父不在读面 ⇒ unresolved（只给 id）。
  const byId = new Map(rows.map((row) => [row.id, row]));
  assert.deepEqual(decisionParentReference(superseded, byId), {
    kind: "resolved",
    parent: accepted,
  });
  assert.deepEqual(
    decisionParentReference(decisionRow("d-orphan", "superseded", "d-ghost"), byId),
    { kind: "unresolved", id: "d-ghost" },
    "父不可解析 ⇒ 只给 id（编名字 = 时间线说一句确定的假话）",
  );
  assert.equal(decisionParentReference(decisionRow("d-root", "proposal"), byId), null);
});

/* ---------- 4：U3 单点（全树遍历） ---------- */

test("U3｜UI 全域决定写入调用恰一处，且落在详情页的唯一执行器里；对话框零服务访问", () => {
  const WRITE_NEEDLE = "createWorkItemDecision(";
  const hits = UI_SOURCES.filter(({ source }) => source.includes(WRITE_NEEDLE));
  assert.deepEqual(
    hits.map((hit) => hit.relative),
    ["squad/WorkItemDetailPage.tsx"],
    "全树（packages/ui/src）只有一个文件出现决定写入调用",
  );
  const page = hits[0]!.source;
  assert.equal(
    page.split(WRITE_NEEDLE).length - 1,
    1,
    "决定写入调用恰一处（模板与对话框只拿回调 —— N5 的变异形态是对话框自己调服务）",
  );
  assert.ok(
    page.includes("service.createWorkItemDecision(currentTarget, { ...input, workItemId: id })") ||
      page.includes("service.createWorkItemDecision(currentTarget, {"),
    "写入必须经 runCollaborationAction 拿到的 service + currentTarget（UI 不自己构造服务/目标）",
  );
  // 注入式咬合（静态可得的最强形态）：对话框只拿到「回调」，拿不到服务句柄 ——
  // 全树里**唯一**解析写服务的地方就是那个唯一执行器，所以「对话框自己写」在结构上不可达。
  const WRITE_SERVICE_RESOLUTION =
    "await run(resolveWorkItemCollaborationService(services), target)";
  assert.equal(
    page.split(WRITE_SERVICE_RESOLUTION).length - 1,
    1,
    "写路径解析服务句柄恰一处（决定链路只能经它）",
  );
  assert.ok(
    page
      .slice(0, page.indexOf(WRITE_SERVICE_RESOLUTION))
      .includes("const runCollaborationAction ="),
    "服务句柄解析必须落在 runCollaborationAction 内部",
  );
  const dialog = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemDecisionDialog.tsx"),
  )!;
  assert.equal(
    dialog.source.split("resolveWorkItemCollaborationService").length - 1,
    0,
    "对话框拿不到服务：它只接受 onSubmit 回调（注入式单点）",
  );
  assert.equal(
    dialog.source.split("onSubmit: (input: DecisionSubmitInput) => Promise<void>").length - 1,
    2,
    "入口与对话框都只声明 onSubmit 回调（两层签名一致）",
  );
  for (const forbidden of [
    "resolveWorkItemCollaborationService",
    "createWorkItemDecision",
    "getSnapshot(",
    "setOptimistic",
    "createWorkItemComment",
  ]) {
    assert.equal(
      dialog.source.includes(forbidden),
      false,
      `对话框不得出现 ${forbidden}（它只组装表单 + 回传回调）`,
    );
  }
  // 入口按钮与禁用原因都在对话框模块里（入口与对话框同住一个模块是有意的：一次写入意图的开合）。
  for (const needle of [
    'data-testid="work-item-decision-record"',
    'data-testid="work-item-decision-record-reason"',
    "aria-describedby",
  ]) {
    assert.ok(dialog.source.includes(needle), `入口必须包含 ${needle}`);
  }
});

/* ---------- 5：归档禁用（入口存在 + 原因可见 + 两语） ---------- */

test("归档禁用｜writeDisabledReason 决定面判据 + 入口「禁用而非消失」+ 原因文案两语可读", () => {
  assert.equal(
    writeDisabledReason("decision", { archivedAt: 1 }, "boom"),
    "squad.workItemDetail.decision.disabled.archived",
    "归档压过刷新失败（说更根本的那件事）",
  );
  assert.equal(
    writeDisabledReason("decision", {}, "boom"),
    "squad.workItemDetail.decision.disabled.readFailed",
  );
  assert.equal(writeDisabledReason("decision", {}, null), null, "可写 ⇒ 无理由");
  assert.ok((zhCN["squad.workItemDetail.decision.disabled.archived"] ?? "").includes("归档"));
  assert.ok(
    (enUS["squad.workItemDetail.decision.disabled.archived"] ?? "")
      .toLowerCase()
      .includes("archive"),
  );
  assert.notEqual(
    (zhCN["squad.workItemDetail.decision.disabled.readFailed"] ?? "").length,
    0,
    "读取失败的原因也要说得出来",
  );

  const dialog = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemDecisionDialog.tsx"),
  )!.source;
  assert.ok(
    dialog.includes("disabled={disabledReasonMessageId !== null}"),
    "入口按钮在不可写时**禁用**（而不是不渲染）",
  );
  assert.ok(
    dialog.includes("disabledReasonMessageId === null ? null : ("),
    "原因段落只在不可写时出现，且**就在入口旁边**",
  );
  assert.ok(
    dialog.includes('data-testid="work-item-decision-record-reason"'),
    "原因段落有 testid（可被断言/可访问）",
  );

  const page = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemDetailPage.tsx"),
  )!.source;
  assert.ok(page.includes("<WorkItemDecisionRecorder"), "详情页必须渲染入口");
  const entryIndex = page.indexOf("<WorkItemDecisionRecorder");
  const entryJsx = page.slice(entryIndex, entryIndex + 260);
  assert.ok(
    entryJsx.includes("disabledReasonMessageId={decisionDisabledReason}"),
    "入口的禁用原因必须来自判据单源（页面不自己写第二份归档判据）",
  );
  assert.equal(
    entryJsx.includes("archivedAt"),
    false,
    "入口不得用「归档就不渲染」的写法：必须存在但禁用（静默消失让「为什么不能记录」只能靠猜）",
  );
  assert.ok(
    page.includes('writeDisabledReason("decision", workItem, state.refreshFailure)'),
    "禁用原因来自 writeDisabledReason(decision, …)（与评论面同一判据、只换文案族）",
  );
});

/* ---------- 6：时间线激活链（真库）+ 两条负控 ---------- */

const CHAIN_WS = { path: "/tmp/c3v-ui-chain-ws", identity: "c3v-ui-chain-ws" };
const CHAIN_HUMAN = { kind: "human" as const, id: "local-user" };
const CHAIN_CLOCK = 1_760_000_200_000;

function setupChain() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const workItems = createWorkItemRepo(db);
  const decisions = createWorkItemDecisionRepo(db);
  const activities = createWorkItemActivityRepo(db);
  workItems.insert({
    id: "wi-chain",
    workspaceIdentity: CHAIN_WS.identity,
    workspacePath: CHAIN_WS.path,
    title: "链式工作项",
    body: "",
    status: "todo" as const,
    assignee: { type: "agent" as const, id: "ag-1" },
    labels: [],
    properties: {},
    position: 0,
  });
  let generated = 0;
  const decisionService = createWorkItemDecisionService({
    decisions,
    activities,
    workItems,
    now: () => CHAIN_CLOCK,
    newId: () => `c3v-chain-${++generated}`,
  });
  const facade = createWorkItemCollaborationService({
    createRuntime: async () =>
      ({ workItemRepo: workItems, boundWorkspace: CHAIN_WS }) as unknown as SquadRuntime,
    getRepos: () => ({
      comments: createWorkItemCommentRepo(db),
      activities,
      decisions,
      reactions: createWorkItemCommentReactionRepo(db),
      receipts: createCommentDispatchReceiptRepo(db),
    }),
    localHumanActor: () => CHAIN_HUMAN,
    createDecisionService: () => decisionService,
  });
  return { db, decisions, activities, facade };
}

test("时间线激活链｜门面写入 → 读回 → 投影 ⇒ 条目就地出现、父链解析到旧条目（reopened 形态，非 superseded）", async () => {
  const f = setupChain();
  const first = await f.facade.createWorkItemDecision(CHAIN_WS, {
    workItemId: "wi-chain",
    kind: "rejected",
    subject: "拒绝方案 B",
    rationale: "风险高",
    sourceRequestId: "chain-1",
  });
  const second = await f.facade.createWorkItemDecision(CHAIN_WS, {
    workItemId: "wi-chain",
    kind: "reopened",
    subject: "重审方案 B",
    parentDecisionId: first.id,
    sourceRequestId: "chain-2",
  });

  const read = await f.facade.getWorkItemCollaboration(CHAIN_WS, "wi-chain");
  assert.ok(read !== null);
  assert.deepEqual(
    read.decisions.map((row) => [row.id, row.kind, row.parentDecisionId]),
    [
      [first.id, "rejected", null],
      [second.id, "reopened", first.id],
    ],
    "门面读回两条（旧行仍在，且新行指向它 —— 取代/重审不覆盖历史）",
  );
  assert.deepEqual(
    read.activities.map((row) => [row.sequence, row.kind, row.decisionId]),
    [
      [1, "decision_created", first.id],
      [2, "decision_created", second.id],
    ],
    "两条决定各一枚锚定活动、sequence 顺延",
  );

  const entries = buildWorkItemTimelineEntries({
    comments: read.comments,
    activities: read.activities,
    decisions: read.decisions,
  });
  assert.deepEqual(
    entries.map((entry) => entry.kind),
    ["decision", "decision"],
    "带锚活动 ⇒ 两个决定条目（不是 link-error）",
  );
  const secondEntry = entries[1];
  const secondDecision = secondEntry?.kind === "decision" ? secondEntry.decision : null;
  assert.equal(secondDecision?.id, second.id, "第二个条目就是第二条决定（不是 link-error）");
  const resolved = decisionParentReference(
    secondDecision!,
    new Map(read.decisions.map((row) => [row.id, row])),
  );
  const parentRow = resolved?.kind === "resolved" ? resolved.parent : null;
  assert.deepEqual(parentRow, read.decisions[0], "解析出来的就是读面里那一行（交叉核对）");
});

test("时间线激活链（负控）｜悬空锚与无锚决定都退化成 link-error ⇒ 证明「锚」是承重的", async () => {
  const f = setupChain();
  // 负控 1：锚指向不存在的决定（等价于写入方漏写/写错 decisionId）。
  f.activities.add({
    id: "activity-ghost",
    workspaceKey: CHAIN_WS.identity,
    workspacePath: CHAIN_WS.path,
    workItemId: "wi-chain",
    kind: "decision_created",
    occurredAt: CHAIN_CLOCK,
    actor: CHAIN_HUMAN,
    initiatedBy: CHAIN_HUMAN,
    decisionId: "c3v-ghost",
    payload: {},
    dedupKey: "decision:c3v-ghost:created",
    createdAt: CHAIN_CLOCK,
  });
  const ghostEntries = buildWorkItemTimelineEntries({
    comments: [],
    activities: f.activities.listByWorkItem(CHAIN_WS.identity, "wi-chain"),
    decisions: [],
  });
  assert.deepEqual(
    ghostEntries.map((entry) => [entry.kind, entry.kind === "link-error" ? entry.subject : null]),
    [["link-error", "decision"]],
    "悬空锚 ⇒ link-error（若实现漏写锚，UI 就是这么「静默降级」的：这条负控让正控有意义）",
  );

  // 负控 2：决定行存在但没有任何锚定活动（等价于服务只写决定不写活动）。
  const orphan = f.decisions.add({
    id: "c3v-orphan",
    workspaceKey: CHAIN_WS.identity,
    workspacePath: CHAIN_WS.path,
    workItemId: "wi-chain",
    author: CHAIN_HUMAN,
    initiatedBy: CHAIN_HUMAN,
    kind: "accepted",
    subject: "没人记录活动的决定",
    effectiveAt: CHAIN_CLOCK,
    dedupKey: "decision:c3v-orphan",
    createdAt: CHAIN_CLOCK,
  });
  const orphanEntries = buildWorkItemTimelineEntries({
    comments: [],
    activities: [],
    decisions: [orphan],
  });
  assert.deepEqual(
    orphanEntries.map((entry) => [
      entry.kind,
      entry.sequence,
      entry.kind === "link-error" ? entry.id : null,
    ]),
    [["link-error", null, "c3v-orphan"]],
    "无锚决定 ⇒ 尾部 link-error（位置不可知，不按本地时钟强插）",
  );
});

/* ---------- 7：评论四入口不受第五写入口影响 ---------- */

test("回归｜详情页评论四入口接线原样（各恰一次），决定面不入侵评论面", () => {
  const page = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemDetailPage.tsx"),
  )!.source;
  const needles = [
    "service.createWorkItemComment(currentTarget, {",
    "service.setWorkItemCommentResolved(currentTarget, {",
    "service.addWorkItemCommentReaction(currentTarget, {",
    "executeCommentDelete({ service, target: currentTarget, decision })",
  ];
  for (const needle of needles) {
    assert.equal(page.split(needle).length - 1, 1, `评论面接线 ${needle} 必须仍恰一处`);
  }
  assert.ok(
    page.includes("await runCollaborationAction(null, (service, currentTarget) =>"),
    "评论提交仍经唯一执行器",
  );
  const timeline = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemCollaborationTimeline.tsx"),
  )!.source;
  assert.ok(!timeline.includes("createWorkItemDecision"), "时间线是只读面：不得出现任何写调用");
});

/* ---------- 8：类型层依赖集封顶（编译期红线的运行时自证） ---------- */

test("结构红线（编译期）｜WorkItemDecisionServiceDeps 的键集恰好封顶（本文件在 ui/tsconfig.test.json 内被 tsc 检查）", () => {
  assert.equal(
    DEPS_CAP_HOLDS,
    true,
    "类型断言恒真；真正的裁决在 `pnpm typecheck`（不封顶即编译错）",
  );
  assert.equal(
    EQUAL_DISCRIMINATES,
    false,
    "Equal 自检：它必须能区分不等的键集（否则上面的断言是空转）",
  );
});

/* ---------- 9：提交载荷（C3 线收尾修复 3bf42e4 的独立复验） ---------- */

test("提交载荷（收尾修复复验）｜切 kind 留下的父选择不得混进审计事实：15 格 + 真服务落地复核", async () => {
  // 15 格：五键 × {未选 / 选 d-parent / 选 d-other}。
  const selections: (string | null)[] = [null, "d-parent", "d-other"];
  const parentRequired = new Set<WorkItemDecisionKind>(["superseded", "reopened"]);
  let cells = 0;
  for (const kind of WORK_ITEM_DECISION_KINDS) {
    for (const selection of selections) {
      const payloadParent = decisionSubmitParentId(kind, selection);
      assert.equal(
        payloadParent,
        parentRequired.has(kind) ? selection : null,
        `${kind} + 选中「${selection ?? "无"}」⇒ 载荷父 = ${
          parentRequired.has(kind) ? "选中值" : "null（残留选择必须被剥掉）"
        }`,
      );
      cells += 1;
    }
  }
  assert.equal(cells, 15, "15 格全部跑到");

  // 真服务落地复核：剥掉父之后的 payload（proposal + 残留选择）在库里就是 parentDecisionId=null。
  const f = setupChain();
  const written = await f.facade.createWorkItemDecision(CHAIN_WS, {
    workItemId: "wi-chain",
    kind: "proposal",
    subject: "残留父选择的提议",
    // 按 decisionSubmitParentId 的结论：不带 parentDecisionId。
    sourceRequestId: "stale-parent-1",
  });
  assert.equal(
    written.parentDecisionId,
    null,
    "UI 剥掉残留父后，库里那条提议的决定行没有父引用（审计事实不接受看不见的选择）",
  );

  // 源码传递链：对话框必须经决策函数产出载荷父，不得直传 state。
  const dialog = UI_SOURCES.find(({ relative }) =>
    relative.endsWith("WorkItemDecisionDialog.tsx"),
  )!.source;
  assert.equal(
    dialog.split("decisionSubmitParentId(kind, parentDecisionId)").length - 1,
    1,
    "载荷父必须经 decisionSubmitParentId 计算（恰一处）",
  );
  assert.ok(
    dialog.includes("...(parentForSubmit === null ? {} : { parentDecisionId: parentForSubmit })"),
    "载荷只在必填 kind 且选过父时才带 parentDecisionId",
  );
});
