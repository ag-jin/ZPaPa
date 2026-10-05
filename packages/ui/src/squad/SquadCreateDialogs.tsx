/* oxlint-disable eslint(max-lines) -- 创建/编辑双用表单：TeamAgent 与 Squad 两个对话框刻意同文件（两份表单会分叉）；字段区按服务面白名单一一对应。 */
import { useState } from "react";
import type { SquadSnapshot } from "@zcode/services";
import { TEAM_AGENT_COLORS, type TeamAgent, type WorkItem } from "@zcode/shared";
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
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import type { ModelSelection } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { parseAssigneeValue, workItemAssigneeOptions } from "./squadEntryViewModel.js";
import { CreateDialogShell, Field, FieldGroup } from "./squadDialogParts.js";
import type { SquadDialogInitial } from "./squadsViewModel.js";

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
 * `initial` 省略即「新建」（空白表单）；给出即「编辑」（按既有值填初值，标题与提交按钮
 * 的文案由 `titleId` / `submitLabelId` 换）。提交的回调形状两者相同：三个可编辑字段
 * ——正是服务面 `updateTeamAgent` 的白名单（`TeamAgentEditablePatch`），不多不少。
 */
export function TeamAgentDialog({
  onClose,
  onSubmit,
  initial,
  modelView,
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
  }) => void;
  /** 编辑既有智能体时的初值；省略 = 新建。 */
  initial?: {
    name: string;
    systemPrompt: string;
    memoryScope: TeamAgent["memoryScope"];
    description?: string;
    color?: TeamAgent["color"];
    modelSelection?: ModelSelection;
  };
  /** 模型选择视图（②b）：由页面持有 `useModelSelectionServiceView` 传入——dialog 保持纯受控，
      模型清单/生效值的取数不在表单里再起一份。undefined = 服务不可用（控件禁用态）。 */
  modelView?: ReturnType<typeof useModelSelectionServiceView>["state"];
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

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={name.trim().length > 0 && systemPrompt.trim().length > 0}
      onSubmit={() =>
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
                  ...(reasoningLevel !== undefined
                    ? { options: { reasoningLevel } }
                    : {}),
                },
              }
            : {}),
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
      <Field labelId="squad.common.systemPrompt">
        {(controlId) => (
          <SettingsFormTextarea
            id={controlId}
            value={systemPrompt}
            rows={4}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
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
 * edit **只能**带标题 / 正文 —— 指派人与父项**不是**可编辑字段（见下），让它们
 * 在类型上就不存在比"界面上藏起来、回调里其实能传"更强。
 */
export type WorkItemDialogSubmitInput =
  | {
      mode: "create";
      title: string;
      body?: string;
      parentId?: string;
      assignee: WorkItem["assignee"];
    }
  | { mode: "edit"; title: string; body?: string };

/** 工作项表单：**创建 / 编辑两用**（只有这一份实现 —— 另抄一份编辑表单会让两个表单
    在字段与校验上陆续分叉，而分叉不报错）。`mode` 默认 `"create"`（显示全部字段，现状）；
    `"edit"` 只显示标题 / 正文：
    ① **指派人不在编辑里** —— 改负责人是**派发语义**（改派 = 新派发），与"改个错别字"不是一类动作：
       它有自己的入口（看板行「改派」钮 → `ReassignWorkItemDialog` → 服务面 `reassignWorkItem`，
       支持 user / agent / squad，同值短路），故这份表单**不做**第二遍改派；
    ② **父项不在编辑里** —— 服务面 `updateContent` 只写 title / body，移动父项没有路径，
       给一个提交后不生效的下拉比不给更糟。
    编辑成功与新建成功的回调形状因此不同（判别联合），由页面按 `mode` 分流。 */
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
  /** `create`（默认）显示全部字段；`edit` 只显示标题 / 正文（理由见上）。 */
  mode?: "create" | "edit";
  /** 编辑既有工作项时的初值（标题 / 正文）；省略 = 空白（仅 create 用得到）。 */
  initial?: { title: string; body: string };
  /** 标题文案键；省略即「新建工作项」。 */
  titleId?: string;
  /** 提交按钮文案键；省略即「创建」。 */
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [assigneeValue, setAssigneeValue] = useState("user");
  const [parentValue, setParentValue] = useState(NO_PARENT_VALUE);

  // 候选只含**可派发**的智能体 / 小队（停用与归档的不给：给了再被拒等于替用户制造一次失败）。
  const assigneeOptions = workItemAssigneeOptions(snapshot);
  const isEdit = mode === "edit";

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={title.trim().length > 0}
      onSubmit={() => {
        if (isEdit) {
          // 编辑：body **总是**提交（哪怕用户清空成 ""）—— 传 undefined 会被服务面当成
          // "没提这个字段"而保留旧正文，用户以为删掉了、盘上还在。
          onSubmit({ mode: "edit", title: title.trim(), body });
          return;
        }
        onSubmit({
          mode: "create",
          title: title.trim(),
          // 新建时的既有口径不变：正文空白视作"没给"（存库为 ""，两者等价，不传更诚实）。
          body: body.trim() ? body : undefined,
          parentId: parentValue === NO_PARENT_VALUE ? undefined : parentValue,
          assignee: parseAssigneeValue(assigneeValue),
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
