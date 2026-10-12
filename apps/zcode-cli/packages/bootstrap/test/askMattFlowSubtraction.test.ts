// 「ask-matt 开发流程」三处减法断言（卡 #205/A4；#226/F1 升级为 34 命令口径）：关开关 = 命令面消失 +
// 技能不注册 + 提示不注入。
//
// 卡文验收「关态 grep+面板+清单三面零残留」的机械钉死（半态防线）：三个面各自独立断言关态为零，
// 并给出开态对照（34 条命令全在、37 件技能全注册），任一面漏接开关都会红——「面板没了但手打 /research
// 仍注入」「命令没了但技能仍可装载」这类半态在这里被逐面拦下。
//
// 三面与判据：
//   ①命令面：三处目录同源（session snapshot / workspace presentation / v4 workspace config），
//     执行级调用真实协议函数 + grep 级守卫三处挂点都读进程缓存门；
//   ②注册面：create-app 的判据单点 resolveBundledSkillDisabledPaths + 真实 NodeSkillAdapter
//     （真实内置包资产），关态全库零注册（discover 与 loadSkill 同结论）；
//   ③注入面：resolveZCodeBuiltinPromptCommand 的展开——关态 34 命令均不展开（原文交模型）。
// 独立真源：34 命令名由包内快照文件 + 裁决特例（D1 无命令三件、D5 换名三件、grill 入口名）重算，
// 不复算实现常量。

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import type { ZCodeApp } from "../src/app/types.js";
import { resolveBundledSkillDisabledPaths } from "../src/app/ask-matt-flow-gate.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { buildLiveWorkspaceConfigStateV4 } from "../src/zcode-protocol/v4-workspace-config.js";
import { buildSessionSnapshot } from "../src/zcode-protocol/session-mapper.js";
import { readWorkspacePresentation } from "../src/zcode-protocol/workspace-model-runtime.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const skillsRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills", "skills");
const snapshotPath = join(skillsRoot, ".zcode-skills-snapshot.json");

/**
 * 独立真源：34 命令名 = 包内快照 37 件 - 裁决无命令三件（D1），名字按裁决映射
 * （D5 换名三件 + A3 已交付的 grill 入口名）。测试不复算实现白名单常量。
 */
const VERDICT_NO_COMMAND_SKILLS: readonly string[] = [
  "setup-matt-pocock-skills",
  "claude-handoff",
  "git-guardrails-claude-code",
];
const VERDICT_COMMAND_NAMES: Readonly<Record<string, string>> = {
  "code-review": "matt-code-review",
  grilling: "grill",
  implement: "matt-implement",
  tdd: "matt-tdd",
};
const CARD_COMMAND_NAMES: readonly string[] = expectedCommandNames();

function expectedCommandNames(): string[] {
  const record = JSON.parse(readFileSync(snapshotPath, "utf8")) as { skills: string[] };
  return record.skills
    .filter((skill) => !VERDICT_NO_COMMAND_SKILLS.includes(skill))
    .map((skill) => VERDICT_COMMAND_NAMES[skill] ?? skill);
}

const bundledRoot: SkillRoot = {
  path: skillsRoot,
  priority: 1_000_000,
  scope: "system",
  source: "bundled",
};

async function withTempWorkspace<T>(
  task: (workspace: { workspaceKey: string; workspacePath: string }) => Promise<T>,
): Promise<T> {
  const workspacePath = await mkdtemp(join(tmpdir(), "zcode-ask-matt-subtraction-"));
  try {
    return await task({ workspaceKey: "ws-t205-subtraction", workspacePath });
  } finally {
    await rm(workspacePath, { force: true, recursive: true });
  }
}

/** 协议目录三处共用的最小 app：mapSessionSettings 所需的只读面（与 A3 探针同形）。 */
function createDirectoryApp(sessionId: string) {
  const projection = {
    activeToolCalls: [],
    backgroundTasks: [],
    contextUsed: 0,
    contextWindow: 0,
    id: sessionId,
    mode: "default",
    pendingPermissions: [],
    status: "idle",
    target: null,
    totalTokenCount: 0,
    turnCount: 0,
  };
  return {
    getDefaultThoughtLevel: () => undefined,
    getMode: () => "build",
    getModel: () => "",
    getThoughtLevel: () => undefined,
    listModels: () => [],
    listThoughtLevels: () => [],
    runtime: {
      getActiveTurnInfo: () => undefined,
      getProjection: async () => projection,
      getSessionModelSelection: () => undefined,
    },
    sessionId,
    traceId: `trace-${sessionId}`,
  } as unknown as ZCodeApp;
}

function createPresentationContext(
  workspace: { workspaceKey: string; workspacePath: string },
  askMattFlowEnabled: boolean | undefined,
): ZCodeProtocolAgentServerContext {
  return {
    appRuntimePreferences: { askMattFlowEnabled, dynamicWorkflowEnabled: true },
    deps: { env: {} },
    logger: undefined,
    sessions: new Map([["session-t205", { app: createDirectoryApp("session-t205"), workspace }]]),
  } as unknown as ZCodeProtocolAgentServerContext;
}

/**
 * 执行级读出三处目录的命令名。三处分别是：
 * session snapshot（buildSessionSnapshot 的 slashCommandOptions 挂点，server-operations 同款传参）、
 * workspace presentation（readWorkspacePresentation）、v4 workspace config（buildLiveWorkspaceConfigStateV4）。
 */
async function readThreeDirectoryCommandNames(
  workspace: { workspaceKey: string; workspacePath: string },
  askMattFlowEnabled: boolean | undefined,
): Promise<{ snapshot: string[]; presentation: string[]; v4Config: string[] }> {
  const snapshot = await buildSessionSnapshot({
    app: createDirectoryApp("session-t205"),
    eventSeq: 0,
    fallbackCreatedAt: 1_700_000_000_000,
    fallbackUpdatedAt: 1_700_000_000_000,
    messages: [],
    stateRevision: 0,
    // server-operations.ts 的真实传参同款：门从进程缓存读，本用例显式驱动两种状态。
    slashCommandOptions: {
      askMattFlowEnabled,
      dynamicWorkflowEnabled: true,
      env: {},
      logger: undefined,
    },
    workspace,
  });
  const context = createPresentationContext(workspace, askMattFlowEnabled);
  const presentation = await readWorkspacePresentation(context, { workspace });
  const v4Config = await buildLiveWorkspaceConfigStateV4(context, workspace.workspaceKey);
  return {
    snapshot: snapshot.slashCommands.map((command) => command.name),
    presentation: presentation.slashCommands.map((command) => command.name),
    v4Config: (v4Config?.slashCommands ?? []).map((command) => command.name),
  };
}

test("命令面 · 关态：三处目录零 34 命令（未设置与显式 false 同结论，既有目录不受牵连）", async () => {
  await withTempWorkspace(async (workspace) => {
    for (const askMattFlowEnabled of [undefined, false]) {
      const directories = await readThreeDirectoryCommandNames(workspace, askMattFlowEnabled);
      for (const [surface, names] of Object.entries(directories)) {
        for (const command of CARD_COMMAND_NAMES) {
          assert.ok(
            !names.includes(command),
            `关态 ${surface} 目录不得装配 /${command}：${names.join(",")}`,
          );
        }
        // 面板不得被清空：既有内置命令仍在场（减法只针对 ask-matt 三命令）。
        assert.ok(
          names.includes("init"),
          `关态 ${surface} 的既有内置命令 /init 必须仍在：${names.join(",")}`,
        );
      }
    }
  });
});

test("命令面 · 开态对照：三处目录 34 命令全在（source=builtin）", async () => {
  await withTempWorkspace(async (workspace) => {
    const directories = await readThreeDirectoryCommandNames(workspace, true);
    for (const [surface, names] of Object.entries(directories)) {
      for (const command of CARD_COMMAND_NAMES) {
        assert.ok(names.includes(command), `开态 ${surface} 目录必须装配 /${command}`);
      }
    }
    const context = createPresentationContext(workspace, true);
    const presentation = await readWorkspacePresentation(context, { workspace });
    for (const command of CARD_COMMAND_NAMES) {
      assert.equal(
        presentation.slashCommands.find((entry) => entry.name === command)?.source,
        "builtin",
        `/${command} 必须是内置目录项`,
      );
    }
  });
});

test("命令面 · grep 级守卫：三处目录挂点 + 展开挂点都读开关门（漏一处即红）", () => {
  const callSites: Array<{ file: string; label: string; pattern: RegExp }> = [
    {
      file: "zcode-protocol/server-operations.ts",
      label: "session snapshot",
      pattern:
        /slashCommandOptions:\s*\{[\s\S]{0,600}?askMattFlowEnabled:\s*context\.appRuntimePreferences\.askMattFlowEnabled/,
    },
    {
      file: "zcode-protocol/workspace-model-runtime.ts",
      label: "workspace presentation",
      pattern:
        /listProtocolSlashCommands\(\{[\s\S]{0,600}?askMattFlowEnabled:\s*context\.appRuntimePreferences\.askMattFlowEnabled/,
    },
    {
      file: "zcode-protocol/v4-workspace-config.ts",
      label: "v4 workspace config",
      pattern:
        /listProtocolSlashCommands\(\{[\s\S]{0,600}?askMattFlowEnabled:\s*context\.appRuntimePreferences\.askMattFlowEnabled/,
    },
    {
      file: "app/create-app.ts",
      label: "内置命令展开",
      pattern:
        /resolveZCodeBuiltinPromptCommand\(text,\s*\{[\s\S]{0,600}?askMattFlowEnabled:\s*runtimeConfig\.askMattFlowEnabled/,
    },
  ];
  for (const site of callSites) {
    const source = readFileSync(resolve(testDir, "../src", site.file), "utf8");
    assert.match(
      source,
      site.pattern,
      `${site.file} 的 ${site.label} 挂点必须传 ask-matt 门（漏传 = 关态残留半件）`,
    );
  }
});

async function discoverRegisteredNames(disabledPaths: readonly string[]): Promise<string[]> {
  const adapter = new NodeSkillAdapter({ disabledPaths: [...disabledPaths] });
  const outcome = await adapter.discoverSkills({
    roots: [bundledRoot],
    workingDirectory: repoRoot,
  });
  return outcome.skills.map((skill) => skill.name).sort();
}

test("注册面 · 关态：create-app 单点组装下内置包零 ask-matt 技能（真实 NodeSkillAdapter）", async () => {
  for (const askMattFlowEnabled of [undefined, false]) {
    const disabledPaths = resolveBundledSkillDisabledPaths({
      askMattFlowEnabled,
      bundledSkillRoots: [bundledRoot],
      configDisabledPaths: [],
    });
    const names = await discoverRegisteredNames(disabledPaths);
    assert.deepEqual(
      names,
      ["dynamic-workflows"],
      "关态内置包只剩产品内置 dynamic-workflows（ask-matt 全库零注册）",
    );

    // 加载面与发现面同结论：关态连流程技能也装载不到。
    const adapter = new NodeSkillAdapter({ disabledPaths });
    await assert.rejects(
      adapter.loadSkill({ name: "grilling", roots: [bundledRoot], workingDirectory: repoRoot }),
      /Skill not found/,
      "关态 loadSkill(grilling) 必须失败（防「命令没了但技能仍可装载」半态）",
    );
  }
});

test("注册面 · 开态对照：37 件全库注册（含重叠三件，D5 换名后命令要能装载技能）", async () => {
  const disabledPaths = resolveBundledSkillDisabledPaths({
    askMattFlowEnabled: true,
    bundledSkillRoots: [bundledRoot],
    configDisabledPaths: [],
  });
  const names = await discoverRegisteredNames(disabledPaths);
  assert.equal(names.includes("grilling"), true, "开态流程技能必须注册");
  assert.equal(
    names.length,
    37 + 1,
    `开态应为 37 件 ask-matt 技能 + dynamic-workflows：${names.length}`,
  );
  for (const renamedTarget of ["implement", "tdd", "code-review"]) {
    assert.ok(
      names.includes(renamedTarget),
      `换名命令的目标技能 ${renamedTarget} 必须在场（否则 /matt-* 调起不到技能）`,
    );
  }
});

test("注入面 · 关态：34 命令均不展开（原文交模型）+ 既有命令不受牵连", () => {
  assert.equal(CARD_COMMAND_NAMES.length, 34, "减法口径 = 34 条命令（独立真源重算）");
  for (const command of CARD_COMMAND_NAMES) {
    assert.equal(
      resolveZCodeBuiltinPromptCommand(`/${command} 打磨这个想法`, { askMattFlowEnabled: false }),
      undefined,
      `关态 /${command} 必须不展开（零注入）`,
    );
    assert.equal(
      resolveZCodeBuiltinPromptCommand(`/${command} 打磨这个想法`, {}),
      undefined,
      `未设置（未加载缓存）时 /${command} 必须不展开（fail-closed）`,
    );
  }
  assert.match(resolveZCodeBuiltinPromptCommand("/init", {})!, /AGENTS\.md/);
  assert.match(
    resolveZCodeBuiltinPromptCommand("/workflow 做件事", { dynamicWorkflowEnabled: true })!,
    /dynamic-workflows/,
  );
});

test("注入面 · 开态对照：34 命令展开为装载对应内置包技能的注入正文", () => {
  // 独立真源：命令名 → 技能名的映射来自裁决（D5 换名三件 + grill 入口名），其余同名。
  const expectedSkillByCommand: Readonly<Record<string, string>> = (() => {
    const byName: Record<string, string> = {};
    for (const command of CARD_COMMAND_NAMES) {
      const renamed = Object.entries(VERDICT_COMMAND_NAMES).find(([, name]) => name === command);
      byName[command] = renamed?.[0] ?? command;
    }
    return byName;
  })();
  for (const command of CARD_COMMAND_NAMES) {
    const expanded = resolveZCodeBuiltinPromptCommand(`/${command} 打磨这个想法`, {
      askMattFlowEnabled: true,
    });
    assert.ok(expanded, `开态 /${command} 必须展开`);
    assert.match(
      expanded,
      new RegExp(`Required skills: \`${expectedSkillByCommand[command]}\`\\.`),
      `/${command} 展开必须装载 ${expectedSkillByCommand[command]}`,
    );
    assert.match(expanded, /call the Skill tool for `/);
    assert.match(expanded, /打磨这个想法/, "展开正文必须保留用户参数");
  }
});
