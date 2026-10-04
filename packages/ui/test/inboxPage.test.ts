import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { InboxItem, InboxItemKind, InboxItemSeverity } from "@zcode/services";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  INBOX_KIND_MESSAGE_IDS,
  INBOX_SEVERITY_BADGE_CLASSES,
  INBOX_SEVERITY_MESSAGE_IDS,
  inboxItemDetailLine,
  inboxItemSessionId,
  inboxItemSessionTarget,
  inboxItemWorkItemTarget,
  inboxRowActions,
  inboxViewState,
} from "../src/squad/inboxViewModel.js";

/* 「收件箱」一级入口（InboxPage / InboxList）的用例：**纯逻辑 + 结构守卫**（ui 包没有渲染测试
   设施，这是本项目既定做法，见 squadEntryView.test.ts）。分工：
   ① 状态机四格（照 squadSurfaceViewState 的口径去掉"无目标"格：错误必带原因 / 刷新失败不清空）；
   ② 文案表键集（kind = 4 / severity = 3）+ **member_failed 中性断言**（第 34 轮登记的硬约束：
      队员与队长 run 共用同一失败出口，文案不得写「队员」）；
   ③ 次要行（四个 kind + 缺字段跳过 + 全缺 null，绝不出现 `undefined`）；
   ④ 行动作四格（未读未归档 / 已读未归档 / 未读已归档 / 已读已归档）；
   ⑤ 结构守卫：侧栏入口（位置 + 同一个显隐判据）、shell 接线与全页判据、页面服务接线与
      **有意无二次确认**（把"有意为之"钉住，防下一个人当成漏做补上）、归档动作的条件、
      开关真的传进取数。每条都写明变异方式，并在交付报告里逐条实测。
   ⑥（本轮）**穿透**：两个纯函数的目标判据（含 identity 的 C14 反推）+ 全链结构守卫
      （行内两钮各有条件 / 页面 props / shell 的 ensure→activate→主视图 / 聚焦意图
      App→shell→页面→看板、看板消费 + scrollIntoView）。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

/** 期望的键集（用类型注解钉住字面量本身合法；键集断言再钉住"表 = 全集"）。 */
const EXPECTED_KINDS: readonly InboxItemKind[] = [
  "merge_conflict",
  "member_failed",
  "run_orphaned",
  "dispatch_skipped",
];
const EXPECTED_SEVERITIES: readonly InboxItemSeverity[] = ["action_required", "attention", "info"];

/** 造一条收件项（只给纯函数关心的字段）。 */
function inboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: "i1",
    workspaceKey: "ws-key",
    workspacePath: "/w/a",
    kind: "dispatch_skipped",
    severity: "info",
    title: "标题 i1",
    detail: {},
    workItemId: null,
    runId: null,
    createdAt: 1_700_000_000_000,
    readAt: null,
    archivedAt: null,
    ...overrides,
  };
}

const aFailure = {
  tone: "error",
  messageId: "squad.common.operationFailed",
  detail: "boom",
} as const;

// ---------- ① 状态机（与共享机器同口径的四格） ----------

// 无数据 + loading（含首帧）⇒ loading；落定失败 ⇒ error 且**带 detail**；重试进行中优先于旧失败。
// 变异：把 `!failure` 判成 error（首帧不再 loading）⇒ 第二格必红；把 failure 从 error 里丢掉 ⇒ detail 断言红。
test("状态机：无数据 ⇒ loading（含首帧）；落定失败 ⇒ error（**必须带 detail**）", () => {
  assert.deepEqual(
    inboxViewState({ items: null, loading: true, failure: null }),
    { mode: "loading" },
    "正在读取",
  );
  assert.deepEqual(
    inboxViewState({ items: null, loading: false, failure: null }),
    { mode: "loading" },
    "首帧（effect 还没跑）：没有数据也没有失败 ⇒ 最诚实的呈现是「正在读取」，不是空列表",
  );
  const errored = inboxViewState({ items: null, loading: false, failure: aFailure });
  assert.ok(errored.mode === "error", "无数据 + 落定失败 ⇒ 整页错误");
  assert.deepEqual(
    errored.feedback,
    aFailure,
    "错误态必须带原因（含原始 detail）—— 没原因的错误态等于没有错误态",
  );
  assert.equal(errored.feedback.detail, "boom");
  assert.deepEqual(
    inboxViewState({ items: null, loading: true, failure: aFailure }),
    { mode: "loading" },
    "重试进行中优先于旧失败（点「重试」后界面必须真的进入「正在读取」）",
  );
});

// ready + 刷新失败 ⇒ 数据**不清空** + loadFailure 横幅（与 squadSurfaceViewModel 同一条口径）。
// 变异：把失败时 `items` 置空（或直接回 error）⇒ 第三个断言必红。
test("状态机：ready + 刷新失败 ⇒ 数据**不清空** + loadFailure 横幅（同共享机器口径）", () => {
  const items = [inboxItem()];
  assert.deepEqual(
    inboxViewState({ items, loading: false, failure: null }),
    { mode: "ready", items, loadFailure: null },
    "有数据 ⇒ ready（刷新失败之外没有别的失败位）",
  );
  const reloadFailed = inboxViewState({ items, loading: false, failure: aFailure });
  assert.ok(reloadFailed.mode === "ready", "刷新失败不改变 mode（数据还在）");
  assert.deepEqual(
    reloadFailed.items,
    items,
    "刷新失败**不清空**已有数据（清空 = 把一次网络抖动说成「你的收件箱清空了」）",
  );
  assert.deepEqual(
    reloadFailed.loadFailure,
    aFailure,
    "失败转为 ready 之上的横幅（含原因 + 重试）",
  );
});

// ---------- ② 文案表 + 中性断言 ----------

test("文案表：kind 键集 = 4、severity 键集 = 3，且两语齐全", () => {
  assert.deepEqual(
    Object.keys(INBOX_KIND_MESSAGE_IDS).sort(),
    [...EXPECTED_KINDS].sort(),
    "kind 文案表必须穷尽四个 kind（加一个 kind 时这里必须跟着动）",
  );
  assert.deepEqual(
    Object.keys(INBOX_SEVERITY_MESSAGE_IDS).sort(),
    [...EXPECTED_SEVERITIES].sort(),
    "severity 文案表必须穷尽三档",
  );
  for (const kind of EXPECTED_KINDS) {
    const messageId = INBOX_KIND_MESSAGE_IDS[kind];
    assert.equal(messageId, `squad.inbox.kind.${kind}`);
    assert.ok((zhCN[messageId] ?? "").length > 0, `zh 缺 ${messageId}`);
    assert.ok((enUS[messageId] ?? "").length > 0, `en 缺 ${messageId}`);
  }
  for (const severity of EXPECTED_SEVERITIES) {
    const messageId = INBOX_SEVERITY_MESSAGE_IDS[severity];
    assert.equal(messageId, `squad.inbox.severity.${severity}`);
    assert.ok((zhCN[messageId] ?? "").length > 0, `zh 缺 ${messageId}`);
    assert.ok((enUS[messageId] ?? "").length > 0, `en 缺 ${messageId}`);
  }
  // 徽标配色的键集同样穷尽（severity → 语义色 token）。
  assert.deepEqual(
    Object.keys(INBOX_SEVERITY_BADGE_CLASSES).sort(),
    [...EXPECTED_SEVERITIES].sort(),
  );
});

// 第 34 轮登记的硬约束：`member_failed` 对**队长 run** 失败同样使用（两类 run 共用同一失败出口）
// ⇒ 文案必须中性。变异（M5）：中文改成「队员失败」⇒ 本用例两个断言同时红。
test("中性断言：member_failed 不得写成「队员失败」（队长 run 共用同一失败出口）", () => {
  const zh = zhCN["squad.inbox.kind.member_failed"] ?? "";
  assert.ok(zh.includes("运行"), `zh 必须是中性的「运行失败」类词，实际：「${zh}」`);
  assert.ok(!zh.includes("队员"), `zh 不得出现「队员」（队长那条会成为假话），实际：「${zh}」`);
  const en = enUS["squad.inbox.kind.member_failed"] ?? "";
  assert.ok(en.toLowerCase().includes("run"), `en must be neutral, got: ${en}`);
  assert.ok(!en.toLowerCase().includes("member"), `en must not say "member", got: ${en}`);
});

// severity 徽标只用**语义色 token**（spec §11.3：状态只由语义色表达）——不是九色板。
// 变异：把某一档换成 `bg-red-500` ⇒ 第一个断言必红。
test("severity 徽标只用语义色 token（不出现九色板）", () => {
  for (const [severity, className] of Object.entries(INBOX_SEVERITY_BADGE_CLASSES)) {
    assert.ok(
      !/-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d/.test(
        className,
      ),
      `${severity} 用了九色板（状态不靠随手挑的颜色编码）：${className}`,
    );
    assert.ok(
      /(destructive|warning|muted|foreground)/.test(className),
      `${severity} 必须用语义色 token：${className}`,
    );
  }
});

// ---------- ③ 次要行（四个 kind + 缺字段跳过） ----------

test("次要行：四个 kind 各拼一条（字段名以产生点 inboxItemProducers.ts 为准）", () => {
  assert.equal(
    inboxItemDetailLine(
      inboxItem({
        kind: "merge_conflict",
        detail: {
          parentWorkItemId: "w1",
          phase: "member_merge",
          runId: "r1",
          agentId: "a1",
          memberBranch: "feat/a",
          integrationBranch: "feat/integration",
          conflictDetail: "CONFLICT (content): ...",
        },
      }),
    ),
    "feat/a → feat/integration · a1",
    "冲突：分支（谁进不了集成分支）+ agentId；git 原文明细（多行）不塞进一行",
  );
  assert.equal(
    inboxItemDetailLine(
      inboxItem({
        kind: "member_failed",
        detail: {
          workItemId: "w1",
          runId: "r2",
          agentId: "a2",
          branch: "feat/m",
          reason: "队员失败：会话异常退出",
        },
      }),
    ),
    "feat/m · a2 · 队员失败：会话异常退出",
    "失败：分支 + agentId + reason（reason 原文自报是队员还是队长）",
  );
  assert.equal(
    inboxItemDetailLine(
      inboxItem({
        kind: "run_orphaned",
        detail: {
          workItemId: "w1",
          runId: "r3",
          agentId: "a3",
          sessionId: "s3",
          reason: "宿主已消失",
        },
      }),
    ),
    "a3 · s3 · 宿主已消失",
    "孤儿：agentId + sessionId + reason",
  );
  assert.equal(
    inboxItemDetailLine(
      inboxItem({ kind: "dispatch_skipped", detail: { workItemId: "w1", reason: "指派给人" } }),
    ),
    "指派给人",
    "skip：reason 原文（四条 skip 的处置方向就在这句话里）",
  );
});

test("次要行：字段缺一个就跳过一个；全缺 ⇒ null（**绝不渲染 undefined**）", () => {
  // 队长 run 无分支（branch: null，两类 run 共用同一失败出口）⇒ 片段跳过。
  assert.equal(
    inboxItemDetailLine(
      inboxItem({
        kind: "member_failed",
        detail: { branch: null, agentId: "a1", reason: "队长失败：…" },
      }),
    ),
    "a1 · 队长失败：…",
    "branch 为 null 只跳过它自己",
  );
  assert.equal(
    inboxItemDetailLine(inboxItem({ kind: "member_failed", detail: {} })),
    null,
    "全缺 ⇒ null（组件据此不渲染空行，也不会出现 undefined）",
  );
  assert.equal(
    inboxItemDetailLine(
      inboxItem({ kind: "run_orphaned", detail: { agentId: 42, sessionId: "", reason: "r" } }),
    ),
    "r",
    "非字符串 / 空串同样跳过（detail 是 Record<string, unknown>，形状可能坏）",
  );
  // 逐 kind 兜一遍"缺字段"路径：输出里绝不出现 undefined / null 字样。
  const partials = EXPECTED_KINDS.map((kind) =>
    inboxItemDetailLine(inboxItem({ kind, detail: { memberBranch: undefined } })),
  );
  for (const line of partials) {
    assert.ok(line === null || !/undefined/.test(line), `不得渲染 undefined：${String(line)}`);
  }
});

// ---------- ④ 行动作四格 ----------

// 变异（M4）：让已归档行仍给动作（去掉 archivedAt 判断）⇒ 第三、四格必红。
test("行动作四格：未读未归档 / 已读未归档 / 未读已归档 / 已读已归档", () => {
  assert.deepEqual(
    inboxRowActions({ readAt: null, archivedAt: null }),
    { canMarkRead: true, canArchive: true },
    "未读且未归档 ⇒ 两个都 true",
  );
  assert.deepEqual(
    inboxRowActions({ readAt: 123, archivedAt: null }),
    { canMarkRead: false, canArchive: true },
    "已读未归档 ⇒ 只 canArchive（标已读没有第二次可做的）",
  );
  assert.deepEqual(
    inboxRowActions({ readAt: null, archivedAt: 456 }),
    { canMarkRead: false, canArchive: false },
    "已归档（未读）⇒ 都不给：归档行只显示徽标",
  );
  assert.deepEqual(
    inboxRowActions({ readAt: 123, archivedAt: 456 }),
    { canMarkRead: false, canArchive: false },
    "已归档（已读）⇒ 同上；仓库里没有「取消归档」，给了也解决不了问题",
  );
});

// ---------- ⑤ 结构守卫（逐条可变异） ----------

/* 守卫 a：侧栏「收件箱」入口。
   变异（M1：去显隐）：把入口外层的 `{showSquadEntries ? (… ) : null}` 去掉（入口无条件渲染）
   ⇒ 第二个断言（找不到显隐条件）必红；另两条既有守卫的计数（3→4）也会红。 */
test("守卫｜侧栏「收件箱」入口恰一处、在「智能体」之前、挂同一个显隐判据", () => {
  const sidebar = readSource("WorkspaceSidebar.tsx");
  assert.equal(
    (sidebar.match(/inbox-sidebar-open/g) ?? []).length,
    1,
    "收件箱入口按钮只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  const inboxIndex = sidebar.indexOf("inbox-sidebar-open");
  assert.ok(
    inboxIndex < sidebar.indexOf("squad-agents-sidebar-open"),
    "「收件箱」在小队组的**最前**（「智能体」之前 —— multica 顺序：收件箱 → AI 团队）",
  );
  assert.equal(
    (sidebar.match(/showSquadEntries = squadEntryVisible\(settings\)/g) ?? []).length,
    1,
    "显隐判据变量只此一处：给收件箱再造一个判据变量 = 同一语义两处实现",
  );
  // 入口必须真的在**自己的**条件块内：从最近一个条件起点到入口之间不得出现条件闭合。
  const gate = sidebar.lastIndexOf("{showSquadEntries ? (", inboxIndex);
  assert.ok(gate >= 0, "收件箱入口必须挂在 showSquadEntries 的条件里");
  assert.ok(
    !sidebar.slice(gate, inboxIndex).includes(") : null}"),
    "收件箱入口必须在 showSquadEntries 条件块内（条件中途就闭合了 = 入口裸奔）",
  );
  assert.ok(sidebar.includes("workspace.openInbox"), "入口文案键 workspace.openInbox（两语齐全）");
});

/* 守卫 b：主视图接线。变异（M2：全页判据漏 inbox）⇒ 第四个断言必红（该入口会多出一层
   header / 终端面板，且不报错）。 */
test("守卫｜shell 有 inbox 分支且渲染 InboxPage；全页判据含 inbox", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(layout.includes('workspaceMainView === "inbox" ?'), "装饰视图必须有 inbox 分支");
  // 本轮穿透把两条回调传给了页面（`<InboxPage …>`），故只钉"渲染了它"这件事。
  assert.ok(layout.includes("<InboxPage"), "inbox 分支必须渲染 InboxPage");
  assert.ok(layout.includes("<InboxPage\n"), "InboxPage 必须接上穿透回调（多行 props）");
  assert.ok(layout.includes('scope="inbox-page"'), "收件箱页要有独立的 ScopedErrorBoundary scope");
  assert.ok(layout.includes("workspace.openInbox"), "面包屑 sectionLabel 用 workspace.openInbox");
  const predicate = layout.slice(
    layout.indexOf("const isFullPageMainView ="),
    layout.indexOf("const shouldRenderMainViewHeader ="),
  );
  assert.ok(
    predicate.includes('workspaceMainView === "inbox"'),
    "全页视图判据漏了 inbox（漏一个 = 该入口多一层 header 或终端面板，且不报错）",
  );
  assert.ok(
    layout.includes('inboxActive={workspaceMainView === "inbox"}'),
    "侧栏入口的高亮态由同一个主视图判据给出",
  );
  assert.ok(layout.includes("onOpenInbox={handleOpenInbox}"), "侧栏的打开回调必须接线到 shell");
});

/* 守卫 c：页面服务接线 + **有意无二次确认** + 跨项目（不取 workspace 目标）。
   变异（加回确认）：给归档包一层 requestConfirmation ⇒ 第二个断言必红 ——
   这条守卫把"有意为之"钉住，防下一个人当成漏做补上。 */
test("守卫｜InboxPage 走响亮取数通路，三个服务调用齐全，且**无**二次确认（有意为之）", () => {
  const page = readSource("squad/InboxPage.tsx");
  assert.ok(page.includes("resolveSquadRuntimeService("), "取数必须经 resolveSquadRuntimeService");
  assert.ok(
    !page.includes("services.squadRuntimeService"),
    "页面不得直接读 services.squadRuntimeService（那条路会把「服务没接上」静默成 undefined）",
  );
  assert.ok(
    !page.includes("requestConfirmation"),
    "归档 / 标已读本轮**有意**不弹二次确认（理由见 InboxPage 文件头注：归档可再用开关取回、是收件箱主用法、服务面无取消归档）",
  );
  for (const call of ["listInboxItems(", "markInboxItemRead(", "archiveInboxItem("]) {
    assert.ok(page.includes(call), `页面必须接上 ${call}（缺一个就是缺一件功能）`);
  }
  assert.ok(
    !page.includes("squadWorkspaceTarget("),
    "收件箱是**跨项目**面：不得求 workspace 目标（服务面 listInboxItems 也没有目标参数）",
  );
  assert.ok(
    page.includes("squadEntryVisible("),
    "实验关闭横幅复用呈现判据 squadEntryVisible（同一份语义；这是呈现，不是门禁）",
  );
  assert.ok(
    page.includes("squad.inbox.experimentOff"),
    "横幅文案是自己的键（不复用 squad.common.experimentOff）",
  );
  // 测试锚点（后续 e2e 依赖；顺手钉住防被误删）。
  for (const testid of [
    'data-testid="inbox-page"',
    'data-testid="inbox-refresh"',
    'data-testid="inbox-show-archived"',
  ]) {
    assert.ok(page.includes(testid), `${testid} 不得改名`);
  }
});

/* 守卫 d：行内动作由纯函数给出、归档按钮挂在条件里、归档行仍有留痕。
   变异（无条件渲染归档按钮）⇒ 第三个断言必红。 */
test("守卫｜行内动作走纯函数 inboxRowActions；归档 / 标已读按钮各在其条件内", () => {
  const list = readSource("squad/InboxList.tsx");
  assert.ok(list.includes("inboxRowActions("), "行动作判据必须走纯函数（不给已归档行动作）");
  const archiveGate = list.indexOf("{actions.canArchive ? (");
  const archiveButton = list.indexOf('data-testid="inbox-archive"');
  assert.ok(archiveGate >= 0, "必须有 canArchive 条件分支");
  assert.ok(archiveButton > archiveGate, "归档按钮必须在 canArchive 条件下（不得无条件渲染）");
  const markReadGate = list.indexOf("{actions.canMarkRead ? (");
  const markReadButton = list.indexOf('data-testid="inbox-mark-read"');
  assert.ok(
    markReadGate >= 0 && markReadButton > markReadGate,
    "标已读按钮必须在 canMarkRead 条件下",
  );
  assert.ok(list.includes("data-inbox-id"), "行上要有 data-inbox-id（锚点）");
  assert.ok(list.includes("squad.common.archived"), "已归档徽标复用既有键 squad.common.archived");
  assert.ok(list.includes("inboxItemDetailLine("), "次要行必须走纯函数 inboxItemDetailLine");
  assert.ok(list.includes("formatTaskRelativeTime("), "相对时间复用既有 formatTaskRelativeTime");
  assert.ok(list.includes("item.workspacePath"), "行上要显示所属项目（workspacePath，跨项目面）");
});

/* 守卫 e：开关真的传进取数。变异：把 `{ includeArchived }` 从调用里去掉（改成前端过滤）⇒
   第一个断言必红。 */
test("守卫｜「显示已归档」开关真的传进取数（includeArchived 出现在请求里）", () => {
  const page = readSource("squad/InboxPage.tsx");
  assert.match(
    page,
    /listInboxItems\(\{[^}]*includeArchived/,
    "开关必须作为取数参数传进 listInboxItems（前端过滤会让「归档里还有多少条」永远读不到）",
  );
  assert.ok(
    page.includes("aria-pressed={includeArchived}"),
    "按下态用 aria-pressed（照侧栏入口的既有手法）",
  );
});

// ---------- ⑥ 穿透（本轮：把"只读的死信"接上「看到 → 处理」的闭环） ----------

// 会话 id 读法四格：只有**非空字符串**才算有会话；null / 缺失 / 非字符串（含空串）一律 null。
// 边界来源：`sessionId` 是本轮才补进 member_failed 的键，此前产生的条目没有它 ⇒ 必须按缺失降级。
// 变异：把非字符串也返回（不判 typeof）⇒ 第三、四格必红。
test("穿透｜inboxItemSessionId：非空字符串才返回；null / 缺失 / 非字符串一律 null", () => {
  assert.equal(
    inboxItemSessionId(inboxItem({ detail: { sessionId: "sess-1" } })),
    "sess-1",
    "非空字符串 ⇒ 返回它（「打开会话」的唯一来源）",
  );
  assert.equal(
    inboxItemSessionId(inboxItem({ detail: { sessionId: null } })),
    null,
    "null（run_orphaned 的既有关卡：未绑会话）⇒ 不给会话钮",
  );
  assert.equal(
    inboxItemSessionId(inboxItem({ detail: { runId: "r1" } })),
    null,
    "键缺失（本轮之前的 member_failed 旧行）⇒ 同样不给钮，不报错",
  );
  assert.equal(
    inboxItemSessionId(inboxItem({ detail: { sessionId: 42 } })),
    null,
    "非字符串坏形状 ⇒ null（detail 是 Record<string, unknown>，不猜）",
  );
  assert.equal(inboxItemSessionId(inboxItem({ detail: { sessionId: "" } })), null, "空串 ≠ 有会话");
});

// 工项目标两格 + identity 的 C14 反推（`resolveWorkspaceKey`：identity 非空优先、否则 path）：
// key === path ⇒ 条目没带 identity ⇒ 只给 path（**不得**拿 path 当 identity）；
// key ≠ path ⇒ key 就是（trim 后的）identity ⇒ 按 identity 带上。
// 变异：恒带上 `workspaceIdentity: item.workspaceKey`（把 key 当 identity 用）⇒ 第一格必红。
test("穿透｜inboxItemWorkItemTarget：workItemId 非空才给；identity 按 C14 反推（不拿 key 冒充）", () => {
  assert.deepEqual(
    inboxItemWorkItemTarget(
      inboxItem({ workItemId: "wi-1", workspacePath: "/w/a", workspaceKey: "/w/a" }),
    ),
    { workspacePath: "/w/a", workItemId: "wi-1" },
    "key === path ⇒ 条目没带 identity：只给 path（deepEqual 钉住连键都没有）",
  );
  assert.deepEqual(
    inboxItemWorkItemTarget(
      inboxItem({
        workItemId: "wi-1",
        workspacePath: "/home/u/p",
        workspaceKey: "remote:ssh:host:22:u:/home/u/p",
      }),
    ),
    {
      workspacePath: "/home/u/p",
      workspaceIdentity: "remote:ssh:host:22:u:/home/u/p",
      workItemId: "wi-1",
    },
    "key ≠ path ⇒ key 就是（trim 后的）identity：跨端 tab 匹配要靠它",
  );
  assert.equal(
    inboxItemWorkItemTarget(inboxItem({ workItemId: null })),
    null,
    "没有 workItemId ⇒ 不给钮（不猜去哪条）",
  );
  assert.equal(
    inboxItemWorkItemTarget(inboxItem({ workItemId: "" })),
    null,
    "空串同样不给（坏形状一律 null）",
  );
  assert.equal(
    inboxItemWorkItemTarget(inboxItem({ workItemId: "wi-1", workspacePath: "" })),
    null,
    "workspacePath 为空 ⇒ 没有项目可去，不给钮",
  );
});

// 会话目标的判据收在一处：会话 id 与项目坐标**都**推得出才给 —— 只按 sessionId 渲染、
// 到点击时才拼坐标会让拼不出的那条变成**死钮**。变异：不看 sessionId 直接给目标 ⇒ 第二格红。
test("穿透｜inboxItemSessionTarget：会话 id 与项目坐标都推得出才给（不给死钮）", () => {
  assert.deepEqual(
    inboxItemSessionTarget(
      inboxItem({ detail: { sessionId: "s1" }, workspacePath: "/w/a", workspaceKey: "/w/a" }),
    ),
    { workspacePath: "/w/a", sessionId: "s1" },
    "两样齐全 ⇒ 目标（三样：path / identity? / 目标 id）",
  );
  assert.equal(
    inboxItemSessionTarget(inboxItem({ detail: {} })),
    null,
    "本轮之前的 member_failed 旧行（无 sessionId）⇒ 不给目标 = 界面不给钮",
  );
  assert.equal(
    inboxItemSessionTarget(
      inboxItem({ detail: { sessionId: "s1" }, workspacePath: "", workspaceKey: "" }),
    ),
    null,
    "坐标坏（空 path）⇒ 同样不给（不造死钮）",
  );
});

/* 守卫 f：行内两钮 —— 各只一处、各有条件、判据走纯函数。
   变异（M2：无条件渲染会话钮）⇒ 把 `{sessionTarget ? (` 条件去掉 ⇒ 第二个断言（门位置）必红；
   两钮与 `inboxRowActions` 正交（读了 ≠ 处理完）⇒ 条件文本里不得出现 `actions.`。 */
test("守卫｜行内穿透钮：各只一处且各有条件（已读/已归档行同样留着去处）", () => {
  const list = readSource("squad/InboxList.tsx");
  assert.equal(
    (list.match(/data-testid="inbox-open-work-item"/g) ?? []).length,
    1,
    "「打开工作项」只该有一处（为别的形态另抄一份 = 同一语义两处实现）",
  );
  assert.equal(
    (list.match(/data-testid="inbox-open-session"/g) ?? []).length,
    1,
    "「打开会话」只该有一处",
  );

  const workItemGate = list.indexOf("{workItemTarget ? (");
  const workItemButton = list.indexOf('data-testid="inbox-open-work-item"');
  assert.ok(workItemGate >= 0, "「打开工作项」必须有条件分支（无条件渲染 = 坏形状条目也点得动）");
  assert.ok(workItemButton > workItemGate, "按钮必须在条件块内");
  assert.ok(
    !list.slice(workItemGate, workItemButton).includes(") : null}"),
    "条件中途就闭合了 = 按钮裸奔",
  );

  const sessionGate = list.indexOf("{sessionTarget ? (");
  const sessionButton = list.indexOf('data-testid="inbox-open-session"');
  assert.ok(sessionGate >= 0, "「打开会话」必须有条件分支（缺 sessionId 的旧行不给钮）");
  assert.ok(sessionButton > sessionGate, "按钮必须在条件块内");
  assert.ok(
    !list.slice(sessionGate, sessionButton).includes(") : null}"),
    "条件中途就闭合了 = 按钮裸奔",
  );

  assert.ok(
    list.includes("inboxItemWorkItemTarget(item)") && list.includes("inboxItemSessionTarget(item)"),
    "两个判据必须走纯函数（本层不拼 target、不判 identity）",
  );
  // 穿透钮与行状态正交：读了不等于处理完，归档行也留着去处 —— 条件里不得引用行状态的动作表。
  assert.ok(
    !list.slice(workItemGate, workItemButton).includes("actions."),
    "穿透钮不得挂进行状态判据（inboxRowActions 只管标已读 / 归档）",
  );
  assert.ok(
    !list.slice(sessionGate, sessionButton).includes("actions."),
    "同上：已读 / 已归档行照样给「打开会话」",
  );
});

/* 守卫 g：页面的两个穿透 props —— 必填（可选会留下"按钮在、点了没反应"的静默路径）、
   原样透传给列表（**不在穿透前塞一次自动标已读** —— 那是替用户做决定，见 InboxPage 文件头注）。
   变异：把 `onOpenWorkItem={onOpenWorkItem}` 改成包一层先 markRead ⇒ 第二个断言必红。 */
test("守卫｜InboxPage 的两个穿透 props：必填且原样透传（点击不自动标已读）", () => {
  const page = readSource("squad/InboxPage.tsx");
  assert.ok(
    page.includes("onOpenWorkItem: (target: InboxWorkItemTarget) => void;"),
    "onOpenWorkItem 必须必填（可选 = 静默吞点击）",
  );
  assert.ok(
    page.includes("onOpenSession: (target: InboxSessionTarget) => void;"),
    "onOpenSession 同样必填",
  );
  assert.ok(!page.includes("onOpenWorkItem?:"), "不得退化成可选");
  assert.ok(!page.includes("onOpenSession?:"), "不得退化成可选");
  assert.ok(
    page.includes("onOpenWorkItem={onOpenWorkItem}") &&
      page.includes("onOpenSession={onOpenSession}"),
    "两个回调必须原样透传给列表（包一层 = 偷偷标已读 / 改语义）",
  );
  assert.ok(
    !page.includes("requestConfirmation"),
    "穿透同样**有意**无二次确认（与归档 / 标已读同一条纪律）",
  );
});

/* 守卫 h：shell 的「打开工作项」路径 —— ensure（不存在就建）→ activate（false ⇒ 响亮）→
   切主视图（次序：先激活 tab 才保证主视图翻过去时目标项目已在窗前）。
   变异（M3：「打开工作项」只切主视图，去掉 ensure/activate）⇒ 前三个断言必红。 */
test("守卫｜shell「打开工作项」：ensure → activate → 主视图；失败响亮不静默", () => {
  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  const handlerAt = layout.indexOf("const handleOpenInboxWorkItem");
  assert.ok(handlerAt >= 0, "shell 必须有「打开工作项」处理（页面注入的通路）");
  const ensureAt = layout.indexOf("ensureWorkspaceTab(target.workspacePath", handlerAt);
  const activateAt = layout.indexOf("activateTabByPath(target.workspacePath", handlerAt);
  const viewAt = layout.indexOf('onWorkspaceMainViewChange("work-items")', handlerAt);
  assert.ok(
    ensureAt > handlerAt,
    "必须先 ensureWorkspaceTab（收件箱是跨项目面：目标项目可能没打开）",
  );
  assert.ok(activateAt > ensureAt, "再 activateTabByPath（激活失败不许静默 —— 既有坑）");
  assert.ok(viewAt > activateAt, "最后才切主视图（次序反了会先用旧项目渲染一帧工作项页）");
  const gate = layout.slice(handlerAt, viewAt);
  assert.ok(gate.includes("squad.inbox.openFailed"), "activate 失败要有可见归宿（toast 文案键）");
  assert.ok(gate.includes("logger.error"), "activate 失败要留痕（响亮，不静默）");
  assert.ok(
    gate.includes("if (!tabStoreApi.getState().activateTabByPath("),
    "失败分支必须先判返回值",
  );

  // 「打开会话」：目标三样（path / identity / sessionId）原样进既有 handleSelectTaskInChat。
  const inboxAt = layout.indexOf("onOpenWorkItem={handleOpenInboxWorkItem}");
  assert.ok(inboxAt >= 0, "InboxPage 必须接线「打开工作项」");
  const sessionAt = layout.indexOf("onOpenSession={(target) =>", inboxAt);
  assert.ok(sessionAt > inboxAt, "InboxPage 必须接线「打开会话」");
  const sessionWiring = layout.slice(sessionAt, sessionAt + 400);
  assert.ok(sessionWiring.includes("handleSelectTaskInChat("), "会话穿透走 shell 既有通路");
  assert.ok(sessionWiring.includes("target.sessionId"), "会话目标带 sessionId");
  assert.ok(
    sessionWiring.includes("target.workspacePath") &&
      sessionWiring.includes("target.workspaceIdentity"),
    "会话目标带 workspacePath / workspaceIdentity（跨项目坐标不丢）",
  );
});

/* 守卫 i：聚焦意图**全链**（照 openAutomationId 的先例）：
   App 持意图 → shell 在导航成功后设它并透传给工作项页 → 页面透传给看板 → **看板消费后清掉**。
   变异（M4：看板不调 onFocusConsumed）⇒ 第四个断言（消费是 effect 的最后一步）必红 ——
   不消费的表现是"每次回到这一页都再聚焦一次"，且不报错。 */
test("守卫｜聚焦意图全链 App → shell → 页面 → 看板（看过即消费，不留悬挂意图）", () => {
  const app = readSource("App.tsx");
  assert.ok(
    app.includes(
      "const [inboxFocusWorkItemId, setInboxFocusWorkItemId] = useState<string | null>(null)",
    ),
    "意图状态在 App（跨页面存活；放页面里会被主视图切换卸载顺手清掉）",
  );
  assert.ok(app.includes("inboxFocusWorkItemId={inboxFocusWorkItemId}"), "意图传给 shell");
  assert.ok(app.includes("onInboxFocusRequest={handleInboxFocusRequest}"), "设置口传给 shell");
  assert.ok(app.includes("onInboxFocusConsumed={handleInboxFocusConsumed}"), "消费口传给 shell");

  const layout = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    layout.includes("onInboxFocusRequest(target.workItemId)"),
    "shell 在导航**成功后**才设意图（失败路径提前 return）",
  );
  assert.ok(layout.includes("focusWorkItemId={inboxFocusWorkItemId}"), "shell 把意图交给工作项页");
  assert.ok(layout.includes("onFocusConsumed={onInboxFocusConsumed}"), "消费回调同样传下去");

  const page = readSource("squad/WorkItemsPage.tsx");
  assert.ok(page.includes("focusWorkItemId={focusWorkItemId}"), "页面透传意图给看板");
  assert.ok(
    page.includes("onFocusConsumed={onFocusConsumed}"),
    "页面透传消费回调给看板（消费点在看板：只有那里拿着渲染后的行）",
  );

  const board = readSource("squad/WorkItemsBoard.tsx");
  assert.ok(
    board.includes('scrollIntoView({ block: "nearest" })'),
    "看板把目标行滚进视野（最小距离）",
  );
  assert.ok(board.includes("ring-brand"), "高亮用语义色 token（brand 环，不引九色板）");
  const consumeAt = board.indexOf("onFocusConsumed?.()");
  assert.ok(consumeAt >= 0, "看板必须消费聚焦意图（清掉后壳才不会再聚焦）");
  const focusEffectStart = board.indexOf("if (!focusWorkItemId) return;");
  const focusEffectEnd = board.indexOf("}, [focusWorkItemId", focusEffectStart);
  assert.ok(focusEffectStart >= 0 && focusEffectEnd > focusEffectStart, "聚焦消费必须在 effect 里");
  const focusEffect = board.slice(focusEffectStart, focusEffectEnd);
  assert.ok(
    focusEffect.includes("scrollIntoView("),
    "聚焦动作（滚动 + 高亮）与消费在同一处：只滚不消费 = 每次回来再滚一次",
  );
  assert.match(
    focusEffect,
    /onFocusConsumed\?\.\(\);\s*$/,
    "消费是 effect 的**最后一步**：目标不在列表（父项被归档等）也走到它 —— 不留悬挂意图，也不报错",
  );
});

// 三键两语齐全（穿透的可见文案；`openFailed` 是导航失败的响亮归宿）。
test("穿透文案三键两语齐全", () => {
  for (const id of [
    "squad.inbox.openWorkItem",
    "squad.inbox.openSession",
    "squad.inbox.openFailed",
  ]) {
    assert.ok((zhCN[id] ?? "").length > 0, `zh 缺 ${id}`);
    assert.ok((enUS[id] ?? "").length > 0, `en 缺 ${id}`);
  }
});
