#!/usr/bin/env node
/**
 * zcode-board / board-health —— 板体检一条命令：#160（E1c-1）四绿总览
 *
 * 存在原因（卡 #160；裁决④「上板/部署/hook 启用三检查点」；用户 2026-10-10「多检查点，刚才才开始
 * 测试就一堆错误」）：#73 已把检查点命令落为 `--preflight` / `--doctor`（上板 / 部署），第三关
 * 「hook 启用」此前只有分散的四处证据（审计、hooks 套件、信任评审、探针）——人读链路各自为政，
 * 任一不绿没有单一出口与退出码。本命令把这四绿**聚合为一条命令**（只聚合、不重判：判定源仍是
 * 既有命令与既有记录），输出分级清单 + 指引 + 退出码语义（绿 0 / 黄 1 / 红 2），每绿可 `--only` 下钻。
 *
 * 四绿（判定源单源，不自造判据）：
 *   ① --check 审计（`compile-board.mjs <root> --check`）：绿 = 退出码 0（0 项失败）。
 *   ② hooks 套件（`assets/test/run-t13-hooks.mjs`，`--suite` 可覆盖入口）：绿 = 退出码 0（全过）。
 *   ③ 信任状态（只读采集，零写入）：`.zcode/config.json` 的 hook 声明 ↔ 应用信任仓
 *      （`~/.zcode/security/workspace-hook-trust-v1.json`，`--trust-store` 可覆盖）逐条对账——
 *      绿 = 声明齐（有 hooks 包装层、enabled=true）且每条声明有身份面一致的 trusted 记录、
 *      且配置编辑不晚于最近授信（摘要失效判黄）。声明结构/路径健壮性的权威面在 `--doctor`
 *      （SKILL §3.12 检查点 2），本绿不重判，只做「可评审性 + 评审状态」。
 *   ④ 探针触发（副本域）：按声明以合成载荷**实际触发** hook 脚本，断言退出码与输出契约
 *      （板摘要单 JSON / 落账 / 重编译 / 兜底重编译 / 归档移动与 Bash 源变更提示 / 板文件禁写）。
 *
 * 用法：
 *   node assets/tools/board-health.mjs [<项目根>] [--only <check|hooks|trust|probe>]
 *                                      [--suite <套件入口>] [--trust-store <信任仓路径>]
 *   node assets/tools/board-health.mjs --help
 *
 * 退出码：0 = 四绿齐；1 = 有黄（人工确认后继续）；2 = 有红（先整改并重跑检查点）；用法错误同为 2。
 *
 * 边界：默认四绿全跑（hooks 套件约 40 秒级）；③只读；④只在 mktemp 副本域触发（真实板零写入）；
 * 不执行 git；不写板/registry/源文件；无第三方依赖（仅 node 内置）。
 */

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROG = "board-health";
const SELF = fileURLToPath(import.meta.url);
const HERE = dirname(SELF);
const SKILL_ROOT = resolve(HERE, "..", "..");
const COMPILER = join(SKILL_ROOT, "assets", "compile-board.mjs");
const DEFAULT_SUITE = join(SKILL_ROOT, "assets", "test", "run-t13-hooks.mjs");
/** 应用信任仓（只读；平台固定路径，`--trust-store` 覆盖）。 */
const DEFAULT_TRUST_STORE = join(process.env.HOME ?? "", ".zcode", "security", "workspace-hook-trust-v1.json");

const CHECK_TIMEOUT_MS = 120000;
const SUITE_TIMEOUT_MS = 300000;
const PROBE_TIMEOUT_MS = 120000;
const DETAIL_LINES = 20;

const LEVELS = Object.freeze({ GREEN: "绿", YELLOW: "黄", RED: "红" });

const USAGE = `用法：
  node assets/tools/board-health.mjs [<项目根>] [--only <check|hooks|trust|probe>]
                                     [--suite <套件入口>] [--trust-store <信任仓路径>]

  <项目根>          项目根（缺省 = 当前目录）；板体检四绿作用于该根
  --only <名>       只跑并下钻该绿（check / hooks / trust / probe）：输出该绿明细与结论
  --suite <路径>   ② hooks 套件入口（缺省 <技能根>/assets/test/run-t13-hooks.mjs）
  --trust-store <路径>  ③ 应用信任仓路径（缺省 ~/.zcode/security/workspace-hook-trust-v1.json；只读）
四绿：①--check 审计 / ②hooks 套件 / ③信任状态（声明↔信任仓对账）/ ④探针触发（副本域实触发）
退出码：0 = 四绿齐；1 = 有黄（人工确认后继续）；2 = 有红（先整改并重跑检查点）；用法错误同为 2。`;

function die(msg, code = 2) {
  process.stderr.write(`${PROG}: ${msg}\n${USAGE}\n`);
  process.exit(code);
}

function isFile(p) {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function basenameOf(p) {
  return basename(p);
}

/** 写文件（自动建目录；仅用于副本域探针夹具）。 */
function writeRel(root, rel, content) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opt = { root: null, only: null, suite: null, trustStore: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    }
    if (a === "--only" || a === "--suite" || a === "--trust-store") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) die(`选项 ${a} 缺少取值`);
      if (a === "--only") opt.only = v;
      else if (a === "--suite") opt.suite = v;
      else opt.trustStore = v;
      i += 1;
      continue;
    }
    if (a.startsWith("--")) die(`未知选项 ${a}`);
    if (opt.root !== null) die(`多余的位置参数 ${a}`);
    opt.root = a;
  }
  if (opt.only !== null && !["check", "hooks", "trust", "probe"].includes(opt.only)) {
    die(`--only 取值须为 check|hooks|trust|probe，收到 ${JSON.stringify(opt.only)}`);
  }
  return opt;
}

// ---------------------------------------------------------------- ① --check 审计

/** ①--check 审计：判定源 = 编译器自身（退出码 + 原输出末 20 行做下钻明细）。 */
function assessCheck(root) {
  const row = { id: "check", no: "①", label: "--check 审计" };
  if (!isFile(COMPILER)) {
    return { ...row, level: LEVELS.RED, summary: `编译器缺失：${COMPILER}`, detail: [], guidance: "技能包安装不完整：重装或运行 --doctor 体检。" };
  }
  const drill = `node ${COMPILER} ${root} --check`;
  const r = spawnSync(process.execPath, [COMPILER, root, "--check"], { encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
  const stdout = String(r.stdout ?? "");
  const outLines = stdout.trimEnd() === "" ? [] : stdout.trimEnd().split("\n");
  const tail = outLines.slice(-DETAIL_LINES);
  const detail = tail.map((l) => `  ${l}`);
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    const why = r.error ? r.error.message : `退出码 ${String(r.status)}（用法/环境错误）`;
    return { ...row, level: LEVELS.RED, summary: `未完成审计：${why}`, detail, drill, guidance: "核对编译器可用性与参数后重跑。" };
  }
  const conclusion = [...outLines].reverse().find((l) => l.startsWith("结论：")) ?? "";
  if (r.status === 0) {
    return { ...row, level: LEVELS.GREEN, summary: "通过（0 项失败）", detail, drill };
  }
  const m = /失败（([0-9]+) 项失败）/.exec(conclusion);
  const count = m === null ? "?" : m[1];
  return {
    ...row,
    level: LEVELS.RED,
    summary: `失败 ${count} 项`,
    detail,
    drill,
    guidance: `先重编译（node ${COMPILER} ${root}）修复可机械恢复项，再重跑本行；逐条失败项见下钻输出。`,
  };
}

// ---------------------------------------------------------------- ② hooks 套件

/** ②hooks 套件：判定源 = 套件自身（退出码 + 末行「结论：通过 N，失败 M」）。 */
function assessHooksSuite(root, opt) {
  const row = { id: "hooks", no: "②", label: "hooks 套件" };
  const suite = opt.suite === null ? DEFAULT_SUITE : resolve(opt.suite);
  const drill = `node ${suite}`;
  if (!isFile(suite)) {
    return {
      ...row,
      level: LEVELS.RED,
      summary: `套件入口缺失：${suite}`,
      detail: [],
      drill,
      guidance: "技能包安装不完整：重装技能或核对 --suite 入口后重跑检查点。",
    };
  }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [suite], { encoding: "utf8", timeout: SUITE_TIMEOUT_MS });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const stdout = String(r.stdout ?? "");
  const outLines = stdout.trimEnd() === "" ? [] : stdout.trimEnd().split("\n");
  const detail = outLines.slice(-DETAIL_LINES).map((l) => `  ${l}`);
  if (r.error) {
    return { ...row, level: LEVELS.RED, summary: `未完成：${r.error.message}`, detail, drill, guidance: "核对套件可用性与超时预算后重跑。" };
  }
  const conclusion = [...outLines].reverse().find((l) => l.startsWith("结论：")) ?? "";
  const m = /通过\s*([0-9]+)[，,]\s*失败\s*([0-9]+)/.exec(conclusion);
  const passN = m === null ? "?" : m[1];
  const failN = m === null ? "?" : m[2];
  if (r.status === 0) {
    return { ...row, level: LEVELS.GREEN, summary: `通过 ${passN}/${failN}（${secs}s）`, detail, drill };
  }
  return {
    ...row,
    level: LEVELS.RED,
    summary: `失败 ${failN} 项（通过 ${passN}；${secs}s）`,
    detail,
    drill,
    guidance: `逐条失败见下钻输出；修 hooks 后重跑（node ${suite}）。`,
  };
}

// ---------------------------------------------------------------- ③ 信任状态（只读采集）

/** hook 声明摊平：{event, matcher, matcherIndex, hookIndex, hook}（与编辑器/套件同形态）。 */
function collectDeclarations(cfg) {
  const out = [];
  const events = cfg?.hooks?.events;
  if (events === undefined || events === null || typeof events !== "object" || Array.isArray(events)) return out;
  for (const [event, decls] of Object.entries(events)) {
    if (!Array.isArray(decls)) continue;
    decls.forEach((d, matcherIndex) => {
      const hooks = Array.isArray(d?.hooks) ? d.hooks : [];
      hooks.forEach((h, hookIndex) => out.push({ event, matcher: d?.matcher ?? null, matcherIndex, hookIndex, hook: h }));
    });
  }
  return out;
}

/** 声明指向的脚本绝对路径（args 内首个 .mjs；无 → null）。 */
function declaredScript(root, decl) {
  const args = Array.isArray(decl?.hook?.args) ? decl.hook.args : [];
  const raw = args.find((a) => typeof a === "string" && a.endsWith(".mjs"));
  if (raw === undefined) return null;
  return isAbsolute(raw) ? raw : resolve(root, raw);
}

function readJson(p) {
  try {
    return { ok: true, value: JSON.parse(readFileSync(p, "utf8")) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 工作区身份集合（AGENTS.md 身份口径：workspaceIdentity 优先、路径兜底；真实路径消解软链）。 */
function identityKeys(root) {
  const keys = new Set([resolve(root)]);
  try {
    keys.add(realpathSync(root));
  } catch {
    /* 不可消解则保留 resolve 形态 */
  }
  const env = (process.env.ZCODE_WORKSPACE_IDENTITY ?? "").trim();
  if (env !== "") keys.add(env);
  return keys;
}

/**
 * ③信任状态（只读零写入）：config 声明 ↔ 应用信任仓逐条对账。
 *   绿：有 hooks 包装层、enabled=true、≥1 条声明，且每条声明有身份面一致的 trusted 记录，
 *       且配置编辑不晚于最近授信（摘要未失效）。
 *   黄：未启用（无 config/无声明/enabled≠true）、有未评审声明、配置在授信后被编辑、信任仓不可读。
 *   红：config 不可解析 / 缺 hooks 包装层（A5 实测被静默跳过、不提示评审）。
 * 边界：应用侧摘要算法不可复算（声明摘要由应用计算）；本绿以记录自带身份字段
 * （event/matcher/序号/源路径）+ 时间序对账，不重判声明结构健壮性（权威面 = --doctor）。
 */
function assessTrust(root, opt) {
  const row = { id: "trust", no: "③", label: "信任状态" };
  const cfgPath = join(root, ".zcode", "config.json");
  const drill = `node ${SELF} ${root} --only trust`;
  if (!existsSync(cfgPath)) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: "未声明 hook（hook 未启用）",
      detail: [`  ${cfgPath} 不存在。`],
      drill,
      guidance: "启用步骤见 SKILL.md §3.6（五项声明 + 一次性信任评审）；声明结构权威体检 = --doctor。",
    };
  }
  const loaded = readJson(cfgPath);
  if (!loaded.ok) {
    return {
      ...row,
      level: LEVELS.RED,
      summary: `config.json 解析失败（${loaded.error}）`,
      detail: [`  ${cfgPath}`],
      drill,
      guidance: "坏 JSON 使声明整体失效：先修好 JSON，再重做一次性信任评审。",
    };
  }
  const hooks = loaded.value?.hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== "object" || Array.isArray(hooks)) {
    return {
      ...row,
      level: LEVELS.RED,
      summary: "缺 hooks 包装层（声明被静默跳过、不提示评审）",
      detail: [`  ${cfgPath}`],
      drill,
      guidance: "补 hooks 包装层（模板见 SKILL.md §3.6）后重做一次性信任评审。",
    };
  }
  if (hooks.enabled !== true) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: `hooks.enabled=${JSON.stringify(hooks.enabled)}（声明未开启）`,
      detail: [`  ${cfgPath}`],
      drill,
      guidance: "将 hooks.enabled 置 true（模板见 SKILL.md §3.6）后重做一次性信任评审。",
    };
  }
  const decls = collectDeclarations(loaded.value);
  if (decls.length === 0) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: "无声明条目（hook 未启用）",
      detail: [`  ${cfgPath}`],
      drill,
      guidance: "五项声明模板见 SKILL.md §3.6；声明后完成一次性信任评审。",
    };
  }

  const storePath = opt.trustStore === null ? DEFAULT_TRUST_STORE : resolve(opt.trustStore);
  const storeExists = existsSync(storePath);
  const store = storeExists ? readJson(storePath) : { ok: false, error: "文件不存在" };
  if (!store.ok) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: `信任仓不可读（${store.error}）——评审状态不可判定`,
      detail: [`  ${storePath}`, `  声明 ${decls.length} 条（${cfgPath}）。`],
      drill,
      guidance: "核对 --trust-store 路径；未评审前 hook 一律 pending、不执行（评审命令见 SKILL.md §3.6）。",
    };
  }
  const keys = identityKeys(root);
  const records = (Array.isArray(store.value?.records) ? store.value.records : []).filter((r) =>
    keys.has(String(r?.workspaceIdentity ?? "").trim()),
  );
  const detail = [
    `  声明面权威体检（脚本在位/可执行/版本/路径）：node ${COMPILER} ${root} --doctor`,
    `  信任仓：${storePath}（本工作区记录 ${records.length} 条）`,
  ];
  const unmatched = [];
  let latestMs = null;
  let appVersion = null;
  for (const d of decls) {
    const label = `${d.event}${d.matcher === null ? "" : `(${d.matcher})`}`;
    const rec = records.find(
      (r) =>
        r?.decision === "trusted" &&
        r.eventAtGrant === d.event &&
        (r.matcherAtGrant ?? null) === d.matcher &&
        r.matcherIndexAtGrant === d.matcherIndex &&
        r.hookIndexAtGrant === d.hookIndex &&
        r.sourcePathAtGrant === ".zcode/config.json",
    );
    if (rec === undefined) {
      unmatched.push(label);
      detail.push(`  - ${label}：未评审（无 trusted 记录）`);
      continue;
    }
    const at = Date.parse(String(rec.grantedAt));
    if (Number.isFinite(at) && (latestMs === null || at > latestMs)) latestMs = at;
    appVersion = rec.appVersionAtGrant ?? appVersion;
    detail.push(`  - ${label}：trusted（授信 ${rec.grantedAt}${rec.appVersionAtGrant === undefined ? "" : `；应用 ${rec.appVersionAtGrant}`}）`);
  }
  const reviewed = decls.length - unmatched.length;
  if (unmatched.length > 0) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: `${reviewed}/${decls.length} 项声明已评审——未评审：${unmatched.join("、")}`,
      detail,
      drill,
      guidance:
        "未完成一次性信任评审（未评审前 hook 一律 pending、不执行）：zcode hooks trust review|grant" +
        "（--workspace <路径/身份> --all-current；见 SKILL.md §3.6）；声明面先跑 `--doctor` 核对。",
    };
  }
  const cfgMtime = statSync(cfgPath).mtimeMs;
  if (latestMs !== null && cfgMtime > latestMs + 1000) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: `${decls.length}/${decls.length} 项声明已评审，但配置在授信后被编辑（摘要失效）`,
      detail,
      drill,
      guidance: "任何配置编辑（声明/顺序/超时/输出上限）都会使既有信任记录失效——重做一次性信任评审。",
    };
  }
  const atText = latestMs === null ? "未记" : new Date(latestMs).toISOString();
  return {
    ...row,
    level: LEVELS.GREEN,
    summary: `${decls.length}/${decls.length} 项声明已评审（trusted；最近授信 ${atText}${appVersion === null ? "" : `；应用 ${appVersion}`}）`,
    detail,
    drill,
  };
}

// ---------------------------------------------------------------- ④ 探针触发（副本域）

/** 探针载荷公共字段（形态对齐 A5 evidence §2.2 / t13 夹具）。 */
function payloadBase(root) {
  return {
    cwd: root,
    mode: "agent",
    sessionId: "sess_board_health",
    session_id: "sess_board_health",
    traceId: "trace_board_health",
    turnId: "turn_board_health",
    timestamp: new Date().toISOString(),
  };
}

const PROBE_PLAN_REL = ".zcode/plans/plan-health.md";
const PROBE_PLAN_NO = 990;
const PROBE_PLAN_CARD = 991;
const PROBE_NEW_REL = ".zcode/plans/plan-health-new.md";
const PROBE_NEW_NO = 992;

/**
 * 探针规格（按声明脚本 basename 归类；B3 新检测面在 watch-sources 三例与 reconcile-stop 一例）：
 *   每例 = 合成载荷 → 真实 hook 脚本；断言只用公开可观测面（退出码 / stdout 形态 / 副本域文件效果 /
 *   hook 的 stderr 告警文案——watch-sources 的 Bash 通道输出即 stderr 告警本身）。
 */
const PROBE_SPECS = {
  "board-context.mjs": [
    {
      key: "board-context",
      label: "board-context（SessionStart 单 JSON）",
      payload: (copy) => ({ ...payloadBase(copy), hookEventName: "SessionStart", hook_event_name: "SessionStart", source: "startup" }),
      verify: (res) => {
        let parsed = null;
        try {
          parsed = JSON.parse(String(res.stdout ?? "").trim());
        } catch {
          parsed = null;
        }
        return res.status === 0 && parsed !== null && typeof parsed.additionalContext === "string"
          ? { ok: true, note: "exit 0 + 单 JSON（additionalContext 字符串）" }
          : { ok: false, note: `退出码 ${res.status}；stdout 非单 JSON 或缺 additionalContext` };
      },
    },
  ],
  "record-run.mjs": [
    {
      key: "record-run",
      label: "record-run（落账 + 重编译）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PostToolUse",
        hook_event_name: "PostToolUse",
        tool_name: "Agent",
        toolName: "Agent",
        tool_input: { description: "体检探针", prompt: "体检探针", subagent_type: "implementer" },
        tool_response: {
          status: "completed",
          content: [
            {
              type: "text",
              text: [
                "## 体检探针报告",
                "```json",
                `{ "run_event": { "runId": "run-board-health-probe", "role": "implementer", "result": "done", "cards": [${PROBE_PLAN_NO}], "next": "探针" } }`,
                "```",
              ].join("\n"),
            },
          ],
        },
      }),
      verify: (res, copy) => {
        if (res.status !== 0) return { ok: false, note: `退出码 ${res.status}（hook 不阻塞契约要求 0）` };
        const runs = readJson(join(copy, ".zcode", "board", "runs.json"));
        const hit = runs.ok && Array.isArray(runs.value?.runs) && runs.value.runs.some((x) => (x?.cards ?? []).includes(PROBE_PLAN_NO));
        return hit ? { ok: true, note: "exit 0 + 副本域 runs.json 追加含该探针卡号" } : { ok: false, note: "runs.json 未追加（落账未生效）" };
      },
    },
  ],
  "watch-sources.mjs": [
    {
      key: "watch-sources-write",
      label: "watch-sources（Write 新源 → 重编译）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PostToolUse",
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        toolName: "Write",
        tool_input: { file_path: join(copy, PROBE_NEW_REL), content: "" },
      }),
      verify: (res, copy) => {
        if (res.status !== 0) return { ok: false, note: `退出码 ${res.status}` };
        const board = readJson(join(copy, ".zcode", "board", "board.json"));
        const hit = board.ok && JSON.stringify(board.value).includes(String(PROBE_NEW_NO));
        return hit ? { ok: true, note: "exit 0 + 副本域板已重编译含新源节点" } : { ok: false, note: "副本域板未随新源重编译" };
      },
    },
    {
      key: "watch-sources-bash",
      label: "watch-sources（Bash 源变更告警；B3-1）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PostToolUse",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        toolName: "Bash",
        tool_input: { command: `echo "<!-- probe -->" >> ${PROBE_PLAN_REL}` },
        tool_response: { exitCode: 0 },
      }),
      verify: (res) =>
        res.status === 0 && String(res.stdout ?? "") === "" && /板陈旧告警/.test(String(res.stderr ?? ""))
          ? { ok: true, note: "exit 0 + stdout 恒空 + stderr 板陈旧告警（指向重编译）" }
          : { ok: false, note: `退出码 ${res.status}；stderr 未出现板陈旧告警` },
    },
    {
      key: "watch-sources-archive",
      label: "watch-sources（归档移动合法转移提示；B3-2）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PostToolUse",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        toolName: "Bash",
        tool_input: { command: `git mv ${PROBE_NEW_REL} .zcode/archive/plan-health-new.md` },
        tool_response: { exitCode: 0 },
      }),
      verify: (res) =>
        res.status === 0 && /合法转移提示/.test(String(res.stderr ?? ""))
          ? { ok: true, note: "exit 0 + stderr 合法转移提示（指向 --assign 改写，不判违规）" }
          : { ok: false, note: `退出码 ${res.status}；stderr 未出现合法转移提示` },
    },
  ],
  "reconcile-stop.mjs": [
    {
      key: "reconcile-stop",
      label: "reconcile-stop（兜底重编译；B3-3）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "Stop",
        hook_event_name: "Stop",
        responseText: "探针收尾",
        last_assistant_message: "探针收尾",
        stopHookActive: false,
      }),
      verify: (res, copy) =>
        res.status === 0 && String(res.stdout ?? "") === "" && isFile(join(copy, ".zcode", "board", "last-reconcile.md"))
          ? { ok: true, note: "exit 0 + stdout 恒空 + 副本域 last-reconcile.md 已写（兜底重编译完成）" }
          : { ok: false, note: `退出码 ${res.status}；stdout 非空或副本域未写 last-reconcile.md` },
    },
  ],
  "gate-merge.mjs": [
    {
      key: "gate-merge",
      label: "gate-merge（非合并命令放行）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PreToolUse",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        toolName: "Bash",
        tool_input: { command: "git status" },
      }),
      verify: (res) => (res.status === 0 ? { ok: true, note: "exit 0（非卡片合并命令放行）" } : { ok: false, note: `退出码 ${res.status}（应放行）` }),
    },
  ],
  "guard-board.mjs": [
    {
      key: "guard-board",
      label: "guard-board（板数据文件禁写）",
      payload: (copy) => ({
        ...payloadBase(copy),
        hookEventName: "PreToolUse",
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        toolName: "Write",
        tool_input: { file_path: join(copy, ".zcode", "board", "board.json"), content: "{}" },
      }),
      verify: (res) =>
        res.status === 2 && /阻断/.test(String(res.stderr ?? ""))
          ? { ok: true, note: "exit 2 + stderr 阻断点名（板数据文件禁写）" }
          : { ok: false, note: `退出码 ${res.status}；未出现阻断点名` },
    },
  ],
};

/** 事件兜底载荷（未识别脚本的通用触发；只断言不阻塞契约）。 */
function genericPayloadFor(decl, copy) {
  if (decl.event === "SessionStart") {
    return { ...payloadBase(copy), hookEventName: "SessionStart", hook_event_name: "SessionStart", source: "startup" };
  }
  if (decl.event === "Stop") {
    return { ...payloadBase(copy), hookEventName: "Stop", hook_event_name: "Stop", responseText: "探针", last_assistant_message: "探针", stopHookActive: false };
  }
  if (decl.event === "PreToolUse") {
    return { ...payloadBase(copy), hookEventName: "PreToolUse", hook_event_name: "PreToolUse", tool_name: "Bash", toolName: "Bash", tool_input: { command: "git status" } };
  }
  return {
    ...payloadBase(copy),
    hookEventName: "PostToolUse",
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    toolName: "Write",
    tool_input: { file_path: join(copy, PROBE_PLAN_REL), content: "" },
  };
}

/**
 * ④探针触发：按**声明**以合成载荷实际触发 hook 脚本（副本域 = 系统临时目录最小板项目，
 * 真实板零触碰），断言退出码与输出契约。分母 = 实际触发的探针数（B3 面同入：watch-sources
 * 的 Bash 源变更/归档移动两例 + reconcile-stop 兜底重编译一例）。
 */
function triggerProbes(root, opt) {
  const row = { id: "probe", no: "④", label: "探针触发" };
  const drillSelf = `node ${SELF} ${root} --only probe`;
  const cfgPath = join(root, ".zcode", "config.json");
  const loaded = existsSync(cfgPath) ? readJson(cfgPath) : { ok: false, error: "config.json 不存在" };
  const decls = loaded.ok ? collectDeclarations(loaded.value) : [];
  if (decls.length === 0) {
    return {
      ...row,
      level: LEVELS.YELLOW,
      summary: "无声明可触发（hook 未启用）",
      detail: [`  ${cfgPath}：${loaded.ok ? "无声明条目" : loaded.error}。`],
      drill: drillSelf,
      guidance: "先用 §3.6 模板写入五项声明并完成一次性信任评审，再重跑本行（③同因，见上）。",
    };
  }

  // 探针清单：声明 → 脚本 → 规格（同规格去重；未识别脚本走通用触发）
  const planned = [];
  const seen = new Set();
  for (const d of decls) {
    const script = declaredScript(root, d);
    if (script === null) {
      planned.push({ key: `no-script:${d.event}`, label: `${d.event} 声明无脚本路径`, script: null, decl: d, spec: null });
      continue;
    }
    const specs = PROBE_SPECS[basenameOf(script)] ?? [
      { key: `generic:${script}`, label: `${basenameOf(script)}（通用触发）`, payload: (copy) => genericPayloadFor(d, copy), verify: (res) => (res.status === 0 ? { ok: true, note: "exit 0（不阻塞契约）" } : { ok: false, note: `退出码 ${res.status}（hook 应不阻塞）` }) },
    ];
    for (const spec of specs) {
      if (seen.has(spec.key)) continue;
      seen.add(spec.key);
      planned.push({ ...spec, script, decl: d });
    }
  }

  // 副本域：最小板项目（真实板零触碰）
  const copy = mkdtempSync(join(tmpdir(), "board-health-probe-"));
  writeRel(copy, PROBE_PLAN_REL, ["# 体检探针稿 <!-- zcode-board: no=990 -->", "", `- [ ] 体检探针卡 <!-- zcode-board: no=${PROBE_PLAN_CARD} -->`, ""].join("\n"));
  writeRel(copy, PROBE_NEW_REL, [`# 体检探针新源稿 <!-- zcode-board: no=${PROBE_NEW_NO} -->`, ""].join("\n"));
  mkdirSync(join(copy, ".zcode", "archive"), { recursive: true });
  const base = spawnSync(process.execPath, [COMPILER, copy], { encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
  if (base.status !== 0) {
    return {
      ...row,
      level: LEVELS.RED,
      summary: "副本域基线编译失败（探针无法触发）",
      detail: [`  副本域：${copy}`, `  exit ${String(base.status)}：${String(base.stderr ?? "").trim().slice(0, 300)}`],
      drill: drillSelf,
      guidance: "先修编译器/环境问题（跑 --check / --doctor 定位）再重跑本行。",
    };
  }

  const results = [];
  for (const p of planned) {
    if (p.script === null) {
      results.push({ ...p, ok: false, note: "声明 args 内无 .mjs 脚本路径" });
      continue;
    }
    if (!isFile(p.script)) {
      results.push({ ...p, ok: false, note: `脚本不存在：${p.script}` });
      continue;
    }
    const res = spawnSync(process.execPath, [p.script], {
      input: JSON.stringify(p.payload(copy)),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
    });
    const verdict = res.error ? { ok: false, note: `执行失败：${res.error.message}` } : p.verify(res, copy);
    results.push({ ...p, ok: verdict.ok, note: verdict.note });
  }
  const okCount = results.filter((x) => x.ok).length;
  const detail = results.map((x) => `  - [${x.ok ? LEVELS.GREEN : LEVELS.RED}] ${x.label}：${x.note}`);
  const failed = results.filter((x) => !x.ok);
  if (failed.length === 0) {
    return {
      ...row,
      level: LEVELS.GREEN,
      summary: `${okCount}/${results.length} 探针按契约响应（副本域 ${copy}；真实板零触碰）`,
      detail,
      drill: drillSelf,
    };
  }
  return {
    ...row,
    level: LEVELS.RED,
    summary: `${okCount}/${results.length} 探针按契约响应——不符 ${failed.length} 例`,
    detail,
    drill: drillSelf,
    guidance: `逐例不符见下钻明细；先修 hook 脚本/声明路径（--doctor 体检声明面）再重跑本行。`,
  };
}

// ---------------------------------------------------------------- 聚合与渲染

/** 四绿评估器注册表（id 与 --only 取值同域；`--only` 只跑选中的那一绿）。 */
const ASSESSORS = [
  { id: "check", fn: assessCheck },
  { id: "hooks", fn: assessHooksSuite },
  { id: "trust", fn: assessTrust },
  { id: "probe", fn: triggerProbes },
];

function buildReport(root, opt) {
  const chosen = opt.only === null ? ASSESSORS : ASSESSORS.filter((a) => a.id === opt.only);
  const rows = chosen.map((a) => a.fn(root, opt));
  const red = rows.filter((r) => r.level === LEVELS.RED);
  const yellow = rows.filter((r) => r.level === LEVELS.YELLOW);
  const verdict = red.length > 0 ? LEVELS.RED : yellow.length > 0 ? LEVELS.YELLOW : LEVELS.GREEN;
  return { rows, red, yellow, verdict, exitCode: verdict === LEVELS.GREEN ? 0 : verdict === LEVELS.YELLOW ? 1 : 2 };
}

/** 行核心（不含等级前缀）：`①--check 审计：通过（0 项失败）`。 */
function rowCore(r) {
  return `${r.no}${r.label}：${r.summary}`;
}

function renderRow(r) {
  const drill = r.drill === undefined ? "" : `——下钻：${r.drill}`;
  return `[${r.level}] ${rowCore(r)}${drill}`;
}

function renderConclusion(verdict, red, yellow) {
  if (verdict === LEVELS.GREEN) return "结论：绿（四绿齐——可进入下一步；退出码 0）";
  if (verdict === LEVELS.YELLOW) return `结论：黄（警告 ${yellow.length} 项——人工确认后继续；退出码 1）`;
  return `结论：红（错误 ${red.length} 项——先整改并重跑检查点；退出码 2）`;
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  const rootArg = opt.root ?? process.cwd();
  if (!existsSync(rootArg) || !statSync(rootArg).isDirectory()) die(`项目根不存在或不是目录：${rootArg}`);
  const root = resolve(rootArg);

  const report = buildReport(root, opt);
  const chosen = opt.only === null ? report.rows : report.rows.filter((r) => r.id === opt.only);

  const out = [];
  out.push(`板体检：${root}${opt.only === null ? "" : `（--only ${opt.only}）`}`);
  for (const r of chosen) {
    out.push(renderRow(r));
    if (opt.only !== null) {
      out.push("明细：");
      out.push(...(r.detail.length > 0 ? r.detail : ["  （无）"]));
      out.push(`结论：${r.level}（退出码 ${r.level === LEVELS.GREEN ? 0 : r.level === LEVELS.YELLOW ? 1 : 2}）`);
      if (r.guidance !== undefined) out.push(`处置：${r.guidance}`);
    }
  }
  if (opt.only === null) {
    const items = [...report.red, ...report.yellow];
    if (items.length === 0) {
      out.push("分级清单：无");
    } else {
      out.push(`分级清单（${items.length} 项）：`);
      for (const r of items) out.push(`  - ${r.level}：${rowCore(r)}${r.guidance === undefined ? "" : `；处置：${r.guidance}`}`);
    }
    out.push(renderConclusion(report.verdict, report.red, report.yellow));
  }
  process.stdout.write(`${out.join("\n")}\n`);

  if (opt.only !== null) {
    const row = chosen[0];
    return row.level === LEVELS.GREEN ? 0 : row.level === LEVELS.YELLOW ? 1 : 2;
  }
  return report.exitCode;
}

process.exit(main());
