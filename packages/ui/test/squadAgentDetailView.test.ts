import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

/* ④刀 4a（用户 2026-10-06 裁定①：新独立视图）：五个「静默同步点」的守卫——
   探查报告（knife4 §1）证实这些点漏改**不会红**（无既有测试覆盖），本文件补钉。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

test("守卫｜S1+S2：agent-detail 在枚举与全页判据中成对（漏判据 ⇒ 多一层 header/终端面板且不报错）", () => {
  const types = readSource("app-shell/types.ts");
  assert.ok(types.includes('| "agent-detail"'), "枚举必须有 agent-detail");
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  const predicate = shell.slice(
    shell.indexOf("const isFullPageMainView ="),
    shell.indexOf(";", shell.indexOf("const isFullPageMainView =")),
  );
  assert.ok(
    predicate.includes('workspaceMainView === "agent-detail"'),
    "全页判据必须含 agent-detail（静默点：漏掉 = header/终端面板多渲染一层）",
  );
});

test("守卫｜S3：render 链有 agent-detail 分支且渲染详情页组件（漏 ⇒ 落 else 页面不显示）", () => {
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    shell.includes('workspaceMainView === "agent-detail" ? ('),
    "render 链必须有 agent-detail 分支",
  );
  assert.ok(shell.includes("<SquadAgentDetailPage"), "分支必须渲染详情页组件");
  assert.ok(
    shell.indexOf('workspaceMainView === "agent-detail" ? (') <
      shell.indexOf(': workspaceMainView === "squads" ? ('),
    "分支必须在 else 链中（有条件渲染，不是死代码）",
  );
});

test("守卫｜S4：agent-detail 时侧栏「智能体」入口保持高亮（漏 ⇒ 进详情失焦）", () => {
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    shell.includes('workspaceMainView === "agents" || workspaceMainView === "agent-detail"'),
    "侧栏 active 判据须覆盖 agent-detail（详情归属智能体入口）",
  );
});

test("守卫｜S5+S6：返回判据成对——shell 顶栏与 App 键盘导航都把 agent-detail 回列表", () => {
  // 谓词区切片：全文件 includes 会被 render 分支的同串误绿（第 79/80/95 轮同款教训）。
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  const shellBack = shell.slice(
    shell.indexOf("const primaryNavigationBack"),
    shell.indexOf("useCallback", shell.indexOf("const primaryNavigationBack") + 10) + 200,
  );
  assert.ok(
    shellBack.includes('workspaceMainView === "agent-detail"'),
    "shell 顶栏返回判据必须覆盖 agent-detail（静默点）",
  );
  const app = readSource("App.tsx");
  const appBack = app.slice(
    app.indexOf("const handlePrimaryNavigationBack"),
    app.indexOf("useAppKeyboard({"),
  );
  assert.ok(
    appBack.includes('workspaceMainView === "agent-detail"'),
    "App 键盘返回判据必须覆盖 agent-detail（静默点）",
  );
  assert.ok(
    appBack.includes('handleBackFromAgentDetailApp'),
    "App 返回动作必须指向详情返回 handler（该 handler 回智能体列表）",
  );
});

test("守卫｜S7+S8：App 意图态与 props 链完整（agentDetailId → shell → 详情页；onOpenAgentDetail → 列表页）", () => {
  const app = readSource("App.tsx");
  assert.ok(app.includes("const [agentDetailId, setAgentDetailId]"), "App 意图态（id 寻址）");
  assert.ok(app.includes("agentDetailId={agentDetailId}"), "App → shell 透传");
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(shell.includes("agentDetailId={agentDetailId}") || shell.includes("agentId={agentDetailId}"), "shell → 页面透传");
  assert.ok(shell.includes("onOpenAgentDetail={onOpenAgentDetail}"), "shell → 列表页透传");
  const list = readSource("squad/SquadAgentsList.tsx");
  assert.ok(
    list.includes('data-testid="squad-agent-row-open-detail"'),
    "行级透明覆盖按钮（行内已有独立按钮，整行 button 嵌套非法）",
  );
});

test("守卫｜详情页骨架：概览区 + 并展示（resolve 单源）+ i18n 两语齐", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes('data-testid="squad-agent-detail-page"'), "页面 testid");
  assert.ok(page.includes('data-testid="squad-agent-detail-overview"'), "概览区 testid");
  assert.ok(
    page.includes("resolveTeamAgentMaxConcurrentRuns(agent)"),
    "并发展示必须走 resolve 单源（与闸同源，不另写 ?? 6）",
  );
  assert.ok(page.includes("buildAgentPresence("), "presence 复用唯一实现");
  for (const key of [
    "squad.agentDetail.back",
    "squad.agentDetail.noSelection",
    "squad.agentDetail.loading",
    "squad.agentDetail.capacity",
    "squad.agentDetail.open",
  ]) {
    assert.ok(zhCN[key] && enUS[key], `两语缺 ${key}`);
  }
  // capacity 键占位符成对。
  const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  assert.equal(ph(zhCN["squad.agentDetail.capacity"] ?? ""), ph(enUS["squad.agentDetail.capacity"] ?? ""));
});

/* ---------- 4b：三区齐 + DM 直通 + 并发编辑 ---------- */

test("守卫｜4b 三区与 DM：任务表只读过滤、运行历史按页大小分页、DM 复用 startDraft+预填、并发输入 1-16", () => {
  const page = readSource("squad/SquadAgentDetailPage.tsx");
  assert.ok(page.includes('data-testid="squad-agent-detail-tasks"'), "任务表 testid");
  assert.ok(
    page.includes("item.assignee.type === \"agent\" && item.assignee.id === agentId"),
    "任务表按 assignee 过滤（快照前端过滤口径）",
  );
  assert.ok(page.includes('data-testid="squad-agent-detail-runs"'), "运行区 testid");
  /* 欠账 #13（2026-10-07 裁定）：运行历史从「全量 + 前端过滤截断 50」改成**服务面分页**
     （agentId 下推 SQL、游标翻页）。常量随语义改名（页大小，值仍 50），前端不再 slice；
     倒序由服务面的 DESC 口径给出，比较器搬进 `squadRunHistoryViewModel.mergeRunHistoryPages`
     （其逐格用例在同名的分页测试文件里）。 */
  assert.ok(
    /const RUN_HISTORY_PAGE_SIZE = 50;/.test(page) && page.includes("limit: RUN_HISTORY_PAGE_SIZE"),
    "页大小 50（语义 = 一次取多少行，由游标继续）",
  );
  assert.ok(
    page.includes("mergeRunHistoryPages("),
    "「加载更多」的追加走纯函数（按 runId 去重 + 保持倒序）",
  );
  assert.ok(
    page.includes("runSettleReasonMessageId("),
    "结算原因呈现走映射表（码值本地化、非闭集原文原样）",
  );
  assert.ok(
    page.includes('data-testid="squad-agent-detail-start-conversation"'),
    "DM 入口 testid",
  );
  const shell = readSource("app-shell/WorkspaceShellLayout.tsx");
  assert.ok(
    shell.includes("handleStartAgentConversation") &&
      shell.includes("handleStartDraftInWorkspaceInChat(workspaceAbsPath, workspaceIdentity)") &&
      shell.includes("requestComposerTextInsert"),
    "DM 必须复用 startDraft + 预填既有通路（零新通路）",
  );
  assert.ok(
    shell.includes("canStartConversation={") &&
      shell.includes("workspaceReadOnlyReason"),
    "只读 workspace 时 DM 入口隐藏",
  );
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  assert.ok(
    dialog.includes('data-testid="squad-agent-max-concurrent-runs"'),
    "并发输入控件存在",
  );
  // 输入解析：空/非法 = undefined 不提交；合法 1–16 提交。
  assert.ok(
    dialog.includes("if (trimmed === \"\") return undefined;") &&
      dialog.includes("!Number.isInteger(value) || value < 1 || value > 16"),
    "空/非法输入按不提交处理（服务面 schema 是最终闸）",
  );
  // i18n 两语齐 + 计数键占位符成对。
  const ph = (v: string) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
  for (const key of [
    "squad.agentDetail.tasksTitle", "squad.agentDetail.runsTitle",
    "squad.agentDetail.startConversation", "squad.common.maxConcurrentRuns",
  ]) {
    assert.ok(zhCN[key] && enUS[key], `两语缺 ${key}`);
  }
  assert.equal(
    ph(zhCN["squad.agentDetail.runsLoaded"] ?? ""),
    ph(enUS["squad.agentDetail.runsLoaded"] ?? ""),
    "分页计数文案占位符成对",
  );
});
