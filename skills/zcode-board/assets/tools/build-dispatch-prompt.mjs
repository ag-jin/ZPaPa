#!/usr/bin/env node
/**
 * zcode-board / 卡条目 → 派发 prompt 骨架 拼装器（#119 / B6-1；#120 / B6-2 必填段校验拒发；
 * #121 / B6-3 卡类型判定 + 需齐绿清单；#124 / B6-6 未验证面注入）
 *
 * 存在原因（E1 V6）：约束必须随派发可见，杜绝手打遗漏——约束块由本脚本机械拼装进派发 prompt。
 * 拼装输入 = 卡条目（从计划稿抽取，只读）+ 约束块（constraint-block 摘要文件，默认
 * `assets/templates/card/constraint-block.md`）；输出 = 可直接派发的 prompt 骨架：
 *   ① 卡号原文（不得改写；两必填段随文可见）  ② 约束块全文  ③ 绝对证据路径
 *   ④ 角色与绿数（含按卡类型的需齐绿清单，#121）  ⑤ 只读边界
 *   ⑥ 未验证面注入清单（#124/B6-6，E1 V27；仅当 --unverified 传入时出现——素材为验证报告
 *      「未验证面/覆盖缺口」节抽取出的一行一项清单文件；清单为空视为提取失败，拒发）
 *
 * 必填段门槛（#120/B6-2，E1 V7「空 prompt 派发」防线）：
 *   - 卡文缺「交付面全量枚举 / 用户原话引用」任一段 → 默认**拒发**：stderr 点名缺哪段，
 *     不产出任何 prompt（stdout 空、--out 不写出），退出码 3。
 *   - 调试口（显式）：--allow-partial 放行缺段（仍点名）；非派发路径，仅供对照/调试。
 *
 * 未验证面注入门槛（#124/B6-6，E1 V27「未验证面堆积无归期」防线）：
 *   - --unverified 文件缺失 → 退出码 2（点名，零产出）；文件存在但清单为空（0 项，
 *     注释/空行不计）→ 退出码 3 拒发（不静默省略注入）。
 *
 * 卡类型与需齐绿清单（#121/B6-3，E1 V9）：
 *   - 从卡文启发式判定卡类型（ui → hook → 断言 → 纯 md 文档 → 默认代码卡），判定依据显式输出；
 *     --type 显式覆盖（仍输出启发式原判，不猜死）。
 *   - 「角色与绿数」节按 类型 × 等级（--level 标注 正式/跟进/微卡，缺省正式卡）生成需齐绿清单
 *     （SKILL.md §6.5 验证三层 + UI 第四绿 + 浏览器断言口径；与 gate-merge（#100/B2-2）合并强制面
 *     同口径）：UI 卡 = 三绿 + 第四绿（ui-designer）+ 浏览器断言；断言卡 = 突变/反例证据；
 *     hook 卡 = run-t13 场景 + 信任评审注记；文档卡 = 纯 md 注记；代码卡 = 等级绿。
 *
 * 用法：
 *   node assets/tools/build-dispatch-prompt.mjs --source <计划稿> --card <标签|稳定号> \
 *        --evidence <绝对证据路径> [--role <角色>] [--type <卡类型>] [--level <验证等级>] \
 *        [--constraints <约束块文件>] [--unverified <未验证面清单文件>] [--out <文件>]
 *
 * 无第三方依赖：仅 Node 内置模块。退出码：0 = 已拼装（放行）；2 = 用法/输入错误（卡未找到、
 * 证据路径非绝对、--type/--level 取值非法、--unverified 文件缺失等）；3 = 卡文缺必填段拒发或
 * 未验证面清单为空拒发（--allow-partial 可显式放行缺段）。
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSETS = resolve(HERE, "..");
const DEFAULT_CONSTRAINTS = join(ASSETS, "templates", "card", "constraint-block.md");

/** 卡文两必填段（#119；缺段默认拒发门槛见文件头，#120/B6-2，E1 V7）。 */
const MANDATORY_SEGMENTS = ["交付面全量枚举", "用户原话引用"];

/** 卡类型标签（#121/B6-3）：启发式判定顺序 ui → hook → 断言 → 纯 md 文档 → 默认代码卡。 */
const CARD_TYPE_LABELS = { ui: "UI 卡", assertion: "断言卡", hook: "hook 卡", doc: "文档卡", code: "代码卡" };
/** 验证等级标签（#121/B6-3；SKILL.md §6.5 三层，缺省正式卡）。 */
const CARD_LEVEL_LABELS = { 正式: "正式卡", 跟进: "跟进卡", 微卡: "微卡" };
/** 合法取值（--type/--level 校验用；includes 精确匹配，避免原型链误判）。 */
const CARD_TYPE_VALUES = Object.keys(CARD_TYPE_LABELS);
const CARD_LEVEL_VALUES = Object.keys(CARD_LEVEL_LABELS);

/** 类型信号（按判定顺序；命中即出判定依据，不猜死——--type 可显式覆盖）。 */
const UI_SIGNALS = ["packages/ui", "UI 组件", "界面", "布局", "交互", "词条", "视觉"];
const ASSERTION_SIGNALS = ["断言", "不变量", "突变", "反例"];
const DOC_SIGNALS = ["文档", ".md"];
/** 代码面信号：出现即证明交付面非纯 md（文档卡判定需排除）。 */
const CODE_FACE_RE = /\.(mjs|js|ts|tsx|json|sh|py|mts|cts)\b|脚本|代码/;

const USAGE = `用法：
  node assets/tools/build-dispatch-prompt.mjs --source <计划稿> --card <标签|稳定号> \\
       --evidence <绝对证据路径> [--role <角色>] [--type <卡类型>] [--level <等级>] \\
       [--constraints <约束块文件>] [--unverified <未验证面清单文件>] [--out <文件>]

  --source       计划稿路径（只读抽取卡条目；不改写）
  --card         卡标签（如 B6-1）或稳定号（如 119）；两种形态等价
  --evidence     证据目录——必须为绝对路径（相对路径会写出幻影板/错位证据）
  --role         角色覆盖；缺省读卡文「责任:」行
  --type         卡类型覆盖：ui|assertion|hook|doc|code（缺省从卡文启发式判定，判定依据显式输出）
  --level        验证等级标注：正式|跟进|微卡（缺省正式卡；决定需齐绿清单的绿数，SKILL.md §6.5）
  --constraints  约束块文件；缺省 assets/templates/card/constraint-block.md
  --unverified   未验证面清单文件（一行一项；素材=验证报告「未验证面/覆盖缺口」节）；
                 逐条注入骨架「## 6. 未验证面」段（E1 V27）；文件缺失退出码 2，清单为空拒发退出码 3
  --out          输出文件；缺省 stdout
  --allow-partial 缺必填段时显式放行（调试口；默认缺段拒发，E1 V7）
退出码：0 = 已拼装（放行）；2 = 用法/输入错误（含 --type/--level 取值非法、--unverified 缺失）；3 = 卡文缺必填段或未验证面清单为空拒发（--allow-partial 可显式放行缺段）。`;

function die(msg) {
  process.stderr.write(`build-dispatch-prompt: ${msg}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const opt = {};
  const valueOpts = new Set(["--source", "--card", "--evidence", "--role", "--constraints", "--out", "--type", "--level", "--unverified"]);
  const flagOpts = new Set(["--allow-partial"]);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (flagOpts.has(a)) {
      opt[a.slice(2)] = true;
      continue;
    }
    if (!valueOpts.has(a)) die(`未知选项 ${a}\n${USAGE}`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) die(`选项 ${a} 缺少取值\n${USAGE}`);
    opt[a.slice(2)] = v;
    i += 1;
  }
  for (const req of ["source", "card", "evidence"]) {
    if (!opt[req]) die(`缺少必填选项 --${req}\n${USAGE}`);
  }
  return opt;
}

/**
 * 从计划稿文本抽取卡条目（条目行 + 其缩进续行，止于空行/下一顶层行）。
 * 返回 { label, no, block } 或 null；标签与稳定号任一命中 key 即算命中。
 */
function extractCard(text, key) {
  const lines = text.split(/\r?\n/);
  const norm = String(key).trim().replace(/^#/, "").replace(/^ID-/i, "");
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^-\s+\[[ xX]\]\s+(\S+)\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const noMatch = /<!--\s*zcode-board:\s*no=([1-9][0-9]*)\s*-->/.exec(lines[i]);
    const no = noMatch ? Number(noMatch[1]) : null;
    const label = m[1];
    if (label !== norm && !(no !== null && String(no) === norm)) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^(?: {2,}|\t)\S/.test(lines[j])) {
        block.push(lines[j]);
        continue;
      }
      break;
    }
    return { label, no, block };
  }
  return null;
}

function fieldRe(name) {
  return new RegExp(`^\\s*${name}[:：]`, "m");
}

function detectSegments(blockText) {
  const found = {};
  for (const name of MANDATORY_SEGMENTS) found[name] = fieldRe(name).test(blockText);
  return found;
}

function extractRole(blockText) {
  const m = /^\s*责任[:：]\s*(\S+)/m.exec(blockText);
  return m ? m[1] : null;
}

/**
 * 卡类型启发式判定（#121/B6-3，E1 V9）：返回 { type, evidence }。
 * 判定顺序 ui → hook → 断言 → 文档（纯 md 交付面）→ 默认代码卡；
 * evidence 为判定依据文本（命中的信号原文），随输出显式可见，不猜死。
 */
function detectCardType(blockText) {
  const uiHits = UI_SIGNALS.filter((s) => blockText.includes(s));
  if (uiHits.length > 0) return { type: "ui", evidence: `命中「${uiHits.join("、")}」` };
  if (/hook/i.test(blockText)) return { type: "hook", evidence: "命中「hook」" };
  const assertHits = ASSERTION_SIGNALS.filter((s) => blockText.includes(s));
  if (assertHits.length > 0) return { type: "assertion", evidence: `命中「${assertHits.join("、")}」` };
  const docHits = DOC_SIGNALS.filter((s) => blockText.includes(s));
  if (docHits.length > 0 && !CODE_FACE_RE.test(blockText)) {
    return { type: "doc", evidence: `命中「${docHits.join("、")}」且无脚本/代码面信号` };
  }
  return { type: "code", evidence: "无类型信号（默认）" };
}

/**
 * 需齐绿清单（#121/B6-3）：等级定绿数（SKILL.md §6.5 三层），类型加专项项——
 * UI 卡第四绿 + 浏览器断言；断言卡突变/反例证据；hook 卡 run-t13 + 信任评审注记；
 * 文档卡纯 md 注记；代码卡仅等级绿。与 gate-merge（#100/B2-2）合并强制面同口径。
 */
function buildChecklist(type, level) {
  const items = [];
  if (level === "微卡") {
    items.push("[第一绿] implementer 自证：测试先行（红→绿），证据落绝对路径。");
    items.push("[回归全绿] 相关套件回归全绿（不需独立二三绿；SKILL.md §6.5）。");
  } else if (level === "跟进") {
    items.push("[第一绿] implementer 自证：测试先行（红→绿），证据落绝对路径。");
    items.push("[回归全绿] 相关套件回归全绿。");
    items.push("[批量验证] 批量验证并注明覆盖面（可合并多卡；SKILL.md §6.5）。");
  } else {
    items.push("[第一绿] implementer 自证：测试先行（红→绿），证据落绝对路径。");
    items.push("[第二绿] test-verifier 独立验证：独立复跑项目验证，确认行为与回归。");
    items.push("[第三绿] code-reviewer 两维（标准/需求）approved + 卡分支 rebase 无冲突（integrator 机械验证）。");
  }
  if (type === "ui") {
    items.push("[第四绿] ui-designer 视觉/信息层级复核 approved（diff 触及用户可见面时强制，无证据不得进待合并）。");
    items.push(
      "[浏览器断言] test-verifier 必跑：溢出探针 scrollWidth>clientWidth + 点击路由派发后断言 DOM；SSR 结构断言不构成行为证据。",
    );
  } else if (type === "assertion") {
    items.push("[突变/反例证据] 必带突变或反例断言，反例必咬（E4-24）。");
  } else if (type === "hook") {
    items.push("[run-t13 场景] assets/test/run-t13-hooks.mjs 场景全绿。");
    items.push("[信任评审注记] hook 安装启用前过 preflight + 信任评审检查点（SKILL.md §6.5 检查点纪律）。");
  } else if (type === "doc") {
    items.push("[文档卡注记] 纯 md 交付面：无第四绿/浏览器断言/突变证据附加项；绿数以等级为准。");
  }
  return items;
}

/**
 * 未验证面清单解析（#124/B6-6，E1 V27）：一行一项；注释（# 起）与空行不计；
 * 剥离行首列表记号（`- `/`* `/`- [ ] `），与报告「未验证面/覆盖缺口」节直接摘录兼容。
 */
function parseUnverifiedList(text) {
  const items = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    line = line.replace(/^[-*]\s+(?:\[[ xX]\]\s+)?/, "").trim();
    if (line === "") continue;
    items.push(line);
  }
  return items;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));

  // --type/--level 取值门槛（#121/B6-3）：显式取值必须合法，非法即用法错误（退出码 2）。
  if (opt.type !== undefined && !CARD_TYPE_VALUES.includes(opt.type)) {
    die(`--type 取值非法：${opt.type}（允许：${CARD_TYPE_VALUES.join("|")}）\n${USAGE}`);
  }
  if (opt.level !== undefined && !CARD_LEVEL_VALUES.includes(opt.level)) {
    die(`--level 取值非法：${opt.level}（允许：${CARD_LEVEL_VALUES.join("|")}）\n${USAGE}`);
  }

  const sourcePath = resolve(opt.source);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    die(`卡文来源不存在或不是文件：${sourcePath}`);
  }
  const card = extractCard(readFileSync(sourcePath, "utf8"), opt.card);
  if (!card) die(`未找到卡：${opt.card}（来源 ${sourcePath}）`);

  if (!isAbsolute(opt.evidence)) {
    die(`证据路径必须为绝对路径（原样使用，杜绝幻影板/错位证据）：${opt.evidence}`);
  }

  const constraintsPath = resolve(opt.constraints ?? DEFAULT_CONSTRAINTS);
  if (!existsSync(constraintsPath) || !statSync(constraintsPath).isFile()) {
    die(`约束块文件不存在：${constraintsPath}`);
  }
  const constraints = readFileSync(constraintsPath, "utf8").trim();
  if (constraints === "") die(`约束块文件为空：${constraintsPath}`);

  // 未验证面清单（#124/B6-6，E1 V27）：显式传入即硬门槛——文件缺失为输入错误（退出码 2）；
  // 解析后为空的拒发归缺段门槛之后（同一退出码 3，不静默省略注入）。
  let unverified = null;
  if (opt.unverified !== undefined) {
    const listPath = resolve(opt.unverified);
    if (!existsSync(listPath) || !statSync(listPath).isFile()) {
      die(`未验证面清单文件不存在或不是文件：${listPath}`);
    }
    unverified = { path: listPath, items: parseUnverifiedList(readFileSync(listPath, "utf8")) };
  }

  const blockText = card.block.join("\n");
  const segments = detectSegments(blockText);
  const missing = MANDATORY_SEGMENTS.filter((name) => !segments[name]);
  const role = opt.role ?? extractRole(blockText) ?? "<未指定>";
  const noTag = card.no === null ? "未领号" : `#${card.no}`;

  // 卡类型：#121/B6-3 —— 启发式判定 + 判定依据显式输出；--type 显式覆盖（仍输出启发式原判）。
  const heuristic = detectCardType(blockText);
  const type = opt.type ?? heuristic.type;
  const typeSource =
    opt.type !== undefined
      ? `--type 覆盖；启发式原判 ${CARD_TYPE_LABELS[heuristic.type]}：${heuristic.evidence}`
      : `判定依据：${heuristic.evidence}；--type 可覆盖`;
  const level = opt.level ?? "正式";
  const levelOrigin = opt.level !== undefined ? "--level 传入" : "默认";
  const levelSource = opt.level !== undefined ? "--level 传入" : "默认；--level 可标注 跟进/微卡";
  const checklist = buildChecklist(type, level);

  process.stderr.write(`build-dispatch-prompt: 卡文来源 ${sourcePath}；命中卡 ${card.label}（${noTag}）\n`);
  process.stderr.write(
    `build-dispatch-prompt: 段检出 ${MANDATORY_SEGMENTS.map((n) => `${n}=${segments[n] ? "有" : "缺"}`).join(" ")}\n`,
  );
  process.stderr.write(
    `build-dispatch-prompt: 卡类型 ${CARD_TYPE_LABELS[type]}（${typeSource}）；验证等级 ${CARD_LEVEL_LABELS[level]}（${levelOrigin}）\n`,
  );
  // 必填段门槛（#120/B6-2，E1 V7）：缺任一段默认拒发——点名缺哪段，且不产出任何 prompt；
  // --allow-partial 显式放行调试口（仍点名，不静默）。
  if (missing.length > 0) {
    process.stderr.write(`build-dispatch-prompt: 缺段点名：${missing.join("、")}\n`);
    if (opt["allow-partial"] !== true) {
      process.stderr.write(
        `build-dispatch-prompt: 拒发：卡文缺必填段（${missing.join("、")}）；补齐后重试（#120/B6-2，E1 V7）。\n`,
      );
      process.exit(3);
    }
    process.stderr.write("build-dispatch-prompt: --allow-partial 显式放行缺段（E1 V7 默认拒发；仅调试/对照用）。\n");
  }
  // 未验证面空清单拒发（#124/B6-6，E1 V27）：显式给了清单却 0 项=提取失败，不静默省略注入。
  if (unverified !== null && unverified.items.length === 0) {
    process.stderr.write(
      `build-dispatch-prompt: 拒发：未验证面清单为空（0 项；来源 ${unverified.path}）——显式注入不得静默省略，补全后重试（E1 V27）。\n`,
    );
    process.exit(3);
  }
  if (unverified !== null) {
    process.stderr.write(`build-dispatch-prompt: 未验证面注入 ${unverified.items.length} 项（来源 ${unverified.path}）\n`);
  }

  const out = [
    `# 派发 prompt 骨架 —— ${card.label}（${noTag}）· 责任 ${role}`,
    `<!-- 机械拼装：build-dispatch-prompt.mjs（#119/B6-1；E1 V6——约束块随派发全文内嵌，杜绝手打遗漏）。`,
    `     卡文来源：${sourcePath}（只读抽取，不改写）；约束块来源：${constraintsPath}。 -->`,
    "",
    "## 1. 卡文原文（不得改写；两必填段随文可见）",
    blockText,
    "",
    "## 2. 约束块（随派发全文内嵌）",
    constraints,
    "",
    "## 3. 证据路径（绝对路径，原样使用）",
    opt.evidence,
    "",
    "## 4. 角色与绿数",
    `- 责任角色：${role}`,
    `- 卡类型：${CARD_TYPE_LABELS[type]}（${typeSource}）`,
    `- 验证等级：${CARD_LEVEL_LABELS[level]}（${levelSource}）`,
    "- 验证等级三层（SKILL.md §6.5）：正式卡 = 完整三绿（implementer → test-verifier 独立 → code-reviewer 两维）+ UI 面卡第四绿（ui-designer）；跟进卡 = 第一绿 + 回归全绿 + 批量验证；微卡 = 第一绿 + 回归全绿。",
    "- UI 卡浏览器断言（改动面含布局/交互时）：溢出探针 + 点击路由后断言 DOM；SSR 结构断言不构成行为证据。",
    `- 需齐绿清单（${CARD_TYPE_LABELS[type]} × ${CARD_LEVEL_LABELS[level]}；SKILL.md §6.5 验证三层 + 第四绿 + 浏览器断言口径；与 #100/B2-2 gate-merge 合并强制面同口径）：`,
    ...checklist.map((item) => `  - ${item}`),
    "",
    "## 5. 只读边界",
    "- 子智能体对板文件只读、不写任何板文件；报告必须带 run_event 块；merge 事实经 integrator 报告落账。",
    "- 证据路径原样使用；卡文不得改写；两必填段为派发门槛（缺段默认拒发，E1 V7；检出结果见拼装日志 stderr）。",
  ];
  // ⑥ 未验证面注入（#124/B6-6，E1 V27）：一行一项逐条随文，杜绝待办自述在「多轮全绿」中沉底。
  if (unverified !== null) {
    out.push(
      "",
      `## 6. 未验证面（注入清单；来源：${unverified.path}；共 ${unverified.items.length} 项——派发时随文可见，E1 V27）`,
      ...unverified.items.map((item) => `- ${item}`),
    );
  }
  out.push("");

  const promptText = out.join("\n");

  if (opt.out) {
    const outPath = resolve(opt.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, promptText, "utf8");
    process.stderr.write(`build-dispatch-prompt: 已写出 ${outPath}\n`);
  } else {
    process.stdout.write(promptText);
    process.stderr.write("build-dispatch-prompt: 已输出 stdout\n");
  }
}

main();
