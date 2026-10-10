#!/usr/bin/env node
/**
 * zcode-board / #119（B6-1）卡模板两必填段 + 约束块拼装 · #120（B6-2）必填段校验拒发
 *              · #121（B6-3）卡类型判定 + 需齐绿清单 · 场景断言脚本（红→绿，测试先行）
 *
 * 覆盖（卡文 `.zcode/plans/plan-boardv2-b2.md` B6-1 交付面 ①–④；E1 V6/V14/V15/V16；
 *       B6-2 交付面 ①–②；E1 V7）：
 *   切片 1  卡模板文件内容契约：两必填段（交付面全量枚举 / 用户原话引用）+ 验收句式要求
 *           （“用户看到/点到什么”）+ 拆粒度不砍范围（E1 V16 / 裁决③）+ 原话引文要求（E1 V14/V15）
 *   切片 2  示例卡正/反例对照：正例含全段；反例恰缺「交付面全量枚举」字段（缺段形态，供校验对照）
 *   切片 3  约束块拼装：constraint-block.md（dispatch-checklist 摘要，自包含）存在且段面齐备；
 *           build-dispatch-prompt.mjs 对真实形态卡抽条目并拼装 prompt 骨架——输出含两必填段随文、
 *           约束块全文、绝对证据路径、角色与绿数、只读边界；段检出信息走 stderr
 *   切片 4  错误面与缺段拒发（#120/B6-2，E1 V7）：缺任一段默认拒发（退出码 3、点名缺哪段、
 *           不产出任何 prompt）；齐段放行；--allow-partial 显式放行调试口；
 *           非绝对证据路径/卡未找到 → 非零退出点名。
 *           ※ 规格变更（#120/B6-2）：原 B6-1「缺段只点名不拒发（退出码 0）」断言随动为
 *             「默认拒发退出码 3」——拒发语义由 B6-1 文件头显式推迟给 #120，本卡兑现。
 *   切片 5  确定性（双跑逐字节一致）、--constraints 覆盖生效、多卡条目抽取边界（止于下一卡）、
 *           源文件零改写（sha256 前后一致）
 *   切片 6  卡类型判定 + 需齐绿清单（#121/B6-3，E1 V9）：从卡文启发式判定 UI/断言/hook/文档/代码
 *           卡（判定显式输出判定依据，不猜死）；「角色与绿数」节按类型生成需齐绿清单——
 *           UI 卡 = 三绿 + 第四绿（ui-designer）+ 浏览器断言；断言卡 = 突变/反例证据；
 *           hook 卡 = run-t13 场景 + 信任评审注记；文档卡 = 纯 md 注记；代码卡 = 等级绿。
 *           --type 显式覆盖（仍输出启发式原判）；--level 标注正式/跟进/微卡；清单随 --out 留痕。
 *
 * 用法：
 *   node assets/test/run-t119-card-template.mjs
 * 退出码：0 = 全部通过；1 = 有失败。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { newRoot, removeRoot, w } from "./fixtures/build-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const CARD_DIR = join(ASSETS, "templates", "card");
const TOOL = join(ASSETS, "tools", "build-dispatch-prompt.mjs");

const TEMPLATE = join(CARD_DIR, "card.template.md");
const PASS_EXAMPLE = join(CARD_DIR, "card.example-pass.md");
const FAIL_EXAMPLE = join(CARD_DIR, "card.example-fail.md");
const CONSTRAINT_BLOCK = join(CARD_DIR, "constraint-block.md");

// ---------------------------------------------------------------- 输出工具

const lines = [];
function say(s = "") {
  lines.push(s);
  console.log(s);
}

let passCount = 0;
let failCount = 0;

function pass(msg) {
  passCount += 1;
  say(`PASS  ${msg}`);
}

function fail(msg, detail = "") {
  failCount += 1;
  say(`FAIL  ${msg}${detail ? ` ｜ ${detail}` : ""}`);
}

class Checks {
  constructor(tag) {
    this.tag = tag;
  }
  ok(cond, label, detail = "") {
    if (cond) pass(`[${this.tag}] ${label}`);
    else fail(`[${this.tag}] ${label}`, detail);
  }
  eq(actual, expected, label, detail = "") {
    this.ok(actual === expected, label, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}${detail ? `；${detail}` : ""}`);
  }
  inc(text, needle, label) {
    this.ok(typeof text === "string" && text.includes(needle), label, `未命中：${JSON.stringify(needle)}`);
  }
  notInc(text, needle, label) {
    this.ok(typeof text === "string" && !text.includes(needle), label, `不应命中：${JSON.stringify(needle)}`);
  }
}

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function sha256(path) {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 运行拼装脚本（cwd = 技能根，形态与派发时一致）。 */
function runTool(args, cwd = join(ASSETS, "..")) {
  return spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8", cwd });
}

// ---------------------------------------------------------------- 切片 1：卡模板文件内容契约

function checkTemplate(c) {
  const text = readText(TEMPLATE);
  if (text === null) {
    c.ok(false, "卡模板文件存在（assets/templates/card/card.template.md）", `缺失：${TEMPLATE}`);
    return;
  }
  c.ok(text.trim() !== "", "卡模板文件非空");
  // 两必填段（E1 V16 / V14/V15；卡文交付面 ①）
  c.inc(text, "交付面全量枚举", "必填段①「交付面全量枚举」在模板中");
  c.inc(text, "用户原话引用", "必填段②「用户原话引用」在模板中");
  // 验收句式要求（2026-10-10 用户批准：用户看到/点到什么）
  c.inc(text, "用户看到/点到什么", "验收句式要求（用户看到/点到什么）在模板中");
  // 拆粒度不砍范围（裁决③ / E1 V16）
  c.inc(text, "拆粒度不砍范围", "拆粒度不砍范围纪律在模板中");
  // 原话引文要求（访谈 id + 原话，E1 V14/V15）
  c.inc(text, "访谈 id", "原话引用要求（访谈 id）在模板中");
  c.inc(text, "原话", "原话引文要求在模板中");
  // 四段结构（目标 / 交付面全量枚举 / 用户原话引用 / 验收 + 责任行；本稿 85+1 卡实况）
  for (const field of ["责任", "目标", "验收"]) {
    c.inc(text, field, `字段形态「${field}」在模板中`);
  }
  // 缺段对照指引（反例卡随模板交付）
  c.inc(text, "card.example-fail.md", "模板指向反例卡（缺段形态对照）");
}

// ---------------------------------------------------------------- 切片 2：示例卡正/反例对照

/** 段字段形态（缩进 + 中英文冒号），与计划稿实况一致。 */
const segmentRe = (name) => new RegExp(`^\\s*${name}[:：]`, "m");

function checkExamples(c) {
  // 正例：全段齐备（与模板同形态）
  const passText = readText(PASS_EXAMPLE);
  if (passText === null) {
    c.ok(false, "正例卡存在（card.example-pass.md）", `缺失：${PASS_EXAMPLE}`);
  } else {
    c.ok(passText.trim() !== "", "正例卡非空");
    for (const field of ["责任", "目标", "交付面全量枚举", "用户原话引用", "验收"]) {
      c.ok(segmentRe(field).test(passText), `正例卡含字段「${field}」`);
    }
  }
  // 反例：恰缺「交付面全量枚举」字段（缺段形态，供校验对照）；其余段保持合规
  const failText = readText(FAIL_EXAMPLE);
  if (failText === null) {
    c.ok(false, "反例卡存在（card.example-fail.md）", `缺失：${FAIL_EXAMPLE}`);
  } else {
    c.ok(failText.trim() !== "", "反例卡非空");
    c.ok(!segmentRe("交付面全量枚举").test(failText), "反例卡缺「交付面全量枚举」字段（缺段形态）");
    c.ok(segmentRe("用户原话引用").test(failText), "反例卡其余必填段保持合规（用户原话引用）");
    c.ok(segmentRe("验收").test(failText), "反例卡验收段保持合规");
  }
}

// ---------------------------------------------------------------- 切片 3：约束块 + 拼装脚本

/** 约束块必须覆盖的段面（dispatch-checklist v1 分区 + 规格纪律；摘不丢面）。 */
const CONSTRAINT_TOPICS = [
  "位置与分层",
  "写入者分域",
  "身份与引用",
  "保护清单",
  "派发形态",
  "规格纪律",
  "检查点纪律",
  "绝对路径",
];

function checkConstraintBlock(c) {
  const text = readText(CONSTRAINT_BLOCK);
  if (text === null) {
    c.ok(false, "约束块文件存在（assets/templates/card/constraint-block.md）", `缺失：${CONSTRAINT_BLOCK}`);
    return;
  }
  c.inc(text, "constraint-block/1", "约束块带版本标记 constraint-block/1");
  for (const topic of CONSTRAINT_TOPICS) {
    c.inc(text, topic, `约束块覆盖段面「${topic}」`);
  }
  c.inc(text, "拆粒度不砍范围", "约束块含拆粒度不砍范围（V16）");
  c.inc(text, "两必填段", "约束块点名卡文两必填段（V14/V15/V16）");
}

function checkAssemblerBasics(c, root) {
  if (!existsSync(TOOL)) {
    c.ok(false, "拼装脚本存在（assets/tools/build-dispatch-prompt.mjs）", `缺失：${TOOL}`);
    return;
  }
  const evidence = join(root, "evidence", "T119");
  const res = runTool(["--source", PASS_EXAMPLE, "--card", "B6-1", "--evidence", evidence], root);
  c.eq(res.status, 0, "正例卡拼装退出码 0", `stderr=${res.stderr}`);
  const out = res.stdout ?? "";
  // 卡文原文随文（两必填段可见）
  c.inc(out, "①卡模板文件（两必填段 + 验收句式要求）", "输出含卡文原文：交付面全量枚举段内容");
  c.inc(out, "dispatch-checklist「用户反馈的关键句原文引用进卡", "输出含卡文原文：用户原话引用段内容");
  c.inc(out, "用户用模板起草新卡看到两必填段", "输出含卡文原文：验收段内容");
  c.inc(out, "no=119", "输出含卡文原文：发号标记（#119）");
  // 约束块全文自动拼装（V6）
  c.inc(out, "constraint-block/1", "输出含约束块（默认文件，版本标记）");
  c.inc(out, "拆粒度不砍范围", "输出含约束块纪律文本（拆粒度不砍范围）");
  // 绝对证据路径原样使用
  c.inc(out, evidence, "输出含绝对证据路径（原样）");
  // 角色与绿数（钉在「角色与绿数」节内，避免被约束块同词命中）
  c.ok(/## 4\. 角色与绿数[\s\S]*?责任角色：implementer/.test(out), "「角色与绿数」节含责任角色 implementer（责任行抽取）");
  c.inc(out, "正式卡 = 完整三绿（implementer → test-verifier 独立 → code-reviewer 两维）", "「角色与绿数」节含验证三层口径");
  // 只读边界
  c.inc(out, "不写任何板文件", "输出含只读边界（子智能体不写板文件）");
  c.inc(out, "run_event", "输出含报告 run_event 要求");
  // 段检出（信息级，stderr；拒发语义归 B6-2）
  c.inc(res.stderr ?? "", "交付面全量枚举=有", "stderr 段检出：交付面全量枚举=有");
  c.inc(res.stderr ?? "", "用户原话引用=有", "stderr 段检出：用户原话引用=有");
}

// ---------------------------------------------------------------- 切片 4：错误面与缺段点名

function checkAssemblerErrors(c, root) {
  const evidence = join(root, "evidence", "T119");
  const base = ["--evidence", evidence];

  // 反例卡（缺「交付面全量枚举」）：默认拒发（#120/B6-2，E1 V7；原 B6-1「点名不拒发」规格随动为拒发）
  const failOut = join(root, "out", "fail-prompt.md");
  const failRun = runTool(["--source", FAIL_EXAMPLE, "--card", "X9-1", "--out", failOut, ...base], root);
  c.eq(failRun.status, 3, "反例卡（缺段）默认拒发退出码 3（#120/B6-2 规格变更）", `stderr=${failRun.stderr}`);
  c.inc(failRun.stderr ?? "", "交付面全量枚举=缺", "反例卡片段检出：交付面全量枚举=缺");
  c.inc(failRun.stderr ?? "", "用户原话引用=有", "反例卡片段检出：用户原话引用=有");
  c.ok(/^build-dispatch-prompt: 缺段点名：交付面全量枚举$/m.test(failRun.stderr ?? ""), "反例卡点名恰缺「交付面全量枚举」段");
  c.ok(/^build-dispatch-prompt: 拒发[:：]/m.test(failRun.stderr ?? ""), "反例卡拒发行（stderr「拒发：…」，区别于旧「不拒发」措辞）");
  c.ok(!existsSync(failOut), "拒发不写出 --out（无半成品派发）");
  c.eq(failRun.stdout ?? "", "", "拒发 stdout 为空（不吐出 prompt 骨架）");

  // 无 --out 时同样拒发且 stdout 不留 prompt（默认路径的「零产出」形态）
  const failStdoutRun = runTool(["--source", FAIL_EXAMPLE, "--card", "X9-1", ...base], root);
  c.eq(failStdoutRun.status, 3, "反例卡默认拒发（无 --out）退出码 3", `stderr=${failStdoutRun.stderr}`);
  c.eq(failStdoutRun.stdout ?? "", "", "默认拒发不吐出 prompt 骨架（无 --out 时 stdout 亦为空）");

  // 缺任一段均拒发且点名不写死：夹具卡 G2-1 缺「用户原话引用」、G2-2 两段皆缺
  const missingQuoteFixture = w(
    root,
    "fixtures/missing-quote.md",
    [
      "# T120 夹具：缺段形态卡（#120/B6-2 反例；非真实计划稿）",
      "",
      "- [ ] G2-1 夹具：缺用户原话引用 <!-- zcode-board: no=902 -->",
      "  责任: implementer",
      "  目标: 夹具目标（缺另一必填段，验证点名不写死）。",
      "  交付面全量枚举: ①夹具；②反例断言。",
      "  验收: 缺段点名恰含「用户原话引用」。",
      "",
      "- [ ] G2-2 夹具：两段皆缺 <!-- zcode-board: no=903 -->",
      "  责任: implementer",
      "  目标: 夹具目标（两必填段皆缺，点名两段）。",
      "  验收: 缺段点名同时含两段名。",
      "",
    ].join("\n"),
  );

  const g1Out = join(root, "out", "g2-1.md");
  const g1Run = runTool(["--source", missingQuoteFixture, "--card", "G2-1", "--out", g1Out, ...base], root);
  c.eq(g1Run.status, 3, "缺「用户原话引用」默认拒发退出码 3", `stderr=${g1Run.stderr}`);
  c.ok(
    /^build-dispatch-prompt: 缺段点名：用户原话引用$/m.test(g1Run.stderr ?? ""),
    "点名恰缺「用户原话引用」（缺任一段均拒发，非写死单段）",
  );
  c.ok(!existsSync(g1Out), "缺「用户原话引用」拒发不写出 --out 半成品");

  const g2Out = join(root, "out", "g2-2.md");
  const g2Run = runTool(["--source", missingQuoteFixture, "--card", "G2-2", "--out", g2Out, ...base], root);
  c.eq(g2Run.status, 3, "两段皆缺默认拒发退出码 3", `stderr=${g2Run.stderr}`);
  c.ok(
    /^build-dispatch-prompt: 缺段点名：交付面全量枚举、用户原话引用$/m.test(g2Run.stderr ?? ""),
    "点名同时含两缺段（全量点名）",
  );

  // --allow-partial：显式放行调试口（缺段仍点名，不静默；E1 V7 默认拒发，仅对照/调试用）
  const partialOut = join(root, "out", "fail-prompt-partial.md");
  const partialRun = runTool(
    ["--source", FAIL_EXAMPLE, "--card", "X9-1", "--out", partialOut, "--allow-partial", ...base],
    root,
  );
  c.eq(partialRun.status, 0, "--allow-partial 显式放行退出码 0（调试口）", `stderr=${partialRun.stderr}`);
  c.ok(
    /^build-dispatch-prompt: 缺段点名：交付面全量枚举$/m.test(partialRun.stderr ?? ""),
    "--allow-partial 放行仍点名缺段（防线可见，不静默）",
  );
  c.notInc(partialRun.stderr ?? "", "拒发：", "--allow-partial 放行不出现拒发行");
  const partialPrompt = readText(partialOut);
  c.ok(partialPrompt !== null, "--allow-partial 写出 --out（调试对照用）");
  c.inc(partialPrompt ?? "", "缺段卡（对照用，不得派发）", "--allow-partial 写出 prompt 含卡文原文（缺段形态可见）");

  // 齐段放行（默认路径不误拒）
  const okRun = runTool(["--source", PASS_EXAMPLE, "--card", "B6-1", ...base], root);
  c.eq(okRun.status, 0, "齐段卡放行退出码 0（不误拒）", `stderr=${okRun.stderr}`);
  c.inc(okRun.stdout ?? "", "## 1. 卡文原文", "齐段卡正常吐出 prompt 骨架");

  // 证据路径非绝对 → 退出码 2（用法/输入错误；仓内 compile-board/register-interview 同口径）并点名「绝对路径」
  const relRun = runTool(["--source", PASS_EXAMPLE, "--card", "B6-1", "--evidence", "evidence/T119"], root);
  c.eq(relRun.status, 2, "相对证据路径退出码 2（用法/输入错误）", `stderr=${relRun.stderr}`);
  c.inc(relRun.stderr ?? "", "绝对路径", "相对证据路径点名「绝对路径」");

  // 卡未找到 → 非零退出
  const nfRun = runTool(["--source", PASS_EXAMPLE, "--card", "ZZZ-9", ...base], root);
  c.ok(nfRun.status !== 0, "卡未找到非零退出", `status=${nfRun.status}`);
  c.inc(nfRun.stderr ?? "", "未找到", "卡未找到点名");

  // 来源不存在 → 非零退出
  const nsRun = runTool(["--source", join(root, "nope.md"), "--card", "B6-1", ...base], root);
  c.ok(nsRun.status !== 0, "来源不存在非零退出", `status=${nsRun.status}`);
  c.inc(nsRun.stderr ?? "", "不存在", "来源不存在点名");

  // 缺必填选项 → 非零退出
  const naRun = runTool(["--source", PASS_EXAMPLE], root);
  c.ok(naRun.status !== 0, "缺必填选项非零退出", `status=${naRun.status}`);
  c.inc(naRun.stderr ?? "", "--evidence", "缺必填选项用法点名");
}

// ---------------------------------------------------------------- 切片 5：确定性 / 覆盖 / 抽取边界 / 源零改写

const TWO_CARD_FIXTURE = join(HERE, "fixtures", "card", "two-cards.md");

function checkRobustness(c, root) {
  const evidence = join(root, "evidence", "T119");

  // 确定性：双跑逐字节一致（机械拼装无随机性——手打遗漏的对立面）
  const run1 = runTool(["--source", TWO_CARD_FIXTURE, "--card", "F9-1", "--evidence", evidence], root);
  const run2 = runTool(["--source", TWO_CARD_FIXTURE, "--card", "F9-1", "--evidence", evidence], root);
  c.eq(run1.status, 0, "夹具卡一拼装退出码 0", `stderr=${run1.stderr}`);
  c.ok(run1.status === 0 && run2.status === 0, "确定性前提：双跑均成功", `status=${run1.status}/${run2.status}`);
  c.eq(run1.stdout, run2.stdout, "确定性：双跑 stdout 逐字节一致");

  // 抽取边界：止于下一卡；含卡一验收与 blocked-by 行；不含卡二
  const out = run1.stdout ?? "";
  c.inc(out, "夹具卡一验收文本", "卡一抽取含其验收段（边界内）");
  c.inc(out, "> blocked-by: 76", "卡一抽取含缩进续行（blocked-by）");
  c.notInc(out, "夹具卡二", "抽取止于下一卡（不含卡二任何文本）");

  // 标签与稳定号等价命中
  const byNo = runTool(["--source", TWO_CARD_FIXTURE, "--card", "900", "--evidence", evidence], root);
  c.eq(byNo.status, 0, "按稳定号命中退出码 0", `stderr=${byNo.stderr}`);
  c.eq(byNo.stdout, run1.stdout, "标签与稳定号命中同一卡（输出一致）");

  // --constraints 覆盖生效（拼装读文件而非硬编码）
  const sentinel = w(root, "custom-constraints.md", "# 自定义约束块哨兵 T119-SENTINEL\n\n- 仅作覆盖测试。\n");
  const custRun = runTool(["--source", PASS_EXAMPLE, "--card", "B6-1", "--evidence", evidence, "--constraints", sentinel], root);
  c.eq(custRun.status, 0, "--constraints 覆盖退出码 0", `stderr=${custRun.stderr}`);
  c.inc(custRun.stdout ?? "", "T119-SENTINEL", "--constraints 覆盖：自定义约束块被拼入");
  c.notInc(custRun.stdout ?? "", "constraint-block/1", "--constraints 覆盖：默认约束块未混入");

  // 源零改写：拼装前后 sha256 一致
  const before = sha256(TWO_CARD_FIXTURE);
  c.ok(before !== null, "源零改写前提：夹具存在");
  runTool(["--source", TWO_CARD_FIXTURE, "--card", "F9-1", "--evidence", evidence], root);
  c.eq(sha256(TWO_CARD_FIXTURE), before, "源计划稿零改写（sha256 前后一致）");
}

// ---------------------------------------------------------------- 切片 6：卡类型判定 + 需齐绿清单（#121/B6-3）

/** 五类卡形态夹具（类型判定样本；含 hook 卡带反例断言——验证 hook 优先于断言信号）。 */
function typeProbeFixture(root) {
  const text = [
    "# T121 夹具：五类卡形态（#121/B6-3 需齐绿清单；非真实计划稿）",
    "",
    "- [ ] U1-1 夹具 UI 卡 <!-- zcode-board: no=910 -->",
    "  责任: implementer",
    "  目标: 更新 packages/ui 的 UI 组件与词条（夹具样本）。",
    "  交付面全量枚举: ①packages/ui 组件改动；②浏览器断言；③文档。",
    "  用户原话引用: 「UI 卡第四绿」（夹具引句，非真实用户话）。",
    "  验收: 用户看到 UI 卡清单含第四绿与浏览器断言项。",
    "",
    "- [ ] A1-1 夹具 断言卡 <!-- zcode-board: no=911 -->",
    "  责任: implementer",
    "  目标: 为不变量补突变断言（夹具样本）。",
    "  交付面全量枚举: ①突变断言；②反例证据。",
    "  用户原话引用: 「断言必咬」（夹具引句）。",
    "  验收: 用户看到突变/反例证据项。",
    "",
    "- [ ] H1-1 夹具 hook 卡 <!-- zcode-board: no=912 -->",
    "  责任: implementer",
    "  目标: 修改 gate-merge hook 行为（夹具样本）。",
    "  交付面全量枚举: ①hook 代码；②反例断言。",
    "  用户原话引用: 「hook 安装启用须信任评审」（夹具引句）。",
    "  验收: 用户看到 run-t13 场景与信任评审注记项。",
    "",
    "- [ ] D1-1 夹具 文档卡 <!-- zcode-board: no=913 -->",
    "  责任: implementer",
    "  目标: 更新说明文档（纯 md 交付面，夹具样本）。",
    "  交付面全量枚举: ①SKILL.md 文档更新；②命令示例。",
    "  用户原话引用: 「文档卡清单合理」（夹具引句）。",
    "  验收: 用户看到文档卡清单合理。",
    "",
    "- [ ] C1-1 夹具 代码卡 <!-- zcode-board: no=914 -->",
    "  责任: implementer",
    "  目标: 重构数据管线（夹具样本）。",
    "  交付面全量枚举: ①管线改造；②回归测试。",
    "  用户原话引用: 「默认代码卡」（夹具引句）。",
    "  验收: 用户看到默认代码卡清单。",
    "",
  ].join("\n");
  return w(root, "fixtures/type-probes.md", text);
}

function checkTypeChecklists(c, root) {
  const evidence = join(root, "evidence", "T121");
  const probe = typeProbeFixture(root);
  const run = (card, extra = []) =>
    runTool(["--source", probe, "--card", card, "--evidence", evidence, ...extra], root);

  // —— 类型判定显式输出（启发式，判定依据随文；不猜死——--type 覆盖归切片 7） ——
  const ui = run("U1-1");
  c.eq(ui.status, 0, "UI 卡拼装退出码 0", `stderr=${ui.stderr}`);
  const uiOut = ui.stdout ?? "";
  c.inc(
    uiOut,
    "卡类型：UI 卡（判定依据：命中「packages/ui、UI 组件、词条」；--type 可覆盖）",
    "UI 卡类型判定显式输出（含判定依据）",
  );
  c.inc(ui.stderr ?? "", "卡类型 UI 卡", "stderr 输出卡类型（UI 卡）");

  const assertRun = run("A1-1");
  const assertOut = assertRun.stdout ?? "";
  c.inc(
    assertOut,
    "卡类型：断言卡（判定依据：命中「断言、不变量、突变、反例」；--type 可覆盖）",
    "断言卡类型判定显式输出（含判定依据）",
  );

  const hookRun = run("H1-1");
  const hookOut = hookRun.stdout ?? "";
  c.inc(
    hookOut,
    "卡类型：hook 卡（判定依据：命中「hook」；--type 可覆盖）",
    "hook 优先于断言信号（夹具带反例断言仍判 hook 卡）",
  );

  const docRun = run("D1-1");
  const docOut = docRun.stdout ?? "";
  c.inc(
    docOut,
    "卡类型：文档卡（判定依据：命中「文档、.md」且无脚本/代码面信号；--type 可覆盖）",
    "文档卡（纯 md 交付面）判定显式输出",
  );

  const codeRun = run("C1-1");
  const codeOut = codeRun.stdout ?? "";
  c.inc(
    codeOut,
    "卡类型：代码卡（判定依据：无类型信号（默认）；--type 可覆盖）",
    "代码卡（默认）判定显式输出",
  );

  // —— UI 卡清单（验收主项：第四绿 + 浏览器断言） ——
  c.inc(
    uiOut,
    "- 需齐绿清单（UI 卡 × 正式卡；SKILL.md §6.5 验证三层 + 第四绿 + 浏览器断言口径；与 #100/B2-2 gate-merge 合并强制面同口径）：",
    "UI 卡清单标题（类型 × 等级 + 口径来源）",
  );
  c.inc(uiOut, "[第一绿] implementer 自证", "UI 卡清单含第一绿");
  c.inc(uiOut, "[第二绿] test-verifier 独立验证", "UI 卡清单含第二绿（三绿完整）");
  c.inc(uiOut, "[第三绿] code-reviewer 两维", "UI 卡清单含第三绿");
  c.inc(
    uiOut,
    "[第四绿] ui-designer 视觉/信息层级复核 approved（diff 触及用户可见面时强制，无证据不得进待合并）。",
    "UI 卡清单含第四绿（ui-designer 复核，无证据不得进待合并）",
  );
  c.inc(
    uiOut,
    "[浏览器断言] test-verifier 必跑：溢出探针 scrollWidth>clientWidth + 点击路由派发后断言 DOM；SSR 结构断言不构成行为证据。",
    "UI 卡清单含浏览器断言（溢出探针 + 点击路由 DOM 断言）",
  );
  c.notInc(uiOut, "[突变/反例证据]", "UI 卡清单不混入断言专项项");
  c.notInc(uiOut, "[run-t13 场景]", "UI 卡清单不混入 hook 专项项");

  // —— 断言卡清单（突变/反例证据；无 UI 专项项） ——
  c.inc(assertOut, "[突变/反例证据] 必带突变或反例断言，反例必咬（E4-24）。", "断言卡清单含突变/反例证据项");
  c.notInc(assertOut, "[第四绿]", "断言卡清单无第四绿（非 UI 面）");
  c.notInc(assertOut, "[浏览器断言]", "断言卡清单无浏览器断言项");

  // —— hook 卡清单（run-t13 场景 + 信任评审注记） ——
  c.inc(hookOut, "[run-t13 场景] assets/test/run-t13-hooks.mjs 场景全绿。", "hook 卡清单含 run-t13 场景项");
  c.inc(
    hookOut,
    "[信任评审注记] hook 安装启用前过 preflight + 信任评审检查点（SKILL.md §6.5 检查点纪律）。",
    "hook 卡清单含信任评审注记",
  );
  c.notInc(hookOut, "[第四绿]", "hook 卡清单无第四绿");

  // —— 文档卡清单（纯 md 注记；等级绿齐备、无 UI/断言/hook 附加项） ——
  c.inc(
    docOut,
    "[文档卡注记] 纯 md 交付面：无第四绿/浏览器断言/突变证据附加项；绿数以等级为准。",
    "文档卡清单含纯 md 注记",
  );
  c.inc(docOut, "[第一绿]", "文档卡清单含第一绿（默认正式等级）");
  c.inc(docOut, "[第二绿]", "文档卡清单含第二绿（默认正式等级）");
  c.inc(docOut, "[第三绿]", "文档卡清单含第三绿（默认正式等级）");
  c.notInc(docOut, "[第四绿]", "文档卡清单无第四绿");
  c.notInc(docOut, "[突变/反例证据]", "文档卡清单无突变/反例项");
  c.notInc(docOut, "[run-t13 场景]", "文档卡清单无 run-t13 项");

  // —— 代码卡清单（默认：仅等级绿） ——
  c.inc(codeOut, "[第一绿]", "代码卡清单含第一绿（默认）");
  c.inc(codeOut, "[第二绿]", "代码卡清单含第二绿（默认）");
  c.inc(codeOut, "[第三绿]", "代码卡清单含第三绿（默认）");
  c.notInc(codeOut, "[第四绿]", "代码卡清单无第四绿");
  c.notInc(codeOut, "[突变/反例证据]", "代码卡清单无突变/反例项（无断言信号）");
  c.notInc(codeOut, "[run-t13 场景]", "代码卡清单无 run-t13 项");
  c.notInc(codeOut, "[文档卡注记]", "代码卡清单无文档卡注记");
}

function checkTypeControls(c, root) {
  const evidence = join(root, "evidence", "T121");
  const probe = typeProbeFixture(root);
  const run = (card, extra = []) =>
    runTool(["--source", probe, "--card", card, "--evidence", evidence, ...extra], root);

  // —— --type 显式覆盖（不猜死：覆盖生效，启发式原判仍可见） ——
  const uiAsCode = run("U1-1", ["--type", "code"]);
  c.eq(uiAsCode.status, 0, "--type 覆盖拼装退出码 0", `stderr=${uiAsCode.stderr}`);
  const uiAsCodeOut = uiAsCode.stdout ?? "";
  c.inc(
    uiAsCodeOut,
    "卡类型：代码卡（--type 覆盖；启发式原判 UI 卡：命中「packages/ui、UI 组件、词条」）",
    "--type 覆盖生效且显示启发式原判（不猜死）",
  );
  c.notInc(uiAsCodeOut, "[第四绿]", "--type 覆盖为代码卡后清单无第四绿");
  c.notInc(uiAsCodeOut, "[浏览器断言]", "--type 覆盖为代码卡后清单无浏览器断言项");
  c.inc(uiAsCode.stderr ?? "", "卡类型 代码卡（--type 覆盖", "stderr 显示覆盖后的卡类型与覆盖来源");

  const codeAsUi = run("C1-1", ["--type", "ui"]);
  const codeAsUiOut = codeAsUi.stdout ?? "";
  c.inc(
    codeAsUiOut,
    "卡类型：UI 卡（--type 覆盖；启发式原判 代码卡：无类型信号（默认））",
    "--type 覆盖为 UI 卡（原判可见）",
  );
  c.inc(codeAsUiOut, "[第四绿] ui-designer", "覆盖为 UI 卡后清单含第四绿");
  c.inc(codeAsUiOut, "[浏览器断言] test-verifier 必跑", "覆盖为 UI 卡后清单含浏览器断言项");

  const badType = run("U1-1", ["--type", "widget"]);
  c.eq(badType.status, 2, "--type 非法值退出码 2（用法错误）", `stderr=${badType.stderr}`);
  c.inc(badType.stderr ?? "", "ui|assertion|hook|doc|code", "非法 --type 点名允许取值");

  // 反例必咬：原型链名（constructor/toString）不得被误判为合法取值
  const protoType = run("U1-1", ["--type", "constructor"]);
  c.eq(protoType.status, 2, "--type 原型链名（constructor）退出码 2（精确匹配，不误判）", `stderr=${protoType.stderr}`);
  c.inc(protoType.stderr ?? "", "取值非法", "原型链名 --type 点名「取值非法」");

  // —— --level 标注（正式缺省 / 跟进 / 微卡 三档绿数） ——
  const micro = run("U1-1", ["--level", "微卡"]);
  c.eq(micro.status, 0, "--level 微卡拼装退出码 0", `stderr=${micro.stderr}`);
  const microOut = micro.stdout ?? "";
  c.inc(microOut, "验证等级：微卡（--level 传入）", "--level 微卡标注生效（等级来源显式）");
  c.inc(microOut, "[第一绿]", "微卡清单含第一绿");
  c.inc(microOut, "[回归全绿]", "微卡清单含回归全绿");
  c.notInc(microOut, "[第二绿]", "微卡清单无第二绿（不需独立二三绿）");
  c.notInc(microOut, "[第三绿]", "微卡清单无第三绿（不需独立二三绿）");
  c.inc(microOut, "[第四绿] ui-designer", "微卡 UI 卡仍保留第四绿（diff 触及用户可见面强制）");
  c.inc(microOut, "[浏览器断言] test-verifier 必跑", "微卡 UI 卡仍保留浏览器断言项");

  const follow = run("A1-1", ["--level", "跟进"]);
  const followOut = follow.stdout ?? "";
  c.inc(followOut, "验证等级：跟进卡（--level 传入）", "--level 跟进标注生效");
  c.inc(followOut, "[批量验证]", "跟进卡清单含批量验证");
  c.notInc(followOut, "[第二绿]", "跟进卡清单无第二绿（第一绿 + 回归全绿 + 批量验证）");
  c.inc(followOut, "[突变/反例证据]", "跟进断言卡仍保留突变/反例证据项");

  const badLevel = run("U1-1", ["--level", "超卡"]);
  c.eq(badLevel.status, 2, "--level 非法值退出码 2（用法错误）", `stderr=${badLevel.stderr}`);
  c.inc(badLevel.stderr ?? "", "正式|跟进|微卡", "非法 --level 点名允许取值");

  // —— 留痕：清单随 --out 落盘可核对 ——
  const outFile = join(root, "out", "ui-prompt.md");
  const outRun = run("U1-1", ["--out", outFile]);
  c.eq(outRun.status, 0, "--out 写出退出码 0", `stderr=${outRun.stderr}`);
  const written = readText(outFile);
  c.ok(written !== null, "清单留痕前提：--out 文件存在");
  c.inc(written ?? "", "需齐绿清单（UI 卡 × 正式卡", "留痕 prompt 含清单标题（随卡可核对）");
  c.inc(written ?? "", "[第四绿] ui-designer", "留痕 prompt 含第四绿项");
  c.inc(written ?? "", "[浏览器断言] test-verifier 必跑", "留痕 prompt 含浏览器断言项");
}

// ---------------------------------------------------------------- 主流程

say("zcode-board · #119（B6-1）卡模板 / 约束块拼装（红→绿）");
say(`node   : ${process.version}`);
say(`assets : ${ASSETS}`);
say("");

say("== 切片 1：卡模板文件内容契约（两必填段 + 验收句式 + 纪律） ==");
{
  const c = new Checks("template");
  checkTemplate(c);
}

say("");
say("== 切片 2：示例卡正/反例对照（反例=缺「交付面全量枚举」形态） ==");
{
  const c = new Checks("examples");
  checkExamples(c);
}

say("");
say("== 切片 3：约束块 + 拼装脚本基础面（两必填段随文 / 约束块全文 / 证据路径 / 角色 / 只读边界） ==");
{
  const c = new Checks("assembler");
  checkConstraintBlock(c);
  const root = newRoot("t119-assembler");
  try {
    checkAssemblerBasics(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 4：错误面与缺段拒发（默认拒发退出码 3 + 点名缺段 / 齐段放行 / 非绝对证据 / 卡未找到 / 用法） ==");
{
  const c = new Checks("errors");
  const root = newRoot("t119-errors");
  try {
    checkAssemblerErrors(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 5：确定性 / 约束块覆盖 / 抽取边界 / 源零改写 ==");
{
  const c = new Checks("robust");
  const root = newRoot("t119-robust");
  try {
    checkRobustness(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say("== 切片 6：卡类型判定 + 需齐绿清单（#121/B6-3：UI 第四绿/浏览器断言 · 断言突变证据 · hook run-t13 · 文档注记 · 代码默认） ==");
{
  const c = new Checks("types");
  const root = newRoot("t119-types");
  try {
    checkTypeChecklists(c, root);
    checkTypeControls(c, root);
  } finally {
    removeRoot(root);
  }
}

say("");
say(failCount === 0 ? `结论：通过 ${passCount}，失败 0` : `结论：通过 ${passCount}，失败 ${failCount}`);
process.exit(failCount === 0 ? 0 : 1);
