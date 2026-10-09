import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  createInboxChannelDelivery,
  type InboxChannelPushParams,
} from "../src/workitem/inboxChannelDelivery.js";
import {
  createInboxItemRepo,
  type InboxItem,
  type InboxItemKind,
} from "../src/workitem/inboxItemRepo.js";
import type { InboxSubscriberRow } from "../src/workitem/inboxNotificationPolicy.js";
import { createSquadRuntime } from "../src/workitem/squadRuntime.js";
import type { SubscriberSubject } from "../src/workitem/subscriberFacts.js";
import { makeRepo } from "./helpers/gitFixture.js";

/* SUB.3b：**投递编排**（`inboxChannelDelivery`）——「这条新条目要不要推出去」。

   三层期望值来源（都不重算实现的判据）：
   · 投递档 = §2.2 第 2 条「由既有 severity 单源派生」+ Q3 裁定：`action_required` / `attention`
     推、`info` 只落 Inbox ⇒ 九个 kind 逐格抄录（见下表字面）；
   · 收件人闸 = §2.2「订阅是同一产生点的投递/过滤面」+ §2.3「冒泡的唯一可观察面是渠道推送」：
     没有任何收件人 ⇒ 零出站；经**祖先**冒泡可达 ⇒ 推；退订静音 ⇒ 零出站；
   · 失败语义 = §2.4 失败行（best-effort：只 warn，不抛、不重试、不影响登记返回值）。

   观测面：注入的 port（组合根把它绑到 bots 域的 `pushInboxChannelSummary`）。 */

const WS = "ws-1";
const WORK_ITEM = "wi-1";
const PARENT = "wi-parent";
const HUMAN: SubscriberSubject = { kind: "human", id: "local-user" };
const AGENT: SubscriberSubject = { kind: "agent", id: "ta-ann" };

/* 结构守卫的取源口（照 `inboxNotificationPolicy.test.ts` 的既有手法：去注释再扫）。 */
const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** 递归列出 src 下全部 `.ts`（守卫的**全仓**口径：只扫某一个文件会漏掉第二构造面）。 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

/** 从 `index` 处的调用名取出**完整调用文本**（括号配对到闭合，含嵌套箭头函数参数）。 */
function callTextAt(source: string, index: number): string {
  let depth = 0;
  for (let cursor = source.indexOf("(", index); cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") depth += 1;
    else if (source[cursor] === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(index, cursor + 1);
    }
  }
  throw new Error(`未闭合的调用（源码守卫取不到调用文本）：${source.slice(index, index + 80)}`);
}

/** 一条订阅行（判据只读三格；活动行恒 `issue`）。 */
function row(
  subject: SubscriberSubject,
  over: Partial<Omit<InboxSubscriberRow, "subjectType" | "subjectId">> = {},
): InboxSubscriberRow {
  return {
    subjectType: subject.kind,
    subjectId: subject.id,
    tombstonedAt: null,
    optOutScope: "issue",
    ...over,
  };
}

function item(kind: InboxItemKind, over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: `inbox-${kind}`,
    workspaceKey: WS,
    workspacePath: "/repo/ZPaPa",
    kind,
    severity: kind === "dispatch_skipped" || kind === "comment_attention" ? "info" : "attention",
    title: "修复登录",
    detail: {},
    workItemId: WORK_ITEM,
    runId: null,
    createdAt: 1,
    readAt: null,
    archivedAt: null,
    ...over,
  };
}

type Harness = {
  pushes: InboxChannelPushParams[];
  notify: (item: InboxItem) => void;
  warns: unknown[][];
};

/** 编排器夹具：订阅行集 + 父链（缺省根）+ 记录型 port。 */
function setup(over: {
  rowsByWorkItem?: Record<string, InboxSubscriberRow[]>;
  parents?: Record<string, string | null>;
  push?: (params: InboxChannelPushParams) => void | Promise<void>;
  withPort?: boolean;
}): Harness {
  const pushes: InboxChannelPushParams[] = [];
  const warns: unknown[][] = [];
  const delivery = createInboxChannelDelivery({
    target: { workspacePath: "/repo/ZPaPa", workspaceIdentity: WS },
    readSubscribers: (workItemId) => over.rowsByWorkItem?.[workItemId] ?? [],
    readParentId: (workItemId) => over.parents?.[workItemId] ?? null,
    ...(over.withPort === false
      ? {}
      : { push: over.push ?? ((params: InboxChannelPushParams) => void pushes.push(params)) }),
    warn: (message, error) => void warns.push([message, error]),
  });
  return { pushes, warns, notify: (value) => delivery.notifyInserted(value) };
}

/** 九格的档位判据（字面抄自 §2.2 / Q3，不是从实现里算出来的）。 */
const PUSHES: Record<InboxItemKind, boolean> = {
  merge_conflict: true,
  member_failed: true,
  run_orphaned: true,
  run_stalled: true,
  dispatch_skipped: false,
  pr_gate_degraded: true,
  mention_action_required: true,
  decision_required: true,
  comment_attention: false,
};

/* 九个 kind 里 info 的两格（字面抄自 severity 单源）；矩阵用它决定「推 / 不推」。 */
test("SUB.3b｜投递档矩阵：severity 为 info 的两格不推，其余七格各推一条", () => {
  for (const [kind, expected] of Object.entries(PUSHES) as [InboxItemKind, boolean][]) {
    const h = setup({ rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] } });
    h.notify(item(kind));
    assert.equal(
      h.pushes.length,
      expected ? 1 : 0,
      `${kind}：期望${expected ? "推" : "不推"}（档位 = severity 单源派生）`,
    );
    if (expected) {
      assert.deepEqual(
        h.pushes[0],
        {
          target: { workspacePath: "/repo/ZPaPa", workspaceIdentity: WS },
          summary: {
            kind,
            severity: kind === "dispatch_skipped" ? "info" : "attention",
            title: "修复登录",
          },
        },
        `${kind}：推的必须是这条条目的结构化摘要（文档把渲染留给 bots 域）`,
      );
    }
  }
});

/* ---------- 收件人闸（§2.2「订阅是同一产生点的投递/过滤面」+ §2.3 冒泡） ---------- */

test("SUB.3b｜零收件人 ⇒ 零出站：没人关注这条事实时渠道不响", () => {
  const h = setup({ rowsByWorkItem: {} });
  h.notify(item("merge_conflict"));
  assert.equal(h.pushes.length, 0, "订阅面无人 ⇒ 不推（档位为 push 也不推）");
});

test("SUB.3b｜直接订阅 ⇒ 推；仅祖先订阅（冒泡）⇒ 也推（冒泡的唯一可观察面就是渠道推送）", () => {
  const direct = setup({ rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] } });
  direct.notify(item("merge_conflict"));
  assert.equal(direct.pushes.length, 1);

  const bubbled = setup({
    rowsByWorkItem: { [PARENT]: [row(HUMAN)] },
    parents: { [WORK_ITEM]: PARENT, [PARENT]: null },
  });
  bubbled.notify(item("merge_conflict"));
  assert.equal(bubbled.pushes.length, 1, "祖先链上的订阅者 ⇒ 子项的事实也送达");
});

test("SUB.3b｜退订静音 ⇒ 零出站（本项墓碑；祖先 subtree 墓碑静音后代）", () => {
  const selfTombstone = setup({
    rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN, { tombstonedAt: 1, optOutScope: "subtree" })] },
  });
  selfTombstone.notify(item("merge_conflict"));
  assert.equal(selfTombstone.pushes.length, 0, "本项退订 ⇒ 这条事实对该主体静音");

  const ancestorMuted = setup({
    rowsByWorkItem: { [PARENT]: [row(HUMAN, { tombstonedAt: 1, optOutScope: "subtree" })] },
    parents: { [WORK_ITEM]: PARENT, [PARENT]: null },
  });
  ancestorMuted.notify(item("merge_conflict"));
  assert.equal(ancestorMuted.pushes.length, 0, "祖先退订（含后代）⇒ 子项经冒泡的投递也被静音");
});

test("SUB.3b｜静音不越界：祖先 issue 墓碑只退那一条；直接订阅 > 祖先静音", () => {
  const issueScoped = setup({
    rowsByWorkItem: {
      [PARENT]: [row(HUMAN, { tombstonedAt: 1, optOutScope: "issue" }), row(AGENT)],
    },
    parents: { [WORK_ITEM]: PARENT, [PARENT]: null },
  });
  issueScoped.notify(item("merge_conflict"));
  assert.equal(issueScoped.pushes.length, 1, "issue 档只退祖先自己，另一个主体照收");

  const directWins = setup({
    rowsByWorkItem: {
      [WORK_ITEM]: [row(HUMAN)],
      [PARENT]: [row(HUMAN, { tombstonedAt: 1, optOutScope: "subtree" })],
    },
    parents: { [WORK_ITEM]: PARENT, [PARENT]: null },
  });
  directWins.notify(item("merge_conflict"));
  assert.equal(directWins.pushes.length, 1, "对这一条明确订阅过 ⇒ 祖先的静音不生效");
});

test("SUB.3b｜没有工作项的事实（workItemId=null）⇒ 零出站：解析不出收件人就不猜", () => {
  const h = setup({ rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] } });
  h.notify(item("run_orphaned", { workItemId: null }));
  assert.equal(h.pushes.length, 0);
});

/* ---------- 失败语义（§2.4：best-effort + warn-once，不抛、不重试、不污染登记） ---------- */

test("SUB.3b｜port 同步抛 ⇒ 只 warn（不抛、不重试）", () => {
  let attempts = 0;
  const h = setup({
    rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] },
    push: () => {
      attempts += 1;
      throw new Error("channel down");
    },
  });
  h.notify(item("merge_conflict"));
  assert.equal(attempts, 1, "恰试一次：投递不做重试（§7-Q7 不做投递台账）");
  assert.equal(h.warns.length, 1, "失败必须留痕，否则「为什么渠道没响」无从复盘");
  assert.match(String(h.warns[0]![0]), /渠道/);
  assert.match(String((h.warns[0]![1] as Error)?.message), /channel down/);
});

test("SUB.3b｜port 异步拒 ⇒ 同样只 warn（未处理 rejection 会打穿登记路径）", async () => {
  const h = setup({
    rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] },
    push: async () => {
      throw new Error("remote refused");
    },
  });
  h.notify(item("merge_conflict"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.warns.length, 1);
  assert.match(String((h.warns[0]![1] as Error)?.message), /remote refused/);
});

test("SUB.3b｜未接通出站口（缺省装配）⇒ 零出站、零异常", () => {
  const h = setup({ rowsByWorkItem: { [WORK_ITEM]: [row(HUMAN)] }, withPort: false });
  h.notify(item("merge_conflict"));
  assert.equal(h.pushes.length, 0);
  assert.equal(h.warns.length, 0);
});

/* ---------- 挂接点唯一（唯一写收口 `insertIfAbsent` 返回 true 处） ---------- */

test("SUB.3b｜挂接点：真的插入（true）才通知一次；幂等重投（false）不通知", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const pushes: InboxChannelPushParams[] = [];
  const delivered = createInboxChannelDelivery({
    target: { workspacePath: "/repo/ZPaPa", workspaceIdentity: WS },
    readSubscribers: (workItemId) => (workItemId === WORK_ITEM ? [row(HUMAN)] : []),
    readParentId: () => null,
    push: (params) => void pushes.push(params),
    warn: () => undefined,
  });
  const repo = createInboxItemRepo(db, {
    onInserted: (written) => delivered.notifyInserted(written),
  });
  const input = {
    workspaceKey: WS,
    workspacePath: "/repo/ZPaPa",
    kind: "merge_conflict" as const,
    dedupKey: "merge_conflict:wi-1",
    title: "修复登录",
    detail: { parentWorkItemId: WORK_ITEM },
    workItemId: WORK_ITEM,
  };

  assert.equal(repo.insertIfAbsent(input), true);
  assert.equal(pushes.length, 1, "新行 ⇒ 推一条");
  assert.equal(repo.insertIfAbsent(input), false);
  assert.equal(pushes.length, 1, "同事实重投（false）⇒ **不推**（幂等不是新事实）");
});

test("SUB.3b｜挂接点载荷 = 真的落库那一行（id / severity / createdAt 逐格对齐读回值）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const seen: InboxItem[] = [];
  const repo = createInboxItemRepo(db, { onInserted: (written) => void seen.push(written) });
  repo.insertIfAbsent({
    workspaceKey: WS,
    workspacePath: "/repo/ZPaPa",
    kind: "dispatch_skipped",
    dedupKey: "dispatch_skipped:wi-1:archived",
    title: "派发跳过",
    detail: { reason: "archived" },
    workItemId: WORK_ITEM,
  });

  assert.equal(seen.length, 1);
  const stored = repo.get(seen[0]!.id);
  assert.ok(stored, "通知里的 id 必须真的能读回（否则推的是一条不存在的条目）");
  assert.deepEqual(seen[0], stored, "通知的载荷就是落库那一行（含 severity 单源派生的值）");
});

test("SUB.3b｜读口/归档/标已读不触发投递（只有新插入这一处）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const pushes: InboxChannelPushParams[] = [];
  const delivered = createInboxChannelDelivery({
    target: { workspacePath: "/repo/ZPaPa", workspaceIdentity: WS },
    readSubscribers: () => [row(HUMAN)],
    readParentId: () => null,
    push: (params) => void pushes.push(params),
    warn: () => undefined,
  });
  const repo = createInboxItemRepo(db, {
    onInserted: (written) => delivered.notifyInserted(written),
  });
  repo.insertIfAbsent({
    workspaceKey: WS,
    workspacePath: "/repo/ZPaPa",
    kind: "merge_conflict",
    dedupKey: "merge_conflict:wi-1",
    title: "修复登录",
    detail: {},
    workItemId: WORK_ITEM,
  });
  const id = repo.listByWorkspace(WS)[0]!.id;
  repo.listAll();
  repo.listByWorkspace(WS);
  repo.get(id);
  repo.markRead(id);
  repo.archive(id);
  assert.equal(pushes.length, 1, "读口与两列更新都不是「新事实」，不得再推");
});

/* ---------- 装配：runtime 注入 sink（挂接点唯一）、组合根注入出站口 ---------- */

async function setupRuntime(push?: (params: InboxChannelPushParams) => void) {
  const repoRoot = await makeRepo();
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const runtime = await createSquadRuntime({
    db,
    workspacePath: repoRoot,
    workspaceIdentity: WS,
    readExperimentEnabled: () => true,
    ...(push ? { inboxChannelPush: push } : {}),
  });
  return {
    repoRoot,
    runtime,
    cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
  };
}

test("SUB.3b｜装配：runtime 的收件箱写入经唯一挂接点推到注入的出站口（目标 = 绑定 workspace）", async () => {
  const pushes: InboxChannelPushParams[] = [];
  const f = await setupRuntime((params) => void pushes.push(params));
  try {
    f.runtime.subscriberRepo.upsertActive({
      workspaceKey: WS,
      workspacePath: f.repoRoot,
      workItemId: WORK_ITEM,
      subjectType: "human",
      subjectId: "local-user",
      reason: "creator",
    });
    const inserted = f.runtime.inboxItemRepo.insertIfAbsent({
      workspaceKey: WS,
      workspacePath: f.repoRoot,
      kind: "merge_conflict",
      dedupKey: "merge_conflict:wi-1",
      title: "修复登录",
      detail: { parentWorkItemId: WORK_ITEM },
      workItemId: WORK_ITEM,
    });
    assert.equal(inserted, true);
    assert.equal(
      pushes.length,
      1,
      "runtime 的写入链必须真的接上出站口（否则推送整块空转且不报错）",
    );
    assert.deepEqual(pushes[0]!.target, {
      workspacePath: f.repoRoot,
      workspaceIdentity: WS,
    });
    assert.equal(pushes[0]!.summary.kind, "merge_conflict");
    assert.equal(pushes[0]!.summary.severity, "action_required", "severity 来自 repo 单源");
    assert.equal(pushes[0]!.summary.title, "修复登录");
  } finally {
    f.cleanup();
  }
});

test("SUB.3b｜装配：未注入出站口（既有调用方）⇒ 登记照常返回 true、零出站", async () => {
  const f = await setupRuntime();
  try {
    const inserted = f.runtime.inboxItemRepo.insertIfAbsent({
      workspaceKey: WS,
      workspacePath: f.repoRoot,
      kind: "merge_conflict",
      dedupKey: "merge_conflict:wi-1",
      title: "修复登录",
      detail: {},
      workItemId: WORK_ITEM,
    });
    assert.equal(inserted, true, "缺省装配（测试/非 host 调用方）行为与加法前一致");
  } finally {
    f.cleanup();
  }
});

test("SUB.3b｜结构守卫：全仓 repo 构造三分（定义 / 带 sink 写构造 / 不带 sink 读构造）+ 组合根注入各恰一处", () => {
  /* 全仓口径（SUB.V P3-2 扩面）：只数 `squadRuntime.ts` 会把「读面被装上 sink」这类第二构造面漏掉。
     三个构造面 = 定义 1（inboxItemRepo）+ **写**构造 1（squadRuntime，带 sink）+ 读面懒取 1
     （node.ts，服务 list/mark/archive，不带 sink）。第四处 = 某条写入通路可能绕过 sink 静默不推。 */
  const constructionSites = listSourceFiles(SRC_ROOT).flatMap((file) => {
    const source = stripComments(readFileSync(file, "utf8"));
    return [...source.matchAll(/createInboxItemRepo\(/g)].map((match) => ({
      file: relative(SRC_ROOT, file),
      call: callTextAt(source, match.index!),
    }));
  });
  assert.deepEqual(
    constructionSites.map((site) => site.file).sort(),
    ["node.ts", "workitem/inboxItemRepo.ts", "workitem/squadRuntime.ts"],
    "全仓恰三处：定义 + 唯一写构造 + 读面懒取（第四处 = 第二条产生通路可能静默不推）",
  );

  const writeSites = constructionSites.filter((site) => site.call.includes("onInserted:"));
  assert.deepEqual(
    writeSites.map((site) => site.file),
    ["workitem/squadRuntime.ts"],
    "带 sink 的**写**构造恰一处；两个构造点会让其中一条通路静默不推",
  );
  assert.ok(
    /^createInboxItemRepo\(db, \{\s*onInserted:/.test(writeSites[0]!.call),
    "唯一**写**构造点必须把 sink 装进 onInserted（漏装 = 推送整块空转且不报错）",
  );

  const readSite = constructionSites.find((site) => site.file === "node.ts")!;
  assert.ok(
    !readSite.call.includes("onInserted"),
    "读面懒取（list / mark / archive）不得带 sink：读路径不产生新条目，装了会让出站口多一个驱动器",
  );

  const runtimeSource = stripComments(
    readFileSync(resolve(SRC_ROOT, "workitem/squadRuntime.ts"), "utf8"),
  );
  assert.equal(
    [...runtimeSource.matchAll(/createInboxChannelDelivery\(/g)].length,
    1,
    "编排器构造点唯一（每 runtime 一份，绑定该 workspace）",
  );

  const nodeSource = stripComments(readFileSync(resolve(SRC_ROOT, "node.ts"), "utf8"));
  assert.equal([...nodeSource.matchAll(/inboxChannelPush:/g)].length, 1, "组合根恰一处注入出站口");
  assert.equal(
    [...nodeSource.matchAll(/pushInboxChannelSummary\(/g)].length,
    1,
    "组合根恰好一处把出站口绑到 bots 服务（第二处会让两条链路各自演化）",
  );
});

test("SUB.3b｜登记与推送**不耦合**：出站口抛错时 `insertIfAbsent` 仍返回 true 且不抛（变异 M2 的靶子）", () => {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const warns: unknown[][] = [];
  const delivered = createInboxChannelDelivery({
    target: { workspacePath: "/repo/ZPaPa", workspaceIdentity: WS },
    readSubscribers: () => [row(HUMAN)],
    readParentId: () => null,
    push: () => {
      throw new Error("channel down");
    },
    warn: (message, error) => void warns.push([message, error]),
  });
  const repo = createInboxItemRepo(db, {
    onInserted: (written) => delivered.notifyInserted(written),
  });
  const inserted = repo.insertIfAbsent({
    workspaceKey: WS,
    workspacePath: "/repo/ZPaPa",
    kind: "merge_conflict",
    dedupKey: "merge_conflict:wi-1",
    title: "修复登录",
    detail: {},
    workItemId: WORK_ITEM,
  });
  assert.equal(inserted, true, "推送失败不得把一次成功的登记翻转成失败");
  assert.equal(repo.listByWorkspace(WS).length, 1, "行已落库（推送只是副本）");
  assert.equal(warns.length, 1, "失败必须留痕");
});

test("SUB.3b｜渠道链零派发（结构面）：编排模块不含派发 / 生命周期 / 入站面", () => {
  const forbidden = [
    "publishDispatchRequest",
    "planDispatch",
    "openMemberRun",
    "recordLeaderRun",
    "dispatch_requested",
    "squad_runs",
    "comment_dispatch_receipts",
    "handleInboundMessage",
    "parseBotCommand",
  ];
  const chainFiles = ["workitem/inboxChannelDelivery.ts", "bots/messages.ts"];
  for (const name of chainFiles) {
    const code = stripComments(readFileSync(resolve(SRC_ROOT, name), "utf8"));
    for (const token of forbidden) {
      assert.ok(
        !code.includes(token),
        `${name}（去注释）不得出现 ${token}：渠道只读推送没有反向通路（12-11），匿名 token 出现即意味着有人把操作面接进来了`,
      );
    }
  }
  /* 正控：守卫本身必须非空转 —— 同一批 token 在真正的派发面上**应当**出现。
     （否则「找不到」可能只是我们扫错了文件或 token 拼错了，而不是链路真的干净。） */
  const dispatcher = stripComments(
    readFileSync(resolve(SRC_ROOT, "workitem/leaderDispatch.ts"), "utf8"),
  );
  assert.ok(
    forbidden.some((token) => dispatcher.includes(token)),
    "正控失败：派发面上一个 token 都找不到 ⇒ 本守卫扫的是一份空集，结论不可信",
  );
});
