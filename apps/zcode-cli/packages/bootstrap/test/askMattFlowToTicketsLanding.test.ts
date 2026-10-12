// 「/to-tickets 拆卡衔接发号」断言（卡 #209/A8）。
//
// 为什么这组用例承重：/to-tickets 是提示词资产——A3 注册的内置命令正文 + 上游 to-tickets 技能原文
// （bundled MIT 原文，用户裁定「不改 ask-matt 技能文本」）。技能原文的产物落点是「一文件一票」的
// 默认 tracker 假设（`.scratch/<feature-slug>/issues/<NN>-<slug>.md` 或 GitHub），本项目的真相源是
// 看板计划扫描面（D1 双规则：`.zcode/plans/` + `.zcode/<任务ID>/plans/`）；落点、卡文形态与发号
// 衔接只能由**命令正文**注入，正文因此就是本卡的可执行契约：
//   - 产物 = 计划稿内卡行组（不是 .scratch 下一文件一票），经既有 `--assign` 单写入口发号上板；
//   - 同稿多卡互引：草稿期占位 `> blocked: 等待 …拆卡后补号`，发号后替换为 `> blocked-by: <稳定号>`
//     （--assign 只写号标记、不重写占位；标题引用会被静默拒收并让卡永久掉 frontier——A7 实证）；
//   - 卡文两必填段（交付面全量枚举 + 用户原话引用）是派发门槛（缺段 exit 3），责任行建议写全。
//
// 独立真源：设计稿 `.zcode/askmatt-flow/plans/plan-askmatt-flow.md` §2.2（「to-tickets 产出：卡条目
// +blocked-by → `--assign` 发号上板（既有机制）→ 看板四绿管线接管」）与卡文 #209（「出卡即
// frontier/blocked 正确、编排可见」「经既有 --assign 发号上板」「产物经既有单写入口——产品零板写者」）；
// 形态真源 = 冻结技能仓 `assets/templates/card/card.template.md` 条目形态 + `contracts/markers.md`
// 引用族语法。契约锚：zcode-board 0.5.0 · 契约 v2.5 · schema v2.4（assets/manifest.json；技能仓
// 演进时对照更新）。冻结副本实测证据：`.zcode/board/evidence/T209/`（02-13 号日志）。

import assert from "node:assert/strict";
import test from "node:test";
import { ASK_MATT_FLOW_COMMANDS } from "../src/ask-matt-flow-commands.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

test("/to-tickets 展开：tracker 改指看板扫描面（卡行落任务目录计划稿，非一文件一票）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(
    expanded,
    /plan scan surface/,
    "tracker 口径 = 看板计划扫描面（离线重定向，与 /to-spec 同款；A7 三绿观察 5）",
  );
  assert.doesNotMatch(
    expanded,
    /published to the configured tracker/,
    "不得保留上游「published to the configured tracker」默认口径（会落 .scratch/ 或 GitHub，板上零来料）",
  );
  assert.match(
    expanded,
    /card lines/,
    "产物形态 = 计划稿内卡行组（最小面；上游「一文件一票」形态不入看板扫描面）",
  );
  assert.match(
    expanded,
    /\.zcode\/<task-id>\/plans\//,
    "落点必须在任务目录扫描面内（D1 双规则第二面）",
  );
  assert.match(
    expanded,
    /\.scratch\//,
    "显式点名禁写 .scratch/<feature>/issues/（上游默认落点在扫描面外）",
  );
  assert.match(expanded, /演示流程/, "用户参数必须原样保留");
});

// 同稿多卡互引真源：card.template.md 条目形态 L16「未发号占位用 `> blocked: 等待 …拆卡后补号`，
// 发号后替换」+ markers.md §0/§4「引用位只存只接受稳定号（正整数）」。
// 冻结副本实测（evidence/T209/02-13）：--assign 只写号标记不重写占位（阶段一文件里占位原样）；
// 占位在卡上期间 = external 受阻（可读原因、不在 frontier）；替换为 `> blocked-by: 2` 后成为
// dependency 边（目标完成后回 frontier）；标题引用 = 拒收（blockedBy 缺省）、目标完成也不回
// frontier、--check 仍绿（仅提示级）——替换纪律必须由 /to-tickets 正文教给模型。
test("/to-tickets 展开：同稿多卡互引——草稿占位 + 发号后读回替换（标题禁入引用位）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(
    expanded,
    /> blocked: 等待 <目标> 拆卡后补号/,
    "草稿期占位形态（同稿互引、目标卡尚未发号时占住引用位）",
  );
  assert.match(
    expanded,
    /> blocked-by: <稳定号>/,
    "依赖引用位只认稳定号（markers.md §0：号是身份，标签是排版）",
  );
  assert.match(
    expanded,
    /does NOT\s+rewrite/,
    "必须点破：--assign 不重写占位（冻结副本实测），替换是发号后的显式步骤",
  );
  assert.match(
    expanded,
    /`<!-- zcode-board: no=N -->` markers/,
    "发号后从同文件号标记读回「标题→稳定号」映射（--assign 写回同一文件）",
  );
  assert.match(
    expanded,
    /replace every\s+placeholder/,
    "同稿批量替换指引（一次发号多卡互引，逐处替换而非只改一处）",
  );
  assert.match(
    expanded,
    /Never leave a title in the\s+reference slot/,
    "标题引用禁入引用位（A7 实证：静默拒收、目标完成也不回 frontier、--check 仍绿）",
  );
});

// F3 落点边界真源（#208 三绿评审 R2/R13，编排者登记归 #209）：项目根解析（工作树内相对落盘
// 不入扫描面——本项目已两次事故类）与保留名排除面（隐藏子目录/`archive/`/`design/`/STALLED
// 整任务跳过）必须在正文点名；D1 扫描面规则见 SKILL.md §3.2（`.zcode/*/plans/` 一级、不递归）。
test("/to-tickets 展开：落点边界——`.zcode/` 相对看板项目根解析 + 排除面点名", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(
    expanded,
    /board project root/,
    "解析根 = 看板项目根（不是 cwd；相对落盘写进工作树副本 = 不入扫描面）",
  );
  assert.match(
    expanded,
    /owns `\.zcode\/board\/`/,
    "根判据可机械识别：持有 .zcode/board/ 的检出",
  );
  assert.match(
    expanded,
    /never against the current working directory/,
    "显式排除 cwd 解析（F3：工作树内相对落盘是事故类）",
  );
  for (const excluded of ["`archive/`", "`design/`", "STALLED"]) {
    assert.ok(
      expanded.includes(excluded),
      `排除面必须点名「${excluded}」（D1/D2 扫描面冻结排除：隐藏目录/冷存/设计区/停滞任务）`,
    );
  }
});

// F2 两必填段真源（#208 三绿评审 R7 + F2'，编排者登记归 #209）：卡文模板四段「目标/交付面全量
// 枚举/用户原话引用/验收」+ 责任行（card.template.md）；派发门槛 = MANDATORY_SEGMENTS
// ["交付面全量枚举","用户原话引用"]（build-dispatch-prompt.mjs），缺段 exit 3。
// 冻结副本实测（evidence/T209/14-15）：缺「用户原话引用」→ exit 3 点名缺段；缺「责任」→ exit 0
// （建议写全，但**不是**拒发门槛——F2' 教训：不得把责任写进门槛）。
test("/to-tickets 展开：卡文规范——身份闸 + 卡行模板 + 两必填段门槛（责任建议写）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(expanded, /assignment identity gate/, "必须点名要求「过发号身份闸」");
  assert.match(expanded, /`plan-\*\.md`/, "文件名冻结形态（身份闸①）");
  assert.match(
    expanded,
    /first heading line is the H1 title/,
    "判据用冻结表述「首个标题行（H1 起手）」（--assign 拒发判据②）",
  );
  assert.match(expanded, /dependency order/, "卡按依赖序落稿（blockers first；发号随文档序=随前沿序）");
  assert.match(expanded, /`- \[ \] <title>`/, "卡行模板条目行（- [ ] 标题）");
  for (const label of ["目标:", "交付面全量枚举:", "验收:"]) {
    assert.ok(expanded.includes(label), `卡行模板必须含「${label}」标签行（card.template.md 条目形态）`);
  }
  assert.match(expanded, /at minimum these\s+lines/, "子集声明：三段是「至少」");
  assert.match(
    expanded,
    /`责任:` \(recommended/,
    "责任行 = 建议写全（派发 prompt 读它定角色；缺失实测 exit 0，不得写成拒发门槛——F2'）",
  );
  assert.match(expanded, /The\s+two required sections/, "两必填段必须显式点名（门槛 = 缺段拒发）");
  assert.match(expanded, /用户原话引用:/, "必填段②形态（须带访谈 id + 用户原话原文）");
  assert.match(expanded, /exit 3/, "拒发退出码冻结值（build-dispatch-prompt.mjs）");
  assert.match(expanded, /Never hand-write/, "必须明令禁止手写号标记");
  assert.ok(expanded.includes("<!-- zcode-board: no="), "点名禁止的标记形态（markers.md §1）");
  assert.match(expanded, /`--assign`/, "发号归 --assign（产品零板写者）");
});

// 任务 ID 来源真源：派发要点 #209（tickets 落任务目录与 /to-spec 同构——参数点名 → 会话已定
// 目录 → 问用户）与 A7 用例同款缝级；使用提示可发现性（用户要能按约定传 ID）。
test("/to-tickets 展开：任务 ID 来源成文（参数点名 → 会话已定目录 → 问用户）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(expanded, /arguments below/, "第一来源 = 命令参数（正文消费 $ARGUMENTS）");
  assert.match(
    expanded,
    /already agreed in this conversation/,
    "第二来源 = 会话已定任务目录（/to-spec 刚产出的目录；A7 同款）",
  );
  assert.match(expanded, /ask me for the id/, "都不确定时必须问用户（不静默挑一个）");
});

test("/to-tickets 使用提示点名任务 ID 位（/ 面板可发现性）", () => {
  const command = ASK_MATT_FLOW_COMMANDS.find((candidate) => candidate.name === "to-tickets");
  assert.ok(command, "命令表必须含 to-tickets");
  assert.ok(
    command.argumentHint.includes("task-id"),
    `使用提示要点名任务 ID 位：实际为 ${JSON.stringify(command.argumentHint)}（否则用户无从按约定传 ID）`,
  );
});

// 占位未替换的后果真源（冻结副本实测 evidence/T209/04：占位 = external 受阻、readable 原因、
// 不在 frontier；替换后 = dependency 边可解除）——正文必须把「不替换也掉前沿」教清楚，
// 否则模型可能留下「看着有原因、实际不可派」的草稿收工。
test("/to-tickets 展开：占位未替换的后果成文（卡停在外受阻态、不在前沿）", () => {
  const expanded = resolveZCodeBuiltinPromptCommand("/to-tickets 演示流程", {
    askMattFlowEnabled: true,
  });
  assert.ok(expanded, "/to-tickets 开态必须展开");
  assert.match(
    expanded,
    /stays blocked with a readable reason/,
    "占位未替换 = 卡停在外受阻态（可读原因，实测 external kind）——必须点名",
  );
  assert.match(
    expanded,
    /out of the frontier/,
    "代价成文：未替换的占位同样让卡不在前沿（替换前不可派）",
  );
});
