import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentBuilderDraft } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  AgentBuilderDraftPreview,
  AgentBuilderFailureNotice,
  AgentBuilderPanel,
} from "../src/squad/AgentBuilderPanel.js";
import {
  emptyAgentBuilderSession,
  type AgentBuilderSession,
} from "../src/squad/agentBuilderViewModel.js";

/* AgentBuilder 访谈 UI：**真渲染**（renderToStaticMarkup + 真 ZCodeIntlProvider，zh-CN）钉面板的
   四种形态 + 结构守卫钉页面/表单的接线。

   为什么渲染的是 AgentBuilderPanel 而不是 AgentBuilderDialog：Radix 的 Portal 在服务端渲染下
   不产出标记（`mounted` 仍为 false），壳里的一切都渲染不出来；面板是纯 props，四种形态都能钉住。
   壳自身的接线（标题、徽标、关闭确认、abort）由结构守卫与 view model 用例覆盖。 */

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const readSource = (relativePath: string) => readFileSync(resolve(SRC_DIR, relativePath), "utf8");

const draft: AgentBuilderDraft = {
  name: "周报助手",
  description: "每周五汇总研发进展",
  systemPrompt: "# 角色\n你是周报助手",
  skills: ["wiki", "git"],
  memoryScope: "project",
  permissionMode: "plan",
};

function render(node: ReturnType<typeof createElement>, locale: "zh-CN" | "en-US" = "zh-CN") {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, { initialLocale: locale, children: node }),
  );
}

function renderPanel(session: AgentBuilderSession, answer = "", serviceAvailable = true) {
  return render(
    createElement(AgentBuilderPanel, {
      session,
      answer,
      serviceAvailable,
      onAnswerChange: () => {},
      onSend: () => {},
      onRetry: () => {},
      onStop: () => {},
      onOpenManualForm: () => {},
    }),
  );
}

/** 取某个 testid 的按钮/控件标签（属性级判断用；`[^>]*` 不跨标签结束）。 */
function tagOf(html: string, testId: string, tag = "button"): string {
  return new RegExp(`<${tag}[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0] ?? "";
}

/** 真的 disabled 属性（不是 class 里的 `disabled:opacity-50` 变体）。 */
function isDisabled(tag: string): boolean {
  return / disabled(="")?(?=[ >])/.test(tag);
}

// ---------- ① 首帧：还没有草稿 ----------

test("真渲染｜首帧：空态提示、空草稿卡片、去确认禁用、改为手动创建可用", () => {
  const html = renderPanel(emptyAgentBuilderSession());
  assert.ok(html.includes('data-testid="agent-builder-transcript-empty"'), "空态提示在场");
  assert.ok(html.includes('data-testid="agent-builder-draft-empty"'), "草稿卡片显示「还没有草稿」");
  assert.ok(html.includes('data-testid="agent-builder-input"'), "输入框常驻（入口不藏）");
  assert.ok(html.includes('data-testid="agent-builder-manual"'), "改为手动创建常驻可用");
  // 没有草稿时「去确认」必须禁用（禁用而不是消失：消失会让人以为没有这条路）。
  assert.ok(isDisabled(tagOf(html, "agent-builder-confirm")), "无草稿时去确认禁用");
  assert.equal(
    isDisabled(tagOf(html, "agent-builder-manual")),
    false,
    "无草稿也能改为手动创建（空表单）",
  );
  // 发送按钮在输入为空时禁用。
  assert.ok(isDisabled(tagOf(html, "agent-builder-send")), "空输入不发请求");
});

// ---------- ② 有草稿：预览卡片的事实 ----------

test("真渲染｜草稿预览：名称/描述/提示词摘要与字数/技能/记忆作用域/权限模式都是真文案", () => {
  const html = renderPanel({
    messages: [{ role: "user", content: "帮我建个周报助手" }],
    draft,
    status: "idle",
    failure: null,
  });
  assert.ok(html.includes("周报助手"), "名称");
  assert.ok(html.includes("每周五汇总研发进展"), "一句话描述");
  assert.ok(html.includes("你是周报助手"), "系统提示词摘要");
  // 独立算出的期望值：「# 角色\n你是周报助手」共 11 个字符（不按实现的算法重算）。
  assert.ok(html.includes("系统提示词共 11 字"), "提示词字数按原文长度显示");
  assert.ok(html.includes("wiki、git"), "技能令牌按名单显示");
  assert.ok(html.includes("项目"), "记忆作用域走 squad.common.memoryScope.* 文案");
  assert.ok(html.includes("计划（plan）"), "权限模式走 squad.common.permissionMode.* 文案");
  assert.ok(html.includes("帮我建个周报助手"), "用户消息在转写里");
  // 有草稿 ⇒ 去确认可用。
  assert.equal(isDisabled(tagOf(html, "agent-builder-confirm")), false, "有草稿可去确认");
});

test("真渲染｜草稿未命名时不留空白（显示占位文案）", () => {
  const html = render(
    createElement(AgentBuilderDraftPreview, {
      draft: { ...draft, name: "", description: "" },
    }),
  );
  assert.ok(html.includes("（未命名）"));
});

// ---------- ③ 降级轮 ----------

test("真渲染｜降级轮：回复带「本轮草稿未更新」标注，草稿卡片也标未更新", () => {
  const html = renderPanel({
    messages: [
      { role: "user", content: "面向研发团队" },
      { role: "assistant", content: "我觉得可以先这样。", degraded: true },
    ],
    draft,
    status: "idle",
    failure: null,
  });
  assert.ok(html.includes('data-testid="agent-builder-degraded"'), "回复行标注");
  assert.ok(html.includes('data-testid="agent-builder-draft-stale"'), "草稿卡片标注");
  assert.equal((html.match(/本轮草稿未更新/g) ?? []).length, 2, "两处标注都在（回复行 + 卡片）");
  // 降级轮不显示「重试本轮」（那一轮已有回复）；只有失败/停止后才给。
  assert.equal(html.includes('data-testid="agent-builder-retry"'), false);
});

// ---------- ④ 等待中 / 失败（含模型不可用 → 手动创建） ----------

test("真渲染｜等待中：pending 提示 + 停止按钮，输入与发送禁用（单轮单飞）", () => {
  const html = renderPanel({
    messages: [{ role: "user", content: "面向研发团队" }],
    draft: null,
    status: "pending",
    failure: null,
  });
  assert.ok(html.includes('data-testid="agent-builder-pending"'), "等待提示在场");
  assert.ok(html.includes("停止"), "停止按钮在场");
  const inputTag = /<textarea[^>]*data-testid="agent-builder-input"[^>]*>/.exec(html)?.[0] ?? "";
  assert.ok(inputTag.includes("disabled"), "等待中禁用输入（不会产生第二次在飞请求）");
});

test("真渲染｜模型不可用：两档文案分流 + 重试本轮 + 改为手动创建（带原因，不吞错）", () => {
  const unavailable = renderPanel({
    messages: [{ role: "user", content: "面向研发团队" }],
    draft: null,
    status: "idle",
    failure: { kind: "model-unavailable", message: "没有可用的模型，无法进行访谈。" },
  });
  assert.ok(unavailable.includes("没有可用的模型，请先在设置里选一个模型"), "模型不可用档文案");
  assert.ok(unavailable.includes("没有可用的模型，无法进行访谈。"), "原始原因照带（不吞错）");
  assert.ok(unavailable.includes('data-testid="agent-builder-retry-from-failure"'), "重试本轮在场");
  assert.ok(
    unavailable.includes('data-testid="agent-builder-manual-from-failure"'),
    "改为手动创建在场",
  );

  const failed = render(
    createElement(AgentBuilderFailureNotice, {
      failure: { kind: "request-failed", message: "ECONNRESET" },
      canRetry: true,
      onRetry: () => {},
      onManualCreate: () => {},
    }),
  );
  assert.ok(failed.includes("模型请求失败，可以重试本轮"));
  assert.ok(failed.includes("ECONNRESET"));
});

test("真渲染｜服务缺失：面板给原因（而不是把入口藏掉）", () => {
  const html = renderPanel(emptyAgentBuilderSession(), "", false);
  assert.ok(html.includes('data-testid="agent-builder-service-unavailable"'), "缺服务提示在场");
  assert.ok(html.includes("访谈服务未接上"), "说明具体原因");
  assert.ok(html.includes('data-testid="agent-builder-manual"'), "手动创建仍可用（访谈不阻塞它）");
});

test("真渲染｜停止后：保留的用户消息仍在转写里，并给出「重试本轮」", () => {
  const html = renderPanel({
    messages: [{ role: "user", content: "面向研发团队" }],
    draft: null,
    status: "idle",
    failure: null,
  });
  assert.ok(html.includes("面向研发团队"), "已发出的回答保留在转写里");
  assert.ok(html.includes('data-testid="agent-builder-retry"'), "重发同一条答案的入口在场");
});

test("真渲染｜英文界面：同一面板走英文文案（不是硬编码中文）", () => {
  const html = renderPanel(
    {
      messages: [{ role: "user", content: "hello" }],
      draft,
      status: "idle",
      failure: null,
    },
    "",
    true,
  );
  const english = render(
    createElement(AgentBuilderPanel, {
      session: {
        messages: [{ role: "user", content: "hello" }],
        draft,
        status: "idle",
        failure: null,
      },
      answer: "",
      serviceAvailable: true,
      onAnswerChange: () => {},
      onSend: () => {},
      onRetry: () => {},
      onStop: () => {},
      onOpenManualForm: () => {},
    }),
    "en-US",
  );
  assert.ok(html.includes("改为手动创建"), "中文侧");
  assert.ok(english.includes("Switch to manual"), "英文侧");
  assert.ok(english.includes("Draft preview"), "英文侧标题");
});

// ---------- ⑤ 结构守卫：页面双入口 / 表单预填 / 关闭确认 ----------

test("守卫｜页面动作行是双按钮（手动 + AI 访谈带推荐徽标），且 AI 入口不外接门禁判据", () => {
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(page.includes('data-testid="squad-agents-create"'), "手动创建入口 testid 保留");
  assert.ok(page.includes('data-testid="squad-agents-create-ai"'), "AI 访谈入口 testid");
  assert.ok(
    page.includes('data-testid="squad-agents-create-ai-recommended"'),
    "AI 入口带推荐徽标（对齐 multica chooser 的 recommended）",
  );
  assert.ok(
    page.includes('setDialog({ kind: "interview" })'),
    "AI 入口打开访谈对话框（不是同一个表单的第二态）",
  );
  // 双入口的存在性不得依赖取数成功（与刷新/新建同款：读不通时置灰即可）。
  const aiButtonTag =
    /<Button[^>]*data-testid="squad-agents-create-ai"[^>]*>/.exec(page)?.[0] ?? "";
  assert.ok(aiButtonTag.length > 0, "找得到 AI 入口按钮标签");
  assert.ok(aiButtonTag.includes("disabled={!target}"), "AI 入口禁用条件只有「没有 workspace」");
  assert.equal(
    aiButtonTag.includes("loading"),
    false,
    "AI 入口不受读取中影响（藏/禁入口不得依赖取数成功）",
  );
});

test("守卫｜访谈产物走**同一张表单**：initial 映射 + aiGenerated 标注 + 提交带 ai_builder 留痕", () => {
  const page = readSource("squad/SquadAgentsPage.tsx");
  assert.ok(
    page.includes("agentBuilderDraftToTeamAgentInitial(draft)"),
    "预填必须经草稿映射纯函数（生成边界在那一处）",
  );
  assert.ok(page.includes("<AgentBuilderDialog"), "页面渲染访谈对话框");
  assert.ok(
    page.includes("service={services.agentBuilderService ?? null}"),
    "服务从 accessor 取；缺失时交给面板给原因（不在页面里静默）",
  );
  assert.ok(
    page.includes("aiGenerated: true"),
    "AI 预填的表单标 aiGenerated（系统提示词区挂审阅提示）",
  );
  assert.match(
    page,
    /provenance: \{ source: "ai_builder" as const \}/,
    "访谈产物提交时带 ai_builder 留痕（§5.2 状态所有权表）",
  );
  // provenance 只在 AI 那条路上带：手动创建仍走服务面默认的 manual。
  const submitSection = page.slice(
    page.indexOf("const submitDialog"),
    page.indexOf("\n  return (", page.indexOf("const submitDialog")),
  );
  assert.ok(submitSection.length > 0, "找得到提交回调那一段");
  assert.ok(
    submitSection.includes(
      'dialog.aiGenerated ? { provenance: { source: "ai_builder" as const } } : {}',
    ),
    "留痕必须条件化：手动创建不带 ai_builder",
  );
  assert.ok(submitSection.includes("createTeamAgent("), "提交仍走既有创建路径");
});

test("守卫｜表单只有一处实现：AI 预填复用 initial 通道，不加第二个表单组件", () => {
  const dialog = readSource("squad/SquadCreateDialogs.tsx");
  const initialType = readSource("squad/teamAgentDialogInitial.ts");
  // 初值形状只有一份声明，且表单与草稿映射同读它（字段一改两边同时编译报错）。
  assert.equal(
    (initialType.match(/export interface TeamAgentDialogInitial/g) ?? []).length,
    1,
    "初值形状只有一份声明（另抄一份会与表单字段分叉）",
  );
  assert.ok(dialog.includes('from "./teamAgentDialogInitial.js"'), "表单读同一份初值形状");
  assert.ok(
    readSource("squad/agentBuilderViewModel.ts").includes('from "./teamAgentDialogInitial.js"'),
    "草稿映射读同一份初值形状",
  );
  assert.ok(dialog.includes("aiGenerated"), "表单支持「由 AI 生成，请审阅」标注");
  assert.ok(dialog.includes('data-testid="squad-agent-ai-generated-notice"'), "标注有稳定 testid");
  assert.equal(
    (dialog.match(/function TeamAgentDialog\(/g) ?? []).length,
    1,
    "表单仍然只有一份实现",
  );
  // 标注必须**直接**挂在 aiGenerated 上（写成 `{false && aiGenerated ? (` 之类的死分支也过不了：
  // 本断言要求表达式以 `{aiGenerated ? (` 开头，而不是"文本里出现过 aiGenerated ? ("）。
  assert.match(dialog, /\{aiGenerated \? \(/, "审阅提示由 aiGenerated 直接开关");
  const noticeStart = dialog.indexOf("{aiGenerated ? (");
  const notice = dialog.slice(noticeStart, dialog.indexOf("</Field>", noticeStart));
  assert.ok(!notice.includes("value={"), "标注是纯呈现（不改任何表单值）");
  assert.ok(
    notice.includes("squad.agentBuilder.systemPromptNotice"),
    "标注文案走新子树的键（两语齐）",
  );
});

test("守卫｜关闭前确认 + 单轮单飞 + abort 都接上了（访谈历史只在内存）", () => {
  const shell = readSource("squad/AgentBuilderDialog.tsx");
  assert.ok(shell.includes("requestConfirmation("), "关闭前确认（丢弃内存历史不可恢复）");
  assert.ok(shell.includes("AbortController"), "每轮一个 AbortController");
  assert.ok(shell.includes("abortRef.current?.abort()"), "停止按钮真的 abort");
  assert.match(
    shell,
    /controller\.signal\.aborted[\s\S]{0,120}agentBuilderSessionOnStop/,
    "abort 不是失败：回 idle 而不是挂错误",
  );
  assert.ok(shell.includes("signal: controller.signal"), "信号透传给服务（服务端据此不再产出）");
  assert.ok(shell.includes('data-testid="agent-builder-recommended"'), "面板标题带推荐徽标");
});

// ---------- ⑥ i18n：新子树两语齐 + 占位符成对 ----------

test("i18n：squad.agentBuilder.* 两语键集一致（新增子树不与主树抢键）", () => {
  const prefix = "squad.agentBuilder.";
  const keysWithPrefix = (locale: Record<string, string>) =>
    Object.keys(locale).filter((key) => key.startsWith(prefix));
  const zhKeys = new Set(keysWithPrefix(zhCN));
  const enKeys = new Set(keysWithPrefix(enUS));
  for (const key of zhKeys) assert.ok(enKeys.has(key), `en-US 缺少 ${key}`);
  for (const key of enKeys) assert.ok(zhKeys.has(key), `zh-CN 缺少 ${key}`);
  assert.ok(zhKeys.size >= 25, `squad.agentBuilder.* 只比到 ${zhKeys.size} 条，前缀可能写错了`);
});

test("i18n：新子树的占位符两语一致（{count} 只译一侧会露出原始花括号）", () => {
  const placeholdersOf = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/g)]
      .map((match) => match[1])
      .sort()
      .join(",");
  assert.equal(
    placeholdersOf(zhCN["squad.agentBuilder.draftPromptLength"] ?? ""),
    placeholdersOf(enUS["squad.agentBuilder.draftPromptLength"] ?? ""),
  );
  assert.equal(placeholdersOf(zhCN["squad.agentBuilder.draftPromptLength"] ?? ""), "count");
  // 无占位符的文案不得夹带花括号（渲染时没人传值）。
  for (const key of [
    "squad.agentBuilder.title",
    "squad.agentBuilder.intro",
    "squad.agentBuilder.degradedNotice",
    "squad.agentBuilder.systemPromptNotice",
    "squad.agentBuilder.closeConfirmDescription",
  ]) {
    assert.equal(placeholdersOf(zhCN[key] ?? ""), "", `${key} 不应带占位符`);
    assert.equal(placeholdersOf(enUS[key] ?? ""), "", `${key} 不应带占位符`);
  }
});

test("i18n：面板与表单标注引用的键两语都在（防拼错的静默空白）", () => {
  for (const key of [
    "squad.agentBuilder.title",
    "squad.agentBuilder.recommended",
    "squad.agentBuilder.aiEntry",
    "squad.agentBuilder.manualEntry",
    "squad.agentBuilder.prefillTitle",
    "squad.agentBuilder.systemPromptNotice",
    "squad.agentBuilder.retryTurn",
    "squad.agentBuilder.stop",
    "squad.agentBuilder.send",
    "squad.agentBuilder.confirmDraft",
    "squad.agentBuilder.manualCreate",
    "squad.agentBuilder.draftTitle",
    "squad.agentBuilder.draftEmpty",
    "squad.agentBuilder.draftUnnamed",
    "squad.agentBuilder.degradedNotice",
    "squad.agentBuilder.failureTitle",
    "squad.agentBuilder.failureModelUnavailable",
    "squad.agentBuilder.failureRequestFailed",
    "squad.agentBuilder.serviceUnavailable",
    "squad.agentBuilder.thinking",
    "squad.agentBuilder.emptyHint",
    "squad.agentBuilder.inputPlaceholder",
    "squad.agentBuilder.closeConfirmTitle",
    "squad.agentBuilder.closeConfirmDescription",
    "squad.agentBuilder.closeConfirmDiscard",
    "squad.agentBuilder.you",
    "squad.agentBuilder.assistant",
  ]) {
    assert.ok(zhCN[key], `zh-CN 缺 ${key}`);
    assert.ok(enUS[key], `en-US 缺 ${key}`);
  }
});
