// 「/to-spec 产物落任务目录」断言（卡 #208/A7）。
//
// 为什么这组用例承重：/to-spec 是提示词资产——A3 注册的内置命令正文 + 上游 to-spec 技能原文
// （bundled MIT 原文，用户裁定「不改 ask-matt 技能文本」）。技能原文里的产物落点是它的默认
// issue tracker 假设（.scratch/<feature>/spec.md 或 GitHub），本项目的真相源是看板任务目录；
// 落点与格式只能由**命令正文**注入，正文因此就是本卡的可执行契约：路径必须钉在
// `.zcode/<task-id>/plans/plan-<slug>.md`（D1 扫描面 `.zcode/*/plans/`），格式必须过编译器
// 「发号前身份校验」（文件名 `plan-*.md` + 内容含计划稿特征），否则模型产出的稿要么不入扫描面、
// 要么被 `--assign` 整轮拒发。
//
// 独立真源：设计稿 `.zcode/askmatt-flow/plans/plan-askmatt-flow.md` §2.2
// （「to-spec 产出：<任务ID>/plans/plan-<slug>.md（过发号身份闸格式）」）与卡文 #208
// （「落 <任务ID>/plans/plan-*.md——格式过发号身份闸（卡行模板兼容）」）；不在用例里复算被测常量。

import assert from "node:assert/strict";
import test from "node:test";
import { ASK_MATT_FLOW_COMMANDS } from "../src/ask-matt-flow-commands.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

/** 设计稿 §2.2 的产物落点（命令正文的路径模板形态）。 */
const LANDING_PATH_TEMPLATE = ".zcode/<task-id>/plans/plan-<slug>.md";

test("/to-spec 展开：产物路径钉在 .zcode/<task-id>/plans/plan-<slug>.md（D1 扫描面内）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-spec 快速捕获", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-spec 开态必须展开");
  assert.ok(
    expanded.includes(LANDING_PATH_TEMPLATE),
    `产物落点约定必须含 ${LANDING_PATH_TEMPLATE}（设计稿 §2.2 的「计划稿直落」；` +
      "否则模型会按技能默认假设落 .scratch/ 或 GitHub，板上零来料）",
  );
  assert.match(expanded, /快速捕获/, "用户参数必须原样保留");
});

// 发号身份闸真源：技能仓编译器 `--assign` 的「发号前身份校验」（SKILL.md §3.1 第 119 行）：
// 文件名须匹配冻结形态 `plan-*.md`，内容须含计划稿特征（首个标题行或至少一条可识别任务条目）。
// 卡行模板真源：技能仓 `assets/templates/card/card.template.md`「条目形态」（非 D3 卡文解析）——
// 条目行 `- [ ]` + 段标签行 + 引用族行（`> blocked-by: <稳定号>`；未发号占位 `> blocked: 等待 …拆卡后补号`）。
// 契约锚：zcode-board 0.5.0 · 契约 v2.5 · schema v2.4（assets/manifest.json；技能仓演进时对照更新）。
test("/to-spec 展开：格式过发号身份闸（plan-*.md + 首个标题行 + 卡行模板）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-spec board-x", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-spec 开态必须展开");
  assert.match(expanded, /identity gate/, "必须点名要求「过发号身份闸」（卡文目标句）");
  assert.match(expanded, /`plan-\*\.md`/, "文件名冻结形态（身份闸①：--assign 拒发判据）");
  assert.match(expanded, /first heading line/, "判据用冻结表述「首个标题行」（身份闸②：内容含计划稿特征）");
  assert.doesNotMatch(
    expanded,
    /first line is an H1/,
    "不得回退到「首行即 H1」的偏严表述（冻结判据 = 首个标题行，H1 起手，不锁首行）",
  );
  assert.match(expanded, /H1/, "标题层级要求保留（H1 起手）");
  assert.match(expanded, /`- \[ \] <title>`/, "卡行模板条目行（- [ ] 标题）");
  for (const label of ["目标:", "交付面全量枚举:", "验收:"]) {
    assert.ok(expanded.includes(label), `卡行模板必须含「${label}」标签行（card.template.md 条目形态）`);
  }
  assert.match(expanded, /at minimum these\s+lines/, "子集声明：正文列出的三段是「至少」，不是完整模板");
  for (const required of ["责任:", "用户原话引用:"]) {
    assert.ok(
      expanded.includes(required),
      `完整模板另两段「${required}」必须点名（两必填段 = 派发门槛：缺段拒发，退出码 3）`,
    );
  }
  assert.match(
    expanded,
    /> blocked-by: <稳定号>/,
    "依赖引用位只认稳定号（markers.md §0/§4：blocked-by 只收整数句柄，<ref> 类形态会被拒收）",
  );
  assert.match(
    expanded,
    /> blocked: 等待 <目标> 拆卡后补号/,
    "草稿期占位形态：卡片尚未发号时用 `> blocked: 等待 …拆卡后补号` 占位（card.template.md 条目形态），发号后替换",
  );
});

test("/to-spec 展开：禁手写号标记（发号 = 编译器 --assign 单写入口）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-spec board-x", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-spec 开态必须展开");
  assert.match(expanded, /Never hand-write/, "必须明令禁止手写号标记");
  assert.ok(
    expanded.includes("<!-- zcode-board: no="),
    "点名禁止的标记形态（markers.md §1：不得手写或改动标记）",
  );
  assert.match(expanded, /`--assign`/, "发号归 --assign（产品零板写者的机械口径）");
});

// 任务 ID 来源真源：派发要点 #208「任务 ID 来源（用户 $ARGUMENTS 或提示约定）」。
test("/to-spec 展开：任务 ID 来源成文（参数点名 → 会话已定目录 → 问用户）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-spec board-x", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-spec 开态必须展开");
  assert.match(expanded, /arguments below/, "第一来源 = 命令参数（正文消费 $ARGUMENTS）");
  assert.match(
    expanded,
    /already agreed in this conversation/,
    "第二来源 = 会话已定任务目录（如 /grill slug；A5 落地前的续跑形态）",
  );
  assert.match(expanded, /ask me for the id/, "都不确定时必须问用户（决策归用户，不静默挑一个）");
});

test("/to-spec 使用提示点名任务 ID 位（/ 面板可发现性）", () => {
  const command = ASK_MATT_FLOW_COMMANDS.find((candidate) => candidate.name === "to-spec");
  assert.ok(command, "命令表必须含 to-spec");
  assert.ok(
    command.argumentHint.includes("task-id"),
    `使用提示要点名任务 ID 位：实际为 ${JSON.stringify(command.argumentHint)}（否则用户无从按约定传 ID）`,
  );
});
