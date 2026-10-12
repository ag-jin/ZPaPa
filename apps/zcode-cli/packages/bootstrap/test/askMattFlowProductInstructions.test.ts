// 「ask-matt 开发流程」产品 agent 提示面（卡 #212/A11）：Karpathy 四条随开关注入会话系统提示。
//
// 为什么这组用例承重：四条行为纪律此前只随看板派发约束块（#211/A10，编排者域）与评审条目生效，
// 产品内置 agent 的会话系统提示面为空。A11 把同一份四条落进产品提示资产，并复用 A3/A4 的开关
// 判据单点（只有显式 true 才开）——开态四条进入会话系统提示、关/未设置零注入。
// 断言真源：技能仓 constraint-block/3 §行为纪律（A10 用户裁定稿）的四条点名与关键句，
// 不按实现复算；关态反例与注册面/命令面回归另断。
//
// 注入链路：create-app 读 runtimeConfig.askMattFlowEnabled（server-operations 从进程缓存
// context.appRuntimePreferences 写入的同一布尔）→ 本模块 resolve → runtimeConfig.productInstructions
// → core context builder 的 system 段（source=product_instructions）。

import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContextBuilder, type ContextBuilderConfig } from "@zcode/core";
import type { SkillRoot } from "@zcode/contracts";
import { resolveBundledSkillDisabledPaths } from "../src/app/ask-matt-flow-gate.js";
import { resolveAskMattProductInstructions } from "../src/app/ask-matt-product-instructions.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const bundledSkillsRoot = join(
  repoRoot,
  "apps",
  "zcode-cli",
  "packages",
  "bundled-skills",
  "skills",
);

/** 注册面回归用真实内置包资产根（与 A3/A4 矩阵同源）。 */
const bundledRoot: SkillRoot = {
  path: bundledSkillsRoot,
  priority: 1_000_000,
  scope: "system",
  source: "bundled",
};

/** 会话语境最小配置：只固定环境事实，其余段（skills/memory/date）留空不参与本卡断言。 */
function buildSessionContext(productInstructions: string | undefined): string {
  const config: ContextBuilderConfig = {
    envInfo: {
      cwd: repoRoot,
      nodeVersion: "test",
      osVersion: "test",
      platform: "test",
      shell: "test",
    },
    productInstructions,
    workingDirectory: repoRoot,
  };
  const result = createContextBuilder(config).build();
  return result.systemMessages
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n\n");
}

/**
 * 独立真源：constraint-block/3 §行为纪律（#211/A10）四条点名 + 各条关键句锚点。
 * 锚点用于「每条可点名」的机械判据；措辞与模板同源，实现漂移即红。
 */
const KARPATHY_POINTS: ReadonlyArray<{ name: string; anchor: RegExp }> = [
  { name: "Think Before Coding", anchor: /Think Before Coding[^]*?假设/ },
  { name: "Simplicity First", anchor: /Simplicity First[^]*?最小改动/ },
  { name: "Surgical Changes", anchor: /Surgical Changes[^]*?只碰必须碰的/ },
  { name: "Goal-Driven Execution", anchor: /Goal-Driven Execution[^]*?可验证判据/ },
];

test("提示资产 · 开态：四条全文各句可点名（含取舍引言）", () => {
  const text = resolveAskMattProductInstructions(true);
  assert.ok(text, "开态必须产出产品提示资产全文");
  for (const point of KARPATHY_POINTS) {
    assert.ok(text.includes(point.name), `四条必须点名：${point.name}`);
    assert.match(text, point.anchor, `${point.name} 的关键句必须与模板同源`);
  }
  // 简短引言：取舍声明（与上游 Karpathy Guidelines 的 Tradeoff 及约束块 §行为纪律同源）。
  assert.match(text, /谨慎而非速度/, "引言必须含取舍声明（偏向谨慎而非速度）");
  assert.match(text, /琐碎任务自行裁量/, "引言必须含琐碎任务自行裁量的边界");
});

test("提示资产 · 关态：显式 false 与未设置（未加载缓存）零文本（fail-closed，与 A3/A4 判据同源）", () => {
  assert.equal(
    resolveAskMattProductInstructions(false),
    undefined,
    "关态必须零文本（不产出任何字节）",
  );
  assert.equal(
    resolveAskMattProductInstructions(undefined),
    undefined,
    "未设置必须零文本（fail-closed，只有显式 true 才开）",
  );
});

test("会话提示 · 开态：四条进入 system messages（source=product_instructions 段）", () => {
  const text = buildSessionContext(resolveAskMattProductInstructions(true));
  for (const point of KARPATHY_POINTS) {
    assert.ok(text.includes(point.name), `开态会话系统提示必须含 ${point.name}`);
  }
  assert.match(text, /谨慎而非速度/, "开态会话系统提示必须含取舍引言");
});

test("会话提示 · 关态（含未设置与不传字段）：零注入反例——四条一个字节都不进系统提示", () => {
  const sessions = [
    buildSessionContext(resolveAskMattProductInstructions(false)),
    buildSessionContext(resolveAskMattProductInstructions(undefined)),
    buildSessionContext(undefined),
  ];
  for (const text of sessions) {
    for (const point of KARPATHY_POINTS) {
      assert.ok(!text.includes(point.name), `关态系统提示不得出现 ${point.name}`);
    }
    assert.ok(!text.includes("Karpathy"), "关态系统提示不得残留本资产任何文本");
  }
});

test("接线守卫 · create-app 从同一开关单点写出 productInstructions，core 透传到 builder（漏一处 = 开态半件）", () => {
  const createAppSource = readFileSync(resolve(testDir, "../src/app/create-app.ts"), "utf8");
  assert.match(
    createAppSource,
    /runtimeConfig\.productInstructions\s*=\s*resolveAskMattProductInstructions\(\s*runtimeConfig\.askMattFlowEnabled,?\s*\)/,
    "create-app 必须从 runtimeConfig.askMattFlowEnabled 单点解析产品提示（与 skillPort/命令展开同源）",
  );
  const coreContextSource = readFileSync(
    resolve(testDir, "../../core/src/runtime/methods/context.ts"),
    "utf8",
  );
  assert.match(
    coreContextSource,
    /productInstructions:\s*this\.config\.productInstructions/,
    "core context 装配点必须透传 productInstructions（漏传 = 开态零注入）",
  );
});

test("回归 · 注册面/命令面与本卡提示资产零牵连：三面各自只消费同一开关单点", () => {
  const expectedGrillingManifest = join(bundledSkillsRoot, "grilling", "SKILL.md");
  for (const askMatt of [false, undefined, true] as const) {
    const cell = `askMatt=${String(askMatt)}`;
    // 注册面（A3 判据）：关态全库零注册（grilling 被禁用），开态流程技能可注册。
    const disabled = resolveBundledSkillDisabledPaths({
      askMattFlowEnabled: askMatt,
      bundledSkillRoots: [bundledRoot],
      configDisabledPaths: [],
    });
    assert.equal(
      disabled.includes(expectedGrillingManifest),
      askMatt !== true,
      `${cell}：注册面 grilling 禁用状态只随开关（本卡不改注册面）`,
    );
    // 命令面（A4 判据）：开态 /grill 展开、关态零展开。
    assert.equal(
      resolveZCodeBuiltinPromptCommand("/grill 打磨这个想法", { askMattFlowEnabled: askMatt }) !==
        undefined,
      askMatt === true,
      `${cell}：命令面 /grill 展开只随开关（本卡不改命令面）`,
    );
    // 提示面（本卡）：与上面两面同判据——开态四条、关态零文本。
    assert.equal(
      resolveAskMattProductInstructions(askMatt) !== undefined,
      askMatt === true,
      `${cell}：提示面注入只随开关（fail-closed）`,
    );
  }
});
