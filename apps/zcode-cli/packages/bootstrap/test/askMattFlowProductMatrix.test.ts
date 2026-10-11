// 「ask-matt 开发流程」×「动态工作流」2×2 乘积态 × 四面矩阵（卡 #205/A4）。
//
// 为什么这组用例承重：两个实验开关各自有独立判据（ask-matt 门 vs 动态工作流灰度门），
// 但四面（命令面/注册面/注入面/二次发现面）都同时消费两套判据之一或两者。乘积态矩阵把
// 「ask-matt 面只随 ask-matt 门、dwf 面只随 dwf 门」逐格钉死，防止一个开关的改动误伤另一个
// （例如关动态工作流时把 grilling 连坐剔除，或开 ask-matt 时把 /workflow 意外带出）。
//
// 二次发现面（skills.ts）本轮只接 ask-matt 门：dwf 列在该面按**已登记缺口**钉住现状
// （dynamic-workflows 恒可见），不修不藏（收口批裁量）。

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NodeSkillAdapter } from "@zcode/adapters/skills";
import type { SkillRoot } from "@zcode/contracts";
import {
  ASK_MATT_FLOW_OVERLAP_SKILL_NAMES,
  resolveBundledSkillDisabledPaths,
} from "../src/app/ask-matt-flow-gate.js";
import { resolveZCodeBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { listZCodeSkills } from "../src/skills.js";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../../..");
const skillsRoot = join(repoRoot, "apps", "zcode-cli", "packages", "bundled-skills", "skills");

const CARD_COMMAND_NAMES = ["grill", "to-spec", "to-tickets"] as const;
const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

const bundledRoot: SkillRoot = {
  path: skillsRoot,
  priority: 1_000_000,
  scope: "system",
  source: "bundled",
};

async function withIsolatedEnv<T>(
  task: (env: { homeDirectory: string; workingDirectory: string }) => Promise<T>,
): Promise<T> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-matrix-home-"));
  const workingDirectory = await mkdtemp(join(tmpdir(), "zcode-ask-matt-matrix-ws-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  // 用户级技能根（~/.zcode/skills）在本机装有同名技能；隔离后 bundled 来源断言才有确定结论。
  process.env.HOME = homeDirectory;
  process.env.USERPROFILE = homeDirectory;
  try {
    return await task({ homeDirectory, workingDirectory });
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    await rm(homeDirectory, { force: true, recursive: true });
    await rm(workingDirectory, { force: true, recursive: true });
  }
}

test("2×2 四面矩阵：ask-matt 面只随 ask-matt 门，dwf 面只随动态工作流门", async () => {
  await withIsolatedEnv(async (env) => {
    for (const askMatt of [false, true]) {
      for (const dynamicWorkflow of [false, true]) {
        const cell = `askMatt=${askMatt}, dwf=${dynamicWorkflow}`;

        // ① 命令面（`/` 面板与加号菜单的单点目录）。
        const commands = await listProtocolSlashCommands({
          askMattFlowEnabled: askMatt,
          dynamicWorkflowEnabled: dynamicWorkflow,
          env: {},
          homeDirectory: env.homeDirectory,
          skipUserConfig: true,
          workingDirectory: env.workingDirectory,
        });
        const commandNames = commands.map((command) => command.name);
        for (const command of CARD_COMMAND_NAMES) {
          assert.equal(
            commandNames.includes(command),
            askMatt,
            `${cell}：/${command} 只随 ask-matt 门（命令面）`,
          );
        }
        assert.equal(
          commandNames.includes("workflow"),
          dynamicWorkflow,
          `${cell}：/workflow 只随动态工作流门（命令面）`,
        );

        // ② 注册面（create-app 判据单点 + 真实 NodeSkillAdapter + 真实包资产）。
        const registeredNames = (
          await new NodeSkillAdapter({
            disabledPaths: resolveBundledSkillDisabledPaths({
              askMattFlowEnabled: askMatt,
              bundledSkillRoots: [bundledRoot],
              configDisabledPaths: [],
              dynamicWorkflowEnabled: dynamicWorkflow,
            }),
          }).discoverSkills({ roots: [bundledRoot], workingDirectory: repoRoot })
        ).skills.map((skill) => skill.name);
        assert.equal(
          registeredNames.includes("grilling"),
          askMatt,
          `${cell}：grilling 只随 ask-matt 门（注册面）`,
        );
        assert.equal(
          registeredNames.includes(DYNAMIC_WORKFLOW_SKILL_NAME),
          dynamicWorkflow,
          `${cell}：dynamic-workflows 只随 dwf 门（注册面）`,
        );
        for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
          assert.ok(!registeredNames.includes(overlap), `${cell}：重叠件 ${overlap} 恒不注册`);
        }

        // ③ 注入面（手打命令的展开）。
        for (const command of CARD_COMMAND_NAMES) {
          assert.equal(
            resolveZCodeBuiltinPromptCommand(`/${command} 参数`, { askMattFlowEnabled: askMatt }) !==
              undefined,
            askMatt,
            `${cell}：/${command} 展开只随 ask-matt 门（注入面）`,
          );
        }
        assert.equal(
          resolveZCodeBuiltinPromptCommand("/workflow 参数", {
            dynamicWorkflowEnabled: dynamicWorkflow,
          }) !== undefined,
          dynamicWorkflow,
          `${cell}：/workflow 展开只随动态工作流门（注入面）`,
        );

        // ④ 二次发现面（zcode skills list / TUI / 引用目录草稿）。
        const secondaryBundledNames = (
          await listZCodeSkills({
            askMattFlowEnabled: askMatt,
            skipUserConfig: true,
            workingDirectory: env.workingDirectory,
          })
        ).skills
          .filter((skill) => skill.source === "bundled")
          .map((skill) => skill.name);
        assert.equal(
          secondaryBundledNames.includes("grilling"),
          askMatt,
          `${cell}：grilling 只随 ask-matt 门（二次发现面）`,
        );
        for (const overlap of ASK_MATT_FLOW_OVERLAP_SKILL_NAMES) {
          assert.ok(
            !secondaryBundledNames.includes(overlap),
            `${cell}：重叠件 ${overlap} 在二次发现面恒不可见`,
          );
        }
        // 已登记缺口：dwf 门未接二次发现面——两个 dwf 格都按现状要求 dynamic-workflows 在场。
        assert.ok(
          secondaryBundledNames.includes(DYNAMIC_WORKFLOW_SKILL_NAME),
          `${cell}：二次发现面的 dynamic-workflows 现状（dwf 门未接本面，登记不修）`,
        );
      }
    }
  });
});
