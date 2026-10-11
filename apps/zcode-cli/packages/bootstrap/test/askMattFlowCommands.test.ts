// 「ask-matt 开发流程」三个命令的装配面断言（卡 #204/A3）。
//
// 命令面 = 同一份判据的两个消费端：CLI 侧装配的 `/` 目录（listProtocolSlashCommands，App 面板与
// 加号菜单的数据源）与命令展开（resolveZCodeBuiltinPromptCommand，输入 `/grill ...` 时装载内置包
// 技能）。开关关闭（含未设置）时两端一起为零：用户原话「带但不注册」——实验关掉不得留半件入口。
//
// 为什么这组用例承重：命令是用户唯一可见的入口；只改目录不改展开（或反之）会造出「看得到点不动」
// 或「手打能触发但面板没有」的分歧。三条命令还必须各自指向真实存在的内置包技能（调起进技能的注册
// 前提，注册面断言见 askMattFlowSkillRegistration.test.ts）。

import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  ASK_MATT_FLOW_COMMANDS,
  isAskMattFlowCommandName,
  listAskMattFlowSlashCommands,
} from "../src/ask-matt-flow-commands.js";
import { ASK_MATT_FLOW_COMMAND_SKILL_NAMES } from "../src/app/ask-matt-flow-gate.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { updateAskMattFlowPreferences } from "../src/zcode-protocol/ask-matt-flow-policy.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const ASK_MATT_COMMAND_NAMES = ["grill", "to-spec", "to-tickets"] as const;

/** 独立真源：卡文点名的三个命令名（不 import 被测常量自身，避免同义反复）。 */
const CARD_COMMAND_NAMES: readonly string[] = ASK_MATT_COMMAND_NAMES;

async function withIsolatedCommandEnv<T>(
  task: (env: {
    homeDirectory: string;
    workingDirectory: string;
    writeCustomCommand: (name: string, body: string) => Promise<void>;
  }) => Promise<T>,
): Promise<T> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-home-"));
  const workingDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-ws-"));
  try {
    return await task({
      homeDirectory,
      workingDirectory,
      async writeCustomCommand(name, body) {
        const commandsDir = join(workingDirectory, ".zcode", "commands");
        await mkdir(commandsDir, { recursive: true });
        await writeFile(join(commandsDir, `${name}.md`), body, "utf8");
      },
    });
  } finally {
    await rm(homeDirectory, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

function catalogOptions(env: { homeDirectory: string; workingDirectory: string }) {
  return {
    env: {} as NodeJS.ProcessEnv,
    homeDirectory: env.homeDirectory,
    skipUserConfig: true,
    workingDirectory: env.workingDirectory,
  };
}

test("命令表身份：三命令名与卡文一致、目标技能即注册面三技能（ask-matt 原名）", () => {
  assert.deepEqual(
    ASK_MATT_FLOW_COMMANDS.map((command) => command.name),
    [...CARD_COMMAND_NAMES],
  );
  assert.deepEqual(
    [...ASK_MATT_FLOW_COMMANDS.map((command) => command.skill)].sort(),
    [...ASK_MATT_FLOW_COMMAND_SKILL_NAMES].sort(),
    "命令表的目标技能必须与注册面三技能同一集合（否则命令调起不到技能）",
  );
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(command.description.trim().length > 0, `${command.name} 缺少目录描述`);
    assert.ok(command.argumentHint.startsWith(`/${command.name}`), `${command.name} 的使用提示`);
    assert.ok(command.body.includes("$ARGUMENTS"), `${command.name} 正文必须显式消费 $ARGUMENTS`);
  }
});

test("开关打开：/ 目录装配三命令（内置段，按 grill → to-spec → to-tickets 顺序）", async () => {
  await withIsolatedCommandEnv(async (env) => {
    const commands = await listProtocolSlashCommands({
      ...catalogOptions(env),
      askMattFlowEnabled: true,
    });
    const names = commands.map((command) => command.name);
    const positions = CARD_COMMAND_NAMES.map((name) => names.indexOf(name));
    for (const [index, name] of CARD_COMMAND_NAMES.entries()) {
      assert.ok(positions[index] !== -1, `开关打开时 / 面板必须含 /${name}：${names.join(",")}`);
      assert.equal(commands[positions[index]!]!.source, "builtin", `/${name} 必须是内置目录项`);
    }
    assert.ok(
      positions[0]! < positions[1]! && positions[1]! < positions[2]!,
      "流程命令要按 grill → to-spec → to-tickets 顺序展示",
    );
    // 既有内置目录不变（实验命令只做追加，不重排已交付入口）。
    for (const existing of ["goal", "workflow", "compact", "init", "plan"]) {
      assert.ok(names.includes(existing), `既有内置命令 /${existing} 不得被动到`);
    }
  });
});

test("开关关闭 / 未设置：三命令零装配（既有目录不受影响）", async () => {
  await withIsolatedCommandEnv(async (env) => {
    for (const askMattFlowEnabled of [undefined, false]) {
      const commands = await listProtocolSlashCommands({
        ...catalogOptions(env),
        ...(askMattFlowEnabled === undefined ? {} : { askMattFlowEnabled }),
      });
      const names = commands.map((command) => command.name);
      for (const name of CARD_COMMAND_NAMES) {
        assert.ok(!names.includes(name), `开关关闭时不得装配 /${name}`);
      }
      for (const existing of ["goal", "workflow", "compact", "init"]) {
        assert.ok(names.includes(existing), `既有内置命令 /${existing} 不得被动到`);
      }
    }
    // 无开关参数的调用方（TUI/旧路径）同样零装配：实验默认关，不得 fail-open。
    assert.deepEqual(listAskMattFlowSlashCommands(undefined), []);
    assert.deepEqual(listAskMattFlowSlashCommands(false), []);
    assert.equal(listAskMattFlowSlashCommands(true).length, 3);
  });
});

test("自定义命令遮蔽：开关开时同名自定义命令被内置命令压过，关闭时自定义命令原样可见", async () => {
  await withIsolatedCommandEnv(async (env) => {
    await env.writeCustomCommand("grill", "User custom grill command body.");
    await env.writeCustomCommand("to-tickets", "User custom to-tickets body.");

    const enabled = await listProtocolSlashCommands({
      ...catalogOptions(env),
      askMattFlowEnabled: true,
    });
    assert.equal(
      enabled.filter((command) => command.name === "grill").length,
      1,
      "同名只留内置一条，不得出现两条 /grill",
    );
    assert.equal(
      enabled.find((command) => command.name === "grill")?.description,
      ASK_MATT_FLOW_COMMANDS.find((command) => command.name === "grill")?.description,
      "开关开时 /grill 归内置流程命令（用户自定义不遮蔽实验入口）",
    );

    const disabled = await listProtocolSlashCommands(catalogOptions(env));
    assert.equal(
      disabled.find((command) => command.name === "grill")?.source,
      "custom",
      "开关关时自定义 /grill 必须原样可用（实验不得占用用户命令名）",
    );
    assert.ok(isAskMattFlowCommandName("/GRill "), "命令名判据要归一化斜杠与大小写");
    assert.ok(!isAskMattFlowCommandName("grilling"));
  });
});

test("展开：开关打开时三命令装载对应内置包技能并保留参数；关闭/未设置不展开", () => {
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    const expanded = resolveZCodeBuiltinPromptCommand(`/${command.name} 打磨这个想法`, {
      askMattFlowEnabled: true,
    });
    assert.ok(expanded, `/${command.name} 在开态必须展开`);
    // 期望措辞来自 contracts 的 custom command 展开契约（formatCommandSkillInstructions）：
    // 命令正文必须把目标技能列为 Required skills 并要求先调 Skill 工具。
    assert.match(
      expanded,
      new RegExp(`Required skills: \`${command.skill}\`\\.`),
      `/${command.name} 展开必须要求先装载 ${command.skill} 技能`,
    );
    assert.match(
      expanded,
      new RegExp(`call the Skill tool for \`${command.skill}\``),
      `/${command.name} 展开必须指向 Skill 工具装载 ${command.skill}`,
    );
    assert.match(expanded, /打磨这个想法/, `/${command.name} 必须保留用户参数`);

    assert.equal(
      resolveZCodeBuiltinPromptCommand(`/${command.name} 打磨这个想法`, {
        askMattFlowEnabled: false,
      }),
      undefined,
      `/${command.name} 关态不得展开`,
    );
    assert.equal(
      resolveZCodeBuiltinPromptCommand(`/${command.name} 打磨这个想法`, {}),
      undefined,
      `/${command.name} 缺省（未设置）不得展开`,
    );
  }

  // 既有内置命令的判据不受 ask-matt 门影响：/init 与 /workflow 各按自己的开关。
  assert.match(
    resolveZCodeBuiltinPromptCommand("/init", { askMattFlowEnabled: true })!,
    /AGENTS\.md/,
  );
  assert.match(resolveZCodeBuiltinPromptCommand("/init", {})!, /AGENTS\.md/);
  assert.match(resolveZCodeBuiltinPromptCommand("/workflow 做件事", {})!, /dynamic-workflows/);
  assert.equal(
    resolveZCodeBuiltinPromptCommand("/workflow 做件事", { dynamicWorkflowEnabled: false }),
    undefined,
  );
});

test("协议通道：updateAskMattFlowPreferences 写入进程缓存（默认关，只认显式布尔）", async () => {
  const context = {
    appRuntimePreferences: { askMattFlowEnabled: false },
  } as unknown as ZCodeProtocolAgentServerContext;
  const workspace = { workspaceKey: "ws-gate", workspacePath: "/tmp/ws-gate" };

  const enabled = await updateAskMattFlowPreferences(context, { workspace, enabled: true });
  assert.equal(context.appRuntimePreferences.askMattFlowEnabled, true);
  assert.deepEqual(enabled, { workspace, enabled: true });

  await updateAskMattFlowPreferences(context, { workspace, enabled: false });
  assert.equal(context.appRuntimePreferences.askMattFlowEnabled, false);

  await assert.rejects(
    updateAskMattFlowPreferences(context, { workspace, enabled: "yes" }),
    "非布尔值必须被 schema 拒绝（不能把任意真值当开关）",
  );
});

test("装配挂点（源码守卫）：目录三处 + 展开一处都读 appRuntimePreferences/runtimeConfig 的 ask-matt 门", () => {
  const srcRoot = resolve(testDir, "../src");
  const catalogCallSites = [
    "zcode-protocol/server-operations.ts",
    "zcode-protocol/workspace-model-runtime.ts",
    "zcode-protocol/v4-workspace-config.ts",
  ];
  for (const relativePath of catalogCallSites) {
    const source = readFileSync(resolve(srcRoot, relativePath), "utf8");
    assert.match(
      source,
      /askMattFlowEnabled: context\.appRuntimePreferences\.askMattFlowEnabled/,
      `${relativePath} 的 / 目录装配必须传 ask-matt 门（否则开关关掉目录还在）`,
    );
  }
  const createAppSource = readFileSync(resolve(srcRoot, "app/create-app.ts"), "utf8");
  assert.match(
    createAppSource,
    /askMattFlowEnabled: runtimeConfig\.askMattFlowEnabled/,
    "create-app 的内置命令展开必须传 runtimeConfig 的 ask-matt 门",
  );
  assert.match(
    createAppSource,
    /resolveBundledSkillDisabledPaths\(/,
    "create-app 的 skillPort 必须经注册面单点组装内置包禁用路径",
  );
  void repoRoot;
});
