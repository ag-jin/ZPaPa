import { BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES, type ZCodeSlashCommand } from "@zcode/shared";
import {
  isAskMattFlowCommandName,
  listAskMattFlowSlashCommands,
} from "../ask-matt-flow-commands.js";
import { BUILTIN_WORKFLOW_COMMAND_NAME } from "../builtin-workflow-command.js";
import {
  listZCodeCustomCommands,
  type ListZCodeCustomCommandsOptions,
} from "../custom-commands.js";
import {
  APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS,
  APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES,
  isReservedZCodeSlashCommandName,
} from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流开关。只有显式 false 才从目录中剔除内置 `workflow`。
   * 未传入该字段的调用方保留默认目录；协议服务端从 appRuntimePreferences 传入显式布尔。
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * 「ask-matt 开发流程」开关（#204/A3；#226/F1 起 34 条流程命令）。只有显式 true 才把 34 条
   * 命令（legacy 三件 `/grill`、`/to-spec`、`/to-tickets` 在最前）追加进目录；未传入 / false =
   * 零装配（实验默认关）。协议服务端从 appRuntimePreferences 传入。
   */
  askMattFlowEnabled?: boolean;
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  // 动态工作流关闭时：composer 的加号菜单与 `/` 面板都只读这份目录，剔除即两个入口一起消失。
  // `workflow` 是内置命令且是保留名，用户/插件的同名自定义命令在下面的 reserved 过滤里一并消失，
  // 不会在门关着时借自定义命令的身份漏回目录。
  const builtins = listAppProtocolBuiltinSlashCommands().filter(
    (command) =>
      options.dynamicWorkflowEnabled !== false || command.name !== BUILTIN_WORKFLOW_COMMAND_NAME,
  );
  // ask-matt 34 条流程命令追加在内置段末尾（实验入口，不重排已交付目录）；
  // 命令名不进共享保留字表，所以只在开态压过同名自定义命令（关态用户命令照常可见）。
  // #235/F10 D11：压过不再是静默行为——开态下被压的自定义命令名单进既有诊断通道（logger，
  // 单一装配点的 warn；面板灰行随 U1 二期，本处零新 UI 机制）。
  const askMattFlowCommands = listAskMattFlowSlashCommands(options.askMattFlowEnabled);
  const askMattFlowEnabled = options.askMattFlowEnabled === true;
  let customCommands: Awaited<ReturnType<typeof listZCodeCustomCommands>>["commands"] = [];
  try {
    const outcome = await listZCodeCustomCommands(options);
    customCommands = outcome.commands;
  } catch {
    // 自定义命令发现失败不应阻断 session snapshot；保留可执行的内置协议命令。
    customCommands = [];
  }
  // 静态过滤（非交互专用/保留字）之后的自定义候选：压过判定的作用面。
  const customCandidates = customCommands
    .filter((command) => !command.disableNonInteractive)
    .filter((command) => !isReservedZCodeSlashCommandName(command.name));
  // D11 诊断点名（#235）：名单 = 本次装配真正被压过的件（静态过滤后仍与 34 命令同名）；
  // message 内联名单（console 流只打 message），context.commands 供日志文件结构化检索。
  if (askMattFlowEnabled) {
    const shadowedCommandNames = customCandidates
      .filter((command) => isAskMattFlowCommandName(command.name))
      .map((command) => command.name);
    if (shadowedCommandNames.length > 0) {
      options.logger?.warn(
        `Ask-matt flow overrides same-name custom commands: ${shadowedCommandNames.join(", ")}`,
        { commands: shadowedCommandNames },
      );
    }
  }

  return [
    ...builtins,
    ...askMattFlowCommands,
    ...customCandidates
      .filter((command) => !(askMattFlowEnabled && isAskMattFlowCommandName(command.name)))
      .map((command) => ({
        description: command.description,
        inputHint: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
        name: command.name,
        source: "custom" as const,
      })),
  ];
}

/** App `/` 面板按本目录顺序展示；内置段的顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。 */
function listAppProtocolBuiltinSlashCommands(): ZCodeSlashCommand[] {
  const sharedBuiltins = APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES.flatMap((name) => {
    const command = BUILTIN_ZCODE_SLASH_COMMAND_HELP_ENTRIES.find((entry) => entry.name === name);
    if (!command) return [];
    return [
      {
        description: command.summary,
        inputHint: command.usage,
        name: command.name,
        source: "builtin" as const,
      },
    ];
  });
  return [...sharedBuiltins, ...APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS];
}
