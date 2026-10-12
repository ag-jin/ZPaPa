import { resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { Logger, SkillContent, SkillDiagnostic, SkillLoadOutcome } from "@zcode/contracts";
import { resolveBundledSkillDisabledPaths } from "./app/ask-matt-flow-gate.js";
import { resolveBundledSkillRoots } from "./app/bundled-skills.js";
import { getCliStorageRoot } from "./app/paths.js";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeSkillsOptions {
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
  /**
   * 「ask-matt 开发流程」实验开关（#205/A4）：二次发现面（`zcode skills list` / TUI /
   * 工作区引用目录草稿）与 create-app 会话注册面**同一判据单点**（app/ask-matt-flow-gate.ts）。
   *
   * 只有显式 true 才把 37 件技能交给发现面（#226/F1 起全库注册；重叠三件恒不注册已按 D5 退役）；
   * 未提供 = 关（fail-closed，与 A1 呈现判据同源）——独立 CLI/TUI 没有实验设置通道，维持零 ask-matt；
   * 进程内有 Host 同步缓存的调用方（协议侧引用目录）显式传入。
   *
   * 已知缺口（登记，不修，归收口批裁量）：动态工作流门未接本面——dynamic-workflows
   * 在本面与 dwf 开关无关地始终可见，与本卡 ask-matt 减法互不牵连。
   */
  askMattFlowEnabled?: boolean;
}

export interface InspectZCodeSkillOptions extends ListZCodeSkillsOptions {
  name: string;
}

export interface ZCodeSkillInspection {
  diagnostics: SkillDiagnostic[];
  skill: SkillContent;
}

export async function listZCodeSkills(
  options: ListZCodeSkillsOptions = {},
): Promise<SkillLoadOutcome> {
  const discovery = await createSkillDiscovery(options);
  if (!discovery.enabled) {
    return {
      diagnostics: [],
      skills: [],
      totalDiscovered: 0,
    };
  }

  return await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
}

export async function inspectZCodeSkill(
  options: InspectZCodeSkillOptions,
): Promise<ZCodeSkillInspection> {
  const discovery = await createSkillDiscovery(options);
  if (!discovery.enabled) {
    throw new Error("Skills are disabled.");
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
  if (
    !outcome.skills.some(
      (skill) => skill.name === options.name || skill.qualifiedName === options.name,
    )
  ) {
    throw new Error(`Skill not found: ${options.name}`);
  }

  const skill = await discovery.skillPort.loadSkill({
    name: options.name,
    workingDirectory: discovery.workingDirectory,
  });

  return {
    diagnostics: outcome.diagnostics,
    skill,
  };
}

async function createSkillDiscovery(options: ListZCodeSkillsOptions): Promise<
  | {
      enabled: false;
      workingDirectory: string;
    }
  | {
      enabled: true;
      skillPort: ReturnType<typeof createNodeSkillAdapter>;
      workingDirectory: string;
    }
> {
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });

  if (!configResult.config.features.skill || !configResult.config.skills.enabled) {
    return {
      enabled: false,
      workingDirectory,
    };
  }
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });

  // 内置技能包与插件技能根并列注入：`zcode skills list`、引用目录与 runtime 看到同一份发现结果。
  const bundledSkillRoots = await resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
    logger: options.logger,
  });

  return {
    enabled: true,
    skillPort: createNodeSkillAdapter({
      extraRoots: configResult.config.skills.roots,
      extraResolvedRoots: [...pluginOutcome.skillRoots, ...bundledSkillRoots],
      // 内置包注册面单点组装（用户配置禁用 + ask-matt 门），与会话注册面（create-app skillPort）
      // 同一函数：关态（含未提供）全库 37 件零注册、开态只剔重叠三件。这里刻意不传
      // dynamicWorkflowEnabled——动态工作流门接本面是已登记的缺口（见 ListZCodeSkillsOptions 注释），
      // 不在本卡修复范围内，避免两处灰度口径在本轮分叉。
      disabledPaths: resolveBundledSkillDisabledPaths({
        askMattFlowEnabled: options.askMattFlowEnabled,
        bundledSkillRoots,
        configDisabledPaths: collectDisabledPaths(configResult.config.skillOverrides),
      }),
    }),
    workingDirectory,
  };
}
