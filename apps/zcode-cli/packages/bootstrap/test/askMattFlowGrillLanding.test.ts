// 「/grill 运行态：slug+目录+笔记落盘」断言（卡 #206/A5）。
//
// 为什么这组用例承重：/grill 是提示词资产——A3 注册的内置命令正文 + 上游 grilling 技能原文
// （bundled MIT 原文，用户裁定「不改 ask-matt 技能文本」）。grilling 原文只讲拷问方法（轮次/前沿/
// 事实与决策分工），没有任何产物约定；「自动 slug 任务 ID（可改确认）」「任务目录即刻创建」
// 「中间结论实时落 design/grill-notes.md」只能由**命令正文**注入，正文因此就是本卡的可执行契约：
// 模型读到什么就落什么，正文漏一节，真实 /grill 就会漏一件产物。
//
// 独立真源：设计稿 `.zcode/askmatt-flow/plans/plan-askmatt-flow.md` §2.2（「grill 启动：主题→
// **自动 slug 任务 ID**（可改）→ `.zcode/<任务ID>/` 即刻建目录；grill 进行中：中间结论**实时落**
// `design/grill-notes.md`」）与卡文 #206（「/grill 启动自动 slug（可改确认）→.zcode/<任务ID>/
// 即刻建（design/ 骨架）→拷问中间结论实时落 design/grill-notes.md」）；落点事实
// `.zcode/<任务ID>/design/grill-notes.md`（deliberation-v2/A-facts.md U7，路径不在用例里复算被测常量）。

import assert from "node:assert/strict";
import test from "node:test";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

test("/grill 展开：主题自动生成 kebab-case slug，展示确认可改、确认前零落盘", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /kebab-case/,
    "slug 生成规范 = kebab-case（卡文「自动 slug 可改」；与任务目录同族）",
  );
  assert.match(
    expanded,
    /topic of this conversation/,
    "slug 来源 = 对话主题（卡文「从对话主题自动生成」）",
  );
  assert.match(expanded, /show it to me/, "生成后必须展示给用户（确认环节，不静默定名）");
  assert.match(expanded, /confirm/i, "必须等用户确认（卡文「可改确认」）");
  assert.match(expanded, /rename/i, "确认环节允许改名（用户原话「自动 slug 可改」）");
  assert.match(
    expanded,
    /nothing is created before I confirm/,
    "确认前零落盘：先定名后建目录（否则改名要搬目录）",
  );
  assert.match(expanded, /重设计认证流程/, "用户参数必须原样保留");
});

// 形态真源：派发要点 2「slug 与任务 ID 命名规范一致（kebab-case；与 D8 迁移的 7 目录命名同族）」
// ——现场实态（`.zcode/askmatt-flow`、`.zcode/devflow`、`.zcode/zcode-ui` 等）即小写词+单连字符。
// 正文必须把「kebab-case」展开成可机械执行的形态（否则模型可能产 `Auth Redesign` / `auth_redesign`
// / `AuthRedesign`——占名与后续 `/to-spec` 路径都会歪）。
test("/grill 展开：slug 形态成文（小写词+单连字符，与项目任务目录同族）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /lowercase words joined by single dashes/,
    "kebab-case 展开为可执行形态（防空格/下划线/大写目录名）",
  );
  assert.match(expanded, /task directories/, "与项目既有任务目录同族（D8 迁移后 7 目录命名常态）");
});

// 回归守卫（本卡改的是既有 /grill 正文——A3 落地形态，风险 = 注入段替换技能主指令）：
// 注入只许追加。grilling 技能的核心句（拷问/轮次/事实与决策分工）必须原样在场，且 Landing
// convention 段落在其后；咬合由突变实证（删核心句 → 红）。技能装载前言（Required skills）
// 不在本文件重复断言（A3 用例已钉死）。
test("/grill 展开：注入不替换技能主指令（轮次/事实与决策分工仍在，且约定追加在后）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 打磨这个想法", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(expanded, /interview me relentlessly/, "拷问主指令保留（A3 正文原句）");
  assert.match(expanded, /design tree in rounds/, "轮次法保留（技能核心：一轮一前沿）");
  assert.match(
    expanded,
    /facts are your job, decisions are mine/,
    "事实/决策分工保留（技能原文核心句；本卡产物约定不得改写它）",
  );
  assert.ok(
    expanded.indexOf("facts are your job") < expanded.indexOf("Landing convention"),
    "注入段在技能主指令之后（先读拷问方法，再读产物约定）",
  );
});

// 落点真源：设计稿 §2.2「`.zcode/<任务ID>/` 即刻建目录」+「中间结论实时落 design/grill-notes.md」；
// 目录实态 `.zcode/<任务ID>/design/`（deliberation-v2/A-facts.md U7 与 §7.2 目录树）。任务 ID 衔接
// 真源：设计稿 §3 旅程「slug 确认（board-x）→ … → /to-spec → plan-board-x.md」（A7 正文已引用
// 「the task directory already agreed in this conversation (for example the `/grill` slug)」——
// /grill 正文必须把「确认后的 slug 就是后续命令要的任务 ID」讲明，否则链断在命名）。
test("/grill 展开：确认后即刻建 .zcode/<task-id>/design/ 骨架（grill-notes.md 占位含三节）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(expanded, /On my confirmation/, "建目录时机 = 用户确认后（不可先建后问）");
  assert.ok(
    expanded.includes(".zcode/<task-id>/design/"),
    "任务目录骨架落点（卡文「.zcode/<任务ID>/ 即刻建（design/ 骨架）」）",
  );
  assert.match(expanded, /immediately/, "确认后即刻创建（卡文「即刻建」）");
  assert.match(
    expanded,
    /before the first round/,
    "第一轮拷问前目录已在（产物先于对话，compact 才有落点）",
  );
  assert.match(
    expanded,
    /task directory id/,
    "确认后的 slug 即任务 ID（后续 /to-spec /to-tickets 同一 ID）",
  );
  assert.match(expanded, /\/to-spec/, "任务 ID 衔接点名 /to-spec（A7 正文按此读回）");
  assert.match(expanded, /\/to-tickets/, "任务 ID 衔接点名 /to-tickets（A8 正文按此读回）");
  assert.ok(
    expanded.includes("design/grill-notes.md"),
    "笔记路径（设计稿 §2.2 落点：design/grill-notes.md）",
  );
  assert.match(expanded, /placeholder/, "notes 先落占位（卡文「grill-notes.md 占位」）");
  for (const section of ["## 已定决策", "## 待定问题", "## 下一步"]) {
    assert.ok(
      expanded.includes(section),
      `占位骨架必须含分节「${section}」（派发要点：分节=已定决策/待定问题/下一步）`,
    );
  }
});

// 实时写纪律真源：设计稿 §2.2「grill 进行中：中间结论**实时落** `design/grill-notes.md`
// （compact/clear 天然免疫）」；卡文 #206 交付面③「notes 实时写」与验收「内容含已定决策」。
// 若正文不教追加节奏，模型会攒到会话末尾一次写——compact/clear 一发生中间结论全丢（A6 的
// 前提在本卡：notes 必须先真实存在）。
test("/grill 展开：中间结论实时追加落 notes（轮次即写、三节语义、不攒末尾）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(expanded, /append/, "写法则 = 追加（笔记随轮次增长，不重写覆盖）");
  assert.match(expanded, /each round/, "节奏 = 每轮（拷问以轮为单元，落盘也以轮为单元）");
  assert.match(expanded, /as soon as it settles/, "时机 = 结论一落定就写（实时，不等下一轮）");
  assert.match(expanded, /never batch/, "禁攒末尾（攒批 = compact/clear 中途丢记录）");
  assert.match(
    expanded,
    /compact/,
    "失效面点名 compact（设计稿：实时落 = compact/clear 天然免疫）",
  );
  assert.match(
    expanded,
    /one line per decision I have settled/,
    "已定决策节语义（验收：内容含已定决策）",
  );
  assert.match(expanded, /frontier questions still open/, "待定问题节语义（= 拷问前沿未决项）");
  assert.match(
    expanded,
    /immediate next action/,
    "下一步节语义（下一轮 /to-spec 等单一动作；A6 续跑据此接手）",
  );
});

// 落点边界真源（#208 三绿评审 F3，编排者登记 #206 派发要点 2「项目根解析+排除面」同构）：
// `.zcode/` 相对看板项目根（持有 `.zcode/board/` 的检出）解析——工作树副本内落盘不是项目任务目录
// （本项目已两次事故类）；notes 落 design/ 的正当性 = 扫描面只读 `plans/`（D1/#214 双规则：
// `.zcode/plans/` + `.zcode/<任务ID>/plans/`；排除面冻结：隐藏子目录/`archive/`/`design/`/
// STALLED）。反向纪律：grill 笔记禁入 `plans/`——非计划文件在面内会被编译器当计划稿发号
// （deliberation-v2/C-red-team.md §5.1 场景 A/B「幽灵卡」，发号后派发 gate 拒发 exit 3）。
test("/grill 展开：落点边界——`.zcode/` 相对看板项目根解析 + notes 在扫描面外（禁入 plans/）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/grill 重设计认证流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/grill 开态必须展开");
  assert.match(
    expanded,
    /board project root/,
    "解析根 = 看板项目根（不是 cwd；相对落盘写进工作树副本 = 任务目录不存在于项目）",
  );
  assert.match(
    expanded,
    /owns `\.zcode\/board\/`/,
    "根判据可机械识别：持有 .zcode/board/ 的检出（与 A7/A8 同款）",
  );
  assert.match(
    expanded,
    /never against the current working directory/,
    "显式排除 cwd 解析（F3：工作树内相对落盘是事故类）",
  );
  assert.match(expanded, /worktree copy/, "显式排除工作树副本落盘（任务目录随工作树回收而丢）");
  assert.match(
    expanded,
    /plan scan surface/,
    "notes 落点语义 = 计划扫描面之外（设计稿 §6 位置分层）",
  );
  assert.match(
    expanded,
    /only reads `plans\/`/,
    "扫描面口径 = 只读 plans/ 目录（design/ 之外的更深层不入面）",
  );
  for (const excluded of ["hidden subdirectories", "`archive/`", "`design/`", "STALLED"]) {
    assert.ok(
      expanded.includes(excluded),
      `排除面必须点名「${excluded}」（D1/D2 扫描面冻结排除，与 A8 同款）`,
    );
  }
  assert.match(
    expanded,
    /never write them under `plans\/`/,
    "反向纪律：笔记禁入 plans/（非计划文件在面内可被当计划稿发号）",
  );
  assert.match(expanded, /ghost card/, "后果点名：幽灵卡（上板但无验收、派发 gate 拒发 exit 3）");
});
