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
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { updateAskMattFlowPreferences } from "../src/zcode-protocol/ask-matt-flow-policy.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const snapshotPath = join(
  repoRoot,
  "apps",
  "zcode-cli",
  "packages",
  "bundled-skills",
  "skills",
  ".zcode-skills-snapshot.json",
);
const ASK_MATT_COMMAND_NAMES = ["grill", "to-spec", "to-tickets"] as const;

/** 独立真源：卡文点名的三个命令名（不 import 被测常量自身，避免同义反复）。 */
const CARD_COMMAND_NAMES: readonly string[] = ASK_MATT_COMMAND_NAMES;

/**
 * 独立真源：设计稿 §6 裁决点名的特例（测试不复算实现白名单常量）。
 * - D1 三件无命令：平台不适用（tracker=看板 / 无 Claude CLI 载体 / Claude Code 专用 hooks）；
 * - D5 三件换名：/matt-* 前缀，技能名与正文不动；
 * - grill 是 #204/A3 已交付入口名（技能 grilling，命令名保持不变）。
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

function readSnapshotSkillNames(): string[] {
  const record = JSON.parse(readFileSync(snapshotPath, "utf8")) as { skills: string[] };
  return [...record.skills];
}

/** 独立重算：快照 37 件按裁决剔除无命令三件、按裁决映射命令名（不与实现比较同一份常量）。 */
function expectedDerivedCommands(): Array<{ name: string; skill: string }> {
  return readSnapshotSkillNames()
    .filter((skill) => !VERDICT_NO_COMMAND_SKILLS.includes(skill))
    .map((skill) => ({ name: VERDICT_COMMAND_NAMES[skill] ?? skill, skill }));
}

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

test("命令表派生（单源）：快照 37 件 - 无命令 3 件 = 34 条目，逐件点名（D1/D5 裁决）", () => {
  const snapshotSkills = readSnapshotSkillNames();
  assert.equal(snapshotSkills.length, 37, "包内快照应是 37 件（A2 全库入包口径）");

  // 单源派生：命令条目 = 快照清单（快照顺序）减去裁决无命令件，命令名按裁决映射。
  assert.deepEqual(
    ASK_MATT_FLOW_COMMANDS.map(({ name, skill }) => ({ name, skill })),
    expectedDerivedCommands(),
    "命令表必须由包内快照单源派生：37 件减无命令三件 = 34 条目，换名三件与 grill 入口名按裁决",
  );
  assert.equal(ASK_MATT_FLOW_COMMANDS.length, 34, "34 条入口零削减");

  // 技能目标逐一点名：每个派生技能恰好一条命令；无命令三件一个入口都不带。
  for (const noCommand of VERDICT_NO_COMMAND_SKILLS) {
    assert.ok(
      !ASK_MATT_FLOW_COMMANDS.some((command) => command.skill === noCommand),
      `无命令件 ${noCommand} 不得带斜杠入口（D1 裁决）`,
    );
  }

  // 换名三件与 grill 入口名：命令名必须与裁决映射一致（其余件命令名 = 技能名已在派生比对中覆盖）。
  for (const [skill, commandName] of Object.entries(VERDICT_COMMAND_NAMES)) {
    const command = ASK_MATT_FLOW_COMMANDS.find((candidate) => candidate.skill === skill);
    assert.equal(command?.name, commandName, `${skill} 的命令名必须是 /${commandName}`);
  }
  for (const renamed of ["implement", "tdd", "code-review"]) {
    assert.ok(
      !ASK_MATT_FLOW_COMMANDS.some((command) => command.name === renamed),
      `换名后 /${renamed} 不再是入口名（技能名不动，D5）`,
    );
  }

  // 每条命令的目录面与展开面基本形：描述非空、$ARGUMENTS 在场、提示以 /名字 开头。
  const names = ASK_MATT_FLOW_COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length, "命令名不得重复");
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(command.description.trim().length > 0, `${command.name} 缺少目录描述`);
    assert.ok(command.argumentHint.startsWith(`/${command.name}`), `${command.name} 的使用提示`);
    assert.ok(command.body.includes("$ARGUMENTS"), `${command.name} 正文必须显式消费 $ARGUMENTS`);
  }
});

test("通用边界行（D8）：34 件正文全含看板边界段（项目根/唯一写者/禁 .scratch）", () => {
  for (const command of ASK_MATT_FLOW_COMMANDS) {
    assert.ok(
      command.body.includes("Board boundary (this project):"),
      `/${command.name} 正文必须含通用边界段（全件追加，D8）`,
    );
    assert.match(command.body, /owns `\.zcode\/board\/`/, `/${command.name} 边界段须钉项目根判据`);
    assert.match(command.body, /worktree copy/, `/${command.name} 边界段须排除工作树落盘`);
    assert.match(command.body, /`\.scratch\//, `/${command.name} 边界段须禁 .scratch/ 落点`);
    assert.match(
      command.body,
      /board compiler is the\s+only board writer/,
      `/${command.name} 边界段须钉「产品零板写者」`,
    );
  }
});

test("开关打开：/ 目录装配 34 命令（内置段，legacy 三件保持 grill → to-spec → to-tickets 顺序）", async () => {
  await withIsolatedCommandEnv(async (env) => {
    const commands = await listProtocolSlashCommands({
      ...catalogOptions(env),
      askMattFlowEnabled: true,
    });
    const names = commands.map((command) => command.name);
    for (const command of ASK_MATT_FLOW_COMMANDS) {
      const position = names.indexOf(command.name);
      assert.ok(position !== -1, `开关打开时 / 面板必须含 /${command.name}：${names.join(",")}`);
      assert.equal(commands[position]!.source, "builtin", `/${command.name} 必须是内置目录项`);
    }
    const positions = CARD_COMMAND_NAMES.map((name) => names.indexOf(name));
    assert.ok(
      positions[0]! < positions[1]! && positions[1]! < positions[2]!,
      "legacy 三命令要按 grill → to-spec → to-tickets 顺序展示",
    );
    // 既有内置目录不变（实验命令只做追加，不重排已交付入口）。
    for (const existing of ["goal", "workflow", "compact", "init", "plan"]) {
      assert.ok(names.includes(existing), `既有内置命令 /${existing} 不得被动到`);
    }
  });
});

test("开关关闭 / 未设置：34 命令零装配（既有目录不受影响）", async () => {
  await withIsolatedCommandEnv(async (env) => {
    for (const askMattFlowEnabled of [undefined, false]) {
      const commands = await listProtocolSlashCommands({
        ...catalogOptions(env),
        ...(askMattFlowEnabled === undefined ? {} : { askMattFlowEnabled }),
      });
      const names = commands.map((command) => command.name);
      for (const command of ASK_MATT_FLOW_COMMANDS) {
        assert.ok(!names.includes(command.name), `开关关闭时不得装配 /${command.name}`);
      }
      for (const existing of ["goal", "workflow", "compact", "init"]) {
        assert.ok(names.includes(existing), `既有内置命令 /${existing} 不得被动到`);
      }
    }
    // 无开关参数的调用方（TUI/旧路径）同样零装配：实验默认关，不得 fail-open。
    assert.deepEqual(listAskMattFlowSlashCommands(undefined), []);
    assert.deepEqual(listAskMattFlowSlashCommands(false), []);
    assert.equal(listAskMattFlowSlashCommands(true).length, 34);
  });
});

test("自定义命令遮蔽：开关开时同名自定义命令被内置命令压过，关闭时自定义命令原样可见", async () => {
  await withIsolatedCommandEnv(async (env) => {
    await env.writeCustomCommand("grill", "User custom grill command body.");
    await env.writeCustomCommand("to-tickets", "User custom to-tickets body.");
    // 新派生入口同样压过同名自定义命令（34 名一律进遮蔽判据，不只 legacy 三件）。
    await env.writeCustomCommand("research", "User custom research command body.");

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
    assert.equal(
      enabled.find((command) => command.name === "research")?.source,
      "builtin",
      "开态 /research 必须是派生内置命令（压过同名自定义）",
    );

    const disabled = await listProtocolSlashCommands(catalogOptions(env));
    assert.equal(
      disabled.find((command) => command.name === "grill")?.source,
      "custom",
      "开关关时自定义 /grill 必须原样可用（实验不得占用用户命令名）",
    );
    assert.equal(
      disabled.find((command) => command.name === "research")?.source,
      "custom",
      "开关关时自定义 /research 必须原样可用",
    );
    assert.ok(isAskMattFlowCommandName("/GRill "), "命令名判据要归一化斜杠与大小写");
    assert.ok(isAskMattFlowCommandName("/Matt-TDD "), "换名件命令名也要进判据");
    assert.ok(!isAskMattFlowCommandName("grilling"));
  });
});

test("展开：开关打开时 34 命令装载对应内置包技能并保留参数；关闭/未设置不展开", () => {
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
