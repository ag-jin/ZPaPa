/* oxlint-disable eslint(max-lines) -- 创建/编辑双用表单：TeamAgent 与 Squad 两个对话框刻意同文件（两份表单会分叉）；字段区按服务面白名单一一对应。 */
import { useRef, useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import {
  parseWorkItemLabels,
  resolveTeamAgentMaxConcurrentRuns,
  TEAM_AGENT_COLORS,
  type McpServerConfig,
  type TeamAgent,
  type WorkItem,
  type WorkItemLabelsParseResult,
  type WorkItemPriorityKey,
} from "@zcode/shared";

/** 标签预检的**失败**结论（`ok` 不进状态：表单只在非 ok 时留文案）。 */
type WorkItemLabelsFailure = Exclude<WorkItemLabelsParseResult, { kind: "ok" }>;
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SUBAGENT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { ModelPickerRow } from "@/settings/WikiModelPickerRow.js";
import { TOOL_OPTIONS } from "@/settings/SubagentsSection.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import type { ModelSelection } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { parseAssigneeValue, workItemAssigneeOptions } from "./squadEntryViewModel.js";
import {
  parseWorkItemSurfaceFields,
  workItemSurfaceFieldErrorMessageId,
  type WorkItemSurfaceFieldsParseResult,
} from "./workItemPropertiesViewModel.js";
/* 轮 D 缺陷修复：优先级字段（哨兵 + 选项表单源）与两处取值翻译都在独立模块里。 */
import { WorkItemPriorityField, workItemPriorityFieldInput } from "./WorkItemPriorityField.js";
import { workItemInlinePrioritySelectValue } from "./workItemInlineEditViewModel.js";
import { CreateDialogShell, Field, FieldGroup } from "./squadDialogParts.js";
import type { TeamAgentDialogInitial } from "./teamAgentDialogInitial.js";
import { TeamAgentMcpSection } from "./TeamAgentMcpSection.js";
import { mcpServersSubmitPatch } from "./teamAgentMcpViewModel.js";
import type { SquadDialogInitial } from "./squadsViewModel.js";

/** 初值形状的再导出：表单文件是它的主要使用者，读者从这里找得到（单源在 teamAgentDialogInitial.ts）。 */
export type { TeamAgentDialogInitial } from "./teamAgentDialogInitial.js";

/* 本阶段的三个「最小」创建表单（协作智能体 / 小队 / 工作项）。

   为什么单独成文件：它们是**表单**，与视图的取数、审查动作没有共享状态；拆开后
   视图只负责编排，表单只负责收集最小必要字段（其余属性按 spec §15 的分期留到后续版本）。

   为什么只收「最小必要字段」而不是照实体全量：`CreateTeamAgentInput` 的必填只有
   name / systemPrompt / memoryScope；`CreateSquadInput` 的必填之外，`validateSquad`
   还要求 stopCondition 与 maxRounds 两个槽位（spec §5.4）—— 那两个必须收，
   因为它们缺了服务层会直接拒，**不能**替用户编一个默认值（编出来的终止条件是假的）。 */

/** 下拉里表示「没有父项」的哨兵值：Radix Select 不允许空字符串取值。 */
const NO_PARENT_VALUE = "__none__";

/**
 * 协作智能体表单：**创建 / 编辑两用**（只有这一处实现 —— 另抄一份编辑表单会让两个表单
 * 在字段与校验上陆续分叉，而分叉不报错）。
 *
 * `initial` 省略即「新建」（空白表单）；给出即「编辑」或「按初值预填」（AI 访谈产物、
 * 半途改手动创建都走这条）。提交的回调形状只有三个可编辑字段是**必填** ——
 * 正是服务面 `updateTeamAgent` 的白名单（`TeamAgentEditablePatch`），不多不少。
 */
export function TeamAgentDialog({
  onClose,
  onSubmit,
  initial,
  modelView,
  aiGenerated = false,
  titleId = "squad.agents.create",
  submitLabelId = "squad.common.submit",
}: {
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    systemPrompt: string;
    memoryScope: TeamAgent["memoryScope"];
    /** ②刀：描述与身份色（可选——未填/未选不落盘，编辑时 undefined 保持原值）。 */
    description?: string;
    color?: TeamAgent["color"];
    /** ②b：模型选择（含推理档位；未选定不落盘）。 */
    modelSelection?: ModelSelection;
    /** ③a：技能清单（空串输入 ⇒ 不提交 = 保持原值；显式清空用 []——见提交语义）。 */
    skills?: string[];
    /** ③a：权限模式（undefined = 未设置，落 optional 语义）。 */
    permissionMode?: TeamAgent["permissionMode"];
    /** ③b：允许的工具（[] = 允许全部，与既有口径一致；undefined = 不碰原值）。 */
    tools?: string[];
    /** ③b：禁用工具令牌（空 = 不提交）。 */
    disallowedTools?: string[];
    /** 4b（裁定⑤）：并发上限 1–16（空输入 = 不提交保持原值）。 */
    maxConcurrentRuns?: number;
    /** per-agent MCP（multica 欠账 #2）：整张 map 替换；空 map = 清空全部覆盖项（见提交语义）。 */
    mcpServers?: Record<string, McpServerConfig>;
  }) => void;
  /** 编辑既有智能体（或按访谈草稿预填）时的初值；省略 = 全新。 */
  initial?: TeamAgentDialogInitial;
  /** 模型选择视图（②b）：由页面持有 `useModelSelectionServiceView` 传入——dialog 保持纯受控，
      模型清单/生效值的取数不在表单里再起一份。undefined = 服务不可用（控件禁用态）。 */
  modelView?: ReturnType<typeof useModelSelectionServiceView>["state"];
  /** 初值来自 AI 访谈（AgentBuilder）：系统提示词区挂「由 AI 生成，请审阅」标注（§4-D4）。 */
  aiGenerated?: boolean;
  /** 标题文案键；省略即「新建协作智能体」。 */
  titleId?: string;
  /** 提交按钮文案键；省略即「创建」。 */
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState(initial?.name ?? "");
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt ?? "");
  const [memoryScope, setMemoryScope] = useState<TeamAgent["memoryScope"]>(
    initial?.memoryScope ?? "project",
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState<TeamAgent["color"] | undefined>(initial?.color);
  const [modelSelection, setModelSelection] = useState<ModelSelection | undefined>(
    initial?.modelSelection,
  );
  const [reasoningLevel, setReasoningLevel] = useState<string | undefined>(
    initial?.modelSelection?.options?.reasoningLevel,
  );
  const [skillsText, setSkillsText] = useState(initial?.skills?.join(", ") ?? "");
  const [permissionMode, setPermissionMode] = useState<"unset" | TeamAgent["permissionMode"]>(
    initial?.permissionMode ?? "unset",
  );
  /* ③b：工具编辑器（subagent 表单同款形态）——「允许全部」= 未设置或 [] 或 *；
     自定义 = 已知工具复选（TOOL_OPTIONS 单源）+ 保留的未知工具（随提交原样带回）。 */
  const initialAllowsAll =
    initial?.tools === undefined ||
    initial.tools.length === 0 ||
    initial.tools.some((tool) => tool.trim() === "*");
  const [toolMode, setToolMode] = useState<"all" | "custom">(initialAllowsAll ? "all" : "custom");
  const [selectedTools, setSelectedTools] = useState<string[]>(
    (initial?.tools ?? []).filter((tool) => (TOOL_OPTIONS as readonly string[]).includes(tool)),
  );
  const preservedToolsRef = useRef<string[]>(
    (initial?.tools ?? []).filter((tool) => !(TOOL_OPTIONS as readonly string[]).includes(tool)),
  );
  const [disallowedText, setDisallowedText] = useState(initial?.disallowedTools?.join(", ") ?? "");
  const [maxConcurrentRunsText, setMaxConcurrentRunsText] = useState(
    initial?.maxConcurrentRuns !== undefined ? String(initial.maxConcurrentRuns) : "",
  );
  /* per-agent MCP：分区是**受控**的（值只有这一份），编辑对话框的草稿留在分区内部。
     空 map 与「没有这个字段」在挂载语义上等价，但落盘语义不同 —— 提交时由
     `mcpServersSubmitPatch` 决定（编辑时删光要显式写 `{}`，新建时不落盘）。 */
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>(
    initial?.mcpServers ?? {},
  );
  /** 令牌化：逗号/空白分隔、去空、去重保序。空结果 = 不提交（保持原值）。 */
  const parsedDisallowed = (): string[] | null => {
    const tokens = disallowedText
      .split(/[,，\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const unique = [...new Set(tokens)];
    return unique.length > 0 ? unique : null;
  };

  const parsedSkills = (): string[] | null => {
    const tokens = skillsText
      .split(/[,，\s]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);
    const unique = [...new Set(tokens)];
    return unique.length > 0 ? unique : null;
  };

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={name.trim().length > 0 && systemPrompt.trim().length > 0}
      onSubmit={() => {
        const skillsTokens = parsedSkills();
        const disallowedTokens = parsedDisallowed();
        const maxConcurrentRunsParsed = (() => {
          const trimmed = maxConcurrentRunsText.trim();
          if (trimmed === "") return undefined;
          const value = Number(trimmed);
          if (!Number.isInteger(value) || value < 1 || value > 16) return undefined;
          return value;
        })();
        onSubmit({
          name: name.trim(),
          systemPrompt,
          memoryScope,
          // 描述空串不落盘（与 schema 的 optional 语义一致：没写就是没有）；
          // 色未选不送（undefined = 保持原值/跟随名字稳定色）。
          ...(description.trim().length > 0 ? { description: description.trim() } : {}),
          ...(color !== undefined ? { color } : {}),
          ...(modelSelection !== undefined
            ? {
                modelSelection: {
                  ...modelSelection,
                  ...(reasoningLevel !== undefined ? { options: { reasoningLevel } } : {}),
                },
              }
            : {}),
          /* skills 令牌输入：逗号/空白分隔去空；「有输入才提交」（空串 = 不碰原值——
             与显式清空（提交 []）区分：清空走输入框留分隔符的场景由服务面 [] 语义承载）。 */
          ...(skillsTokens !== null ? { skills: skillsTokens } : {}),
          ...(permissionMode !== "unset" ? { permissionMode } : {}),
          ...(toolMode === "all"
            ? { tools: [] }
            : { tools: [...selectedTools, ...preservedToolsRef.current] }),
          ...(disallowedTokens !== null ? { disallowedTools: disallowedTokens } : {}),
          ...(maxConcurrentRunsParsed !== undefined
            ? { maxConcurrentRuns: maxConcurrentRunsParsed }
            : {}),
          // per-agent MCP：有配置 ⇒ 整张 map；编辑时删光 ⇒ 显式 `{}`；本来没有 ⇒ 不带字段。
          ...mcpServersSubmitPatch(mcpServers, initial?.mcpServers !== undefined),
        });
      }}
    >
      <Field labelId="squad.common.name">
        {(controlId) => (
          <Input
            id={controlId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="squad.common.systemPrompt">
        {(controlId) => (
          <div className="flex flex-col gap-1">
            <SettingsFormTextarea
              id={controlId}
              value={systemPrompt}
              rows={4}
              onChange={(event) => setSystemPrompt(event.target.value)}
            />
            {/* AI 访谈产物预填时的审阅提示（§4-D4）：系统提示词是敏感面，必须过用户的眼。
                只有这一处实现 —— 编辑既有智能体或全手填时不出现（避免变成一句常驻噪音）。 */}
            {aiGenerated ? (
              <p
                className="text-ui-xs text-foreground-subtle"
                data-testid="squad-agent-ai-generated-notice"
              >
                {intl.formatMessage({ id: "squad.agentBuilder.systemPromptNotice" })}
              </p>
            ) : null}
          </div>
        )}
      </Field>
      <Field labelId="squad.common.memoryScope">
        {(controlId) => (
          <Select
            value={memoryScope}
            onValueChange={(value) => setMemoryScope(value as TeamAgent["memoryScope"])}
          >
            <SelectTrigger id={controlId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(["user", "project", "local"] as const).map((scope) => (
                <SelectItem key={scope} value={scope}>
                  {intl.formatMessage({ id: `squad.common.memoryScope.${scope}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field labelId="squad.common.description">
        {(controlId) => (
          <SettingsFormTextarea
            id={controlId}
            value={description}
            rows={2}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="squad.common.color">
        {() => (
          /* 身份色选色器（②刀）：九色板（与列表色点同一常量），radio 语义（单选可撤销回未选）。
             色板只表达身份（spec §11.3），不编码任何状态。 */
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid="squad-agent-color-picker"
            role="radiogroup"
            aria-label={intl.formatMessage({ id: "squad.common.color" })}
          >
            {TEAM_AGENT_COLORS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                role="radio"
                aria-checked={color === candidate}
                data-testid={`squad-agent-color-${candidate}`}
                className={cn(
                  "size-4 rounded-full ring-1 ring-border",
                  SUBAGENT_COLOR_CLASS[candidate],
                  color === candidate && "ring-2 ring-foreground scale-110",
                )}
                onClick={() => setColor(color === candidate ? undefined : candidate)}
              />
            ))}
          </div>
        )}
      </Field>
      <Field labelId="squad.common.model">
        {() => (
          /* ②b：模型 + 推理档位——复用 wiki/subagents 同款 ModelPickerRow（模型清单、
             生效值、推理档位规则只在那一处实现）。未选定时显示环境生效值（wiki 同款取舍：
             选定即落盘；「清除回跟随默认」不在此控件——登记为后续可选）。 */
          <div data-testid="squad-agent-model-picker">
            <ModelPickerRow
              selection={modelSelection}
              reasoningLevel={reasoningLevel}
              modelView={modelView ?? { status: "unavailable", reason: "remote-waiting" }}
              onSelectionChange={setModelSelection}
              onReasoningLevelChange={setReasoningLevel}
            />
          </div>
        )}
      </Field>
      <Field labelId="squad.common.skills">
        {(controlId) => (
          /* ③a：技能令牌输入（逗号/空白分隔；schema skills[] 的轻量编辑面——
             multica 是从 workspace 技能库多选，我们暂无技能枚举服务，先用令牌输入登记差异）。 */
          <Input
            id={controlId}
            value={skillsText}
            placeholder={intl.formatMessage({ id: "squad.common.skillsPlaceholder" })}
            onChange={(event) => setSkillsText(event.target.value)}
            data-testid="squad-agent-skills-input"
          />
        )}
      </Field>
      <Field labelId="squad.common.permissionMode">
        {(controlId) => (
          /* ③a：权限模式三态——「跟随默认（未设置）」是合法值（schema optional），不是缺省猜测。 */
          <Select
            value={permissionMode}
            onValueChange={(value) =>
              setPermissionMode(value as "unset" | TeamAgent["permissionMode"])
            }
          >
            <SelectTrigger id={controlId} data-testid="squad-agent-permission-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">
                {intl.formatMessage({ id: "squad.common.permissionMode.unset" })}
              </SelectItem>
              <SelectItem value="auto">
                {intl.formatMessage({ id: "squad.common.permissionMode.auto" })}
              </SelectItem>
              <SelectItem value="plan">
                {intl.formatMessage({ id: "squad.common.permissionMode.plan" })}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field labelId="squad.common.maxConcurrentRuns">
        {(controlId) => (
          /* 4b（裁定⑤）：并发上限 1–16（空 = 不提交保持原值；非法输入按空处理——
             服务面 schema 是最终闸，非法值落盘前会被拒）。 */
          <Input
            id={controlId}
            type="number"
            min={1}
            max={16}
            value={maxConcurrentRunsText}
            placeholder={String(
              resolveTeamAgentMaxConcurrentRuns({ maxConcurrentRuns: undefined }),
            )}
            onChange={(event) => setMaxConcurrentRunsText(event.target.value)}
            data-testid="squad-agent-max-concurrent-runs"
          />
        )}
      </Field>
      <Field labelId="squad.common.tools">
        {() => (
          <div className="flex flex-col gap-2" data-testid="squad-agent-tools-editor">
            <Select
              value={toolMode}
              onValueChange={(value) => setToolMode(value as "all" | "custom")}
            >
              <SelectTrigger className="w-fit" data-testid="squad-agent-tools-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {intl.formatMessage({ id: "squad.common.toolsMode.all" })}
                </SelectItem>
                <SelectItem value="custom">
                  {intl.formatMessage({ id: "squad.common.toolsMode.custom" })}
                </SelectItem>
              </SelectContent>
            </Select>
            {toolMode === "custom" ? (
              <div className="flex flex-wrap gap-2">
                {TOOL_OPTIONS.map((tool) => (
                  <label
                    key={tool}
                    className="flex items-center gap-1 text-ui-sm text-foreground-subtle"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTools.includes(tool)}
                      onChange={(event) =>
                        setSelectedTools((current) =>
                          event.target.checked
                            ? [...current, tool]
                            : current.filter((item) => item !== tool),
                        )
                      }
                    />
                    {tool}
                  </label>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </Field>
      <Field labelId="squad.common.disallowedTools">
        {(controlId) => (
          <Input
            id={controlId}
            value={disallowedText}
            placeholder={intl.formatMessage({ id: "squad.common.skillsPlaceholder" })}
            onChange={(event) => setDisallowedText(event.target.value)}
            data-testid="squad-agent-disallowed-input"
          />
        )}
      </Field>
      {/* per-agent MCP（multica 欠账 #2，设计 §3.6）：逐 server 行 + 「名字 + JSON」对话框。
          分区自带组标签与两条安全提示，值是本表单受控的（见上面的 mcpServers 状态）。 */}
      <TeamAgentMcpSection servers={mcpServers} onChange={setMcpServers} />
    </CreateDialogShell>
  );
}

/** 小队表单：**创建 / 编辑两用**（与 `TeamAgentDialog` 同一手法，只有这一份实现；另抄一份会让
    两个表单在字段与校验上陆续分叉，而分叉不报错）。`initial` 省略即「新建」，给出即「编辑」
    （填初值；标题与提交按钮由 `titleId` / `submitLabelId` 换）。提交回调形状两者相同：
    name / leaderAgentId / members / instructions —— 正是服务面 SquadRosterPatch 收的字段。 */
export function SquadDialog({
  candidates,
  members,
  onClose,
  onSubmit,
  initial,
  titleId = "squad.squads.create",
  submitLabelId = "squad.common.submit",
}: {
  candidates: TeamAgent[];
  members: TeamAgent[];
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    leaderAgentId: string;
    members: string[];
    instructions: { stopCondition: string; maxRounds: string };
  }) => void;
  /** 编辑既有小队时的初值；省略 = 新建（形状见 `SquadDialogInitial`，页面同用一份）。 */
  initial?: SquadDialogInitial;
  /** 标题文案键；省略即「新建小队」。 */
  titleId?: string;
  /** 提交按钮文案键；省略即「创建」。 */
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState(initial?.name ?? "");
  const [leaderAgentId, setLeaderAgentId] = useState(initial?.leaderAgentId ?? "");
  const [stopCondition, setStopCondition] = useState(initial?.stopCondition ?? "");
  const [maxRounds, setMaxRounds] = useState(initial?.maxRounds ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(initial?.memberIds ?? []);

  const leaderPlaceholder = intl.formatMessage({
    id: "squad.squads.leaderAgent",
  });
  const leaderName = candidates.find((agent) => agent.id === leaderAgentId)?.name;
  const selectableMembers = members.filter((agent) => agent.id !== leaderAgentId);

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={
        name.trim().length > 0 &&
        leaderAgentId.length > 0 &&
        stopCondition.trim().length > 0 &&
        maxRounds.trim().length > 0
      }
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          leaderAgentId,
          members: memberIds,
          instructions: { stopCondition: stopCondition.trim(), maxRounds: maxRounds.trim() },
        })
      }
    >
      <Field labelId="squad.common.name">
        {(controlId) => (
          <Input
            id={controlId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="squad.squads.leaderAgent">
        {(controlId) => (
          <Select
            value={leaderAgentId}
            onValueChange={(value) => {
              setLeaderAgentId(value);
              // 队长会自动并入 members（spec §3.3），别再勾一遍 —— 留着会让同一 agentId 出现两次。
              setMemberIds((current) => current.filter((id) => id !== value));
            }}
          >
            <SelectTrigger id={controlId}>
              <SelectValue placeholder={leaderPlaceholder}>{leaderName}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <FieldGroup labelId="squad.squads.memberAgents">
        {selectableMembers.length === 0 ? (
          <p className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "squad.squads.memberAgents.none" })}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {selectableMembers.map((agent) => (
              <label
                key={agent.id}
                className="flex items-center gap-2 text-ui-base text-foreground"
              >
                <Checkbox
                  checked={memberIds.includes(agent.id)}
                  onCheckedChange={(checked) =>
                    setMemberIds((current) =>
                      checked === true
                        ? [...current, agent.id]
                        : current.filter((id) => id !== agent.id),
                    )
                  }
                />
                {agent.name}
              </label>
            ))}
          </div>
        )}
      </FieldGroup>
      <Field labelId="squad.squads.stopCondition">
        {(controlId) => (
          <Input
            id={controlId}
            value={stopCondition}
            onChange={(event) => setStopCondition(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="squad.squads.maxRounds">
        {(controlId) => (
          <Input
            id={controlId}
            value={maxRounds}
            onChange={(event) => setMaxRounds(event.target.value)}
          />
        )}
      </Field>
    </CreateDialogShell>
  );
}

/**
 * 「新建工作项」对话框提交的形状（**带 mode 的判别联合**）：create 带全部字段，
 * edit **只能**带标题 / 正文 / 标签 / 三项 Surface 字段 —— 指派人与父项**不是**可编辑字段（见下），
 * 让它们在类型上就不存在比"界面上藏起来、回调里其实能传"更强。
 *
 * `labels` 两支都**必带**（不是可选）：编辑不带标签等于「提交空标签」，会把库里已有的标签
 * 清掉 —— 那是一次静默的数据丢失。必带让「随手漏传」在编译期就过不去。
 *
 * 阶段一轮 C 的三项 Surface 字段（priority / startDate / dueDate）同理**两支都必带**：
 * 服务面把 `undefined` 读成「没提这个字段」而保留旧值，`null` 才是「清回未设置」——
 * 编辑表单里的空输入表达的正是后者，漏传会让「界面上清空了、库里还在」。
 */
export type WorkItemDialogSubmitInput =
  | {
      mode: "create";
      title: string;
      body?: string;
      parentId?: string;
      assignee: WorkItem["assignee"];
      labels: string[];
      priority: WorkItemPriorityKey | null;
      startDate: string | null;
      dueDate: string | null;
    }
  | {
      mode: "edit";
      title: string;
      body?: string;
      labels: string[];
      priority: WorkItemPriorityKey | null;
      startDate: string | null;
      dueDate: string | null;
    };

/** 工作项表单：**创建 / 编辑两用**（只有这一份实现 —— 另抄一份编辑表单会让两个表单
    在字段与校验上陆续分叉，而分叉不报错）。`mode` 默认 `"create"`（显示全部字段，现状）；
    `"edit"` 只显示标题 / 正文 / 标签：
    ① **指派人不在编辑里** —— 改负责人是**派发语义**（改派 = 新派发），与"改个错别字"不是一类动作：
       它有自己的入口（看板行「改派」钮 → `ReassignWorkItemDialog` → 服务面 `reassignWorkItem`，
       支持 user / agent / squad，同值短路），故这份表单**不做**第二遍改派；
    ② **父项不在编辑里** —— 服务面 `updateContent` 只写 title / body / labels，移动父项没有路径，
       给一个提交后不生效的下拉比不给更糟。
    编辑成功与新建成功的回调形状因此不同（判别联合），由页面按 `mode` 分流。

    标签（#11 v1）：一个文本框（逗号 / 换行分隔），提交前经 shared 的 `parseWorkItemLabels` 预检
    —— **非 ok 就地显示文案并拦下提交**（不静默截断后提交：那会变成「界面说成功、库里少几个」）。 */
export function WorkItemDialog({
  snapshot,
  onClose,
  onSubmit,
  mode = "create",
  initial,
  titleId = "squad.workItems.create",
  submitLabelId = "squad.common.submit",
}: {
  snapshot: SquadSnapshot;
  onClose: () => void;
  onSubmit: (input: WorkItemDialogSubmitInput) => void;
  /** `create`（默认）显示全部字段；`edit` 只显示标题 / 正文 / 标签 / 三项 Surface 字段（理由见上）。 */
  mode?: "create" | "edit";
  /** 编辑既有工作项时的初值（标题 / 正文 / 标签 / 优先级 / 起止日期）；省略 = 空白（仅 create 用得到）。 */
  initial?: {
    title: string;
    body: string;
    labels?: string[];
    /** 三项 Surface 字段（阶段一轮 C）：`undefined` = 未设置（表单显示为空白 / 「未设置」）。 */
    priority?: WorkItemPriorityKey;
    startDate?: string;
    dueDate?: string;
  };
  /** 标题文案键；省略即「新建工作项」。 */
  titleId?: string;
  /** 提交按钮文案键；省略即「创建」。 */
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  /* 标签初值用**同一个解析函数**能读懂的形状回填（逗号分隔）：回填与解析是同一条语法，
     否则「编辑一次、没动标签、标签变了」会成为一个没人能一眼看出的 bug。 */
  const [labelsText, setLabelsText] = useState((initial?.labels ?? []).join(", "));
  /** 非 ok 的解析结论（超限）：**显示文案并拦下提交**，不静默截断（截断后提交 = 界面说成功、库里少几个）。 */
  const [labelsError, setLabelsError] = useState<WorkItemLabelsFailure | null>(null);
  /* 三项 Surface 字段（阶段一轮 C）：优先级是**选择**（哨兵 = 未设置），起止日期是 `YYYY-MM-DD` 文本。
     状态是**输入原文**（不是解析后的值）：坏输入要原样留着让用户改，不能悄悄换成空。
     优先级初值经 `workItemInlinePrioritySelectValue`：未设置 ⇒ **哨兵**（空串是 Radix 的 placeholder
     语义，`SelectItem` 拿到它直接抛 —— 轮 D 的缺陷就出在这里，见 `WorkItemPriorityField`）。 */
  const [priorityValue, setPriorityValue] = useState<string>(
    workItemInlinePrioritySelectValue(initial?.priority),
  );
  const [startDateText, setStartDateText] = useState(initial?.startDate ?? "");
  const [dueDateText, setDueDateText] = useState(initial?.dueDate ?? "");
  /** 非 ok 的解析结论（**指名到字段**）：同样拦下提交并留下文案。 */
  const [surfaceFieldsError, setSurfaceFieldsError] = useState<{
    messageId: string;
    value: string;
  } | null>(null);
  const [assigneeValue, setAssigneeValue] = useState("user");
  const [parentValue, setParentValue] = useState(NO_PARENT_VALUE);

  // 候选只含**可派发**的智能体 / 小队（停用与归档的不给：给了再被拒等于替用户制造一次失败）。
  const assigneeOptions = workItemAssigneeOptions(snapshot);
  const isEdit = mode === "edit";
  const labelsErrorText = (result: WorkItemLabelsFailure): string =>
    result.kind === "too_many"
      ? intl.formatMessage(
          { id: "squad.workItems.labelsTooMany" },
          { max: result.max, count: result.count },
        )
      : intl.formatMessage({ id: "squad.workItems.labelsTooLong" }, { max: result.max });

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={title.trim().length > 0}
      onSubmit={() => {
        /* 标签预检：判据只有一处（shared 的纯函数），非 ok ⇒ **拦在提交之前**并留下文案。
           不静默截断后提交 —— 那会让界面显示「已保存」而库里少了几个标签。 */
        const parsedLabels = parseWorkItemLabels([labelsText]);
        if (parsedLabels.kind !== "ok") {
          setLabelsError(parsedLabels);
          return;
        }
        setLabelsError(null);
        /* 三项 Surface 字段预检：同样是**拦在提交之前**（判据单源在 shared，经
           `parseWorkItemSurfaceFields` 翻译「空白 ⇒ 未设置」）。坏值原样留在输入框里，
           文案指名是哪一项 —— 不静默折成未设置（那会让用户明确填过的一天凭空消失）。 */
        const surfaceFields: WorkItemSurfaceFieldsParseResult = parseWorkItemSurfaceFields({
          // 下拉取值的哨兵 → 表单口径的空串（唯一的翻译处；纯函数再把空白读成 null = 清回未设置）。
          priority: workItemPriorityFieldInput(priorityValue),
          startDate: startDateText,
          dueDate: dueDateText,
        });
        if (surfaceFields.kind !== "ok") {
          setSurfaceFieldsError({
            messageId: workItemSurfaceFieldErrorMessageId(surfaceFields.field),
            value: surfaceFields.value,
          });
          return;
        }
        setSurfaceFieldsError(null);
        if (isEdit) {
          // 编辑：body **总是**提交（哪怕用户清空成 ""）—— 传 undefined 会被服务面当成
          // "没提这个字段"而保留旧正文，用户以为删掉了、盘上还在。标签同理（空文本 = 清空）；
          // 三项 Surface 字段同理（空输入 = 清回未设置，服务面把 null 与 undefined 分得很清）。
          onSubmit({
            mode: "edit",
            title: title.trim(),
            body,
            labels: parsedLabels.labels,
            priority: surfaceFields.patch.priority,
            startDate: surfaceFields.patch.startDate,
            dueDate: surfaceFields.patch.dueDate,
          });
          return;
        }
        onSubmit({
          mode: "create",
          title: title.trim(),
          // 新建时的既有口径不变：正文空白视作"没给"（存库为 ""，两者等价，不传更诚实）。
          body: body.trim() ? body : undefined,
          parentId: parentValue === NO_PARENT_VALUE ? undefined : parentValue,
          assignee: parseAssigneeValue(assigneeValue),
          labels: parsedLabels.labels,
          priority: surfaceFields.patch.priority,
          startDate: surfaceFields.patch.startDate,
          dueDate: surfaceFields.patch.dueDate,
        });
      }}
    >
      <Field labelId="squad.common.title">
        {(controlId) => (
          <Input
            id={controlId}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="squad.common.body">
        {(controlId) => (
          <SettingsFormTextarea
            id={controlId}
            value={body}
            rows={3}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </Field>
      {/* 标签（#11 v1）：创建与编辑**都给**（它属「改个错别字」那一类内容编辑，与改派/移动父项不同）。
          输入法就是文本（逗号 / 换行分隔）—— 不造标签表、不造建议列表（v1 的取值域是开放字符串）。 */}
      <Field labelId="squad.workItems.labels">
        {(controlId) => (
          <Input
            id={controlId}
            value={labelsText}
            placeholder={intl.formatMessage({ id: "squad.workItems.labelsPlaceholder" })}
            onChange={(event) => setLabelsText(event.target.value)}
          />
        )}
      </Field>
      {labelsError ? (
        <p className="text-ui-xs text-destructive" data-testid="work-item-labels-error">
          {labelsErrorText(labelsError)}
        </p>
      ) : null}
      {/* 三项 Surface 字段（阶段一轮 C）：创建与编辑**都给** —— 都是「改个错别字」那一类内容编辑
          （服务面 `createWorkItem` / `updateWorkItem` 的白名单都已开）。判据在纯函数里，控件只收集原文。
          优先级字段自轮 D 缺陷修复起独立成模块（哨兵 + 选项表单源，见 `WorkItemPriorityField`）。 */}
      <WorkItemPriorityField value={priorityValue} onChange={setPriorityValue} />
      {/* 起止日期：输入就是 `YYYY-MM-DD` **文本**（不用 `type="date"`：那会把值交给平台日期控件，
          取值随 locale/时区漂移，而我们的契约是无时区的日历日）。占位符给形状提示。 */}
      <Field labelId="squad.workItems.startDate">
        {(controlId) => (
          <Input
            id={controlId}
            data-testid="work-item-start-date"
            value={startDateText}
            placeholder={intl.formatMessage({ id: "squad.workItems.datePlaceholder" })}
            onChange={(event) => setStartDateText(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="squad.workItems.dueDate">
        {(controlId) => (
          <Input
            id={controlId}
            data-testid="work-item-due-date"
            value={dueDateText}
            placeholder={intl.formatMessage({ id: "squad.workItems.datePlaceholder" })}
            onChange={(event) => setDueDateText(event.target.value)}
          />
        )}
      </Field>
      {surfaceFieldsError ? (
        <p className="text-ui-xs text-destructive" data-testid="work-item-surface-fields-error">
          {intl.formatMessage(
            { id: surfaceFieldsError.messageId },
            { value: surfaceFieldsError.value },
          )}
        </p>
      ) : null}
      {/* 指派人与父项**只在创建时**出现（编辑为何不带它们见函数头注释）。 */}
      {!isEdit ? (
        <>
          <Field labelId="squad.common.assignee">
            {(controlId) => (
              <Select value={assigneeValue} onValueChange={setAssigneeValue}>
                <SelectTrigger id={controlId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {assigneeOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.kind === "user"
                        ? intl.formatMessage({ id: "squad.common.assignee.user" })
                        : option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field labelId="squad.common.parent">
            {(controlId) => (
              <Select value={parentValue} onValueChange={setParentValue}>
                <SelectTrigger id={controlId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PARENT_VALUE}>
                    {intl.formatMessage({ id: "squad.common.parent.none" })}
                  </SelectItem>
                  {snapshot.workItems.map((workItem) => (
                    <SelectItem key={workItem.id} value={workItem.id}>
                      {workItem.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
        </>
      ) : null}
    </CreateDialogShell>
  );
}
