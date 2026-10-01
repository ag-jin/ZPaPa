import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { SquadSnapshot } from "@zcode/services";
import type { TeamAgent } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { parseAssigneeValue, workItemAssigneeOptions } from "./squadEntryViewModel.js";

/* 本阶段的三个「最小」创建表单（协作智能体 / 小队 / 工作项）。

   为什么单独成文件：它们是**表单**，与视图的取数、审查动作没有共享状态；拆开后
   视图只负责编排，表单只负责收集最小必要字段（其余属性按 spec §15 的分期留到后续版本）。

   为什么只收「最小必要字段」而不是照实体全量：`CreateTeamAgentInput` 的必填只有
   name / systemPrompt / memoryScope；`CreateSquadInput` 的必填之外，`validateSquad`
   还要求 stopCondition 与 maxRounds 两个槽位（spec §5.4）—— 那两个必须收，
   因为它们缺了服务层会直接拒，**不能**替用户编一个默认值（编出来的终止条件是假的）。 */

/** 下拉里表示「没有父项」的哨兵值：Radix Select 不允许空字符串取值。 */
const NO_PARENT_VALUE = "__none__";

/** 三个表单共用的外壳：标题 + 说明 + 提交/取消。 */
function CreateDialogShell({
  titleId,
  onSubmit,
  onClose,
  canSubmit,
  children,
}: {
  titleId: string;
  onSubmit: () => void;
  onClose: () => void;
  canSubmit: boolean;
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit();
  };
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      {/* 圆角由 DialogContent 原语给出（rounded-2xl，spec §11.3 的对话框层级）。 */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: titleId })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.experiments.squad.dialogHint" })}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-3">{children}</div>
          <SettingsFormActions>
            <Button type="button" variant="outline" onClick={onClose}>
              {intl.formatMessage({ id: "settings.experiments.squad.cancel" })}
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {intl.formatMessage({ id: "settings.experiments.squad.submit" })}
            </Button>
          </SettingsFormActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 单控件字段：用 `htmlFor`/`id` 把标签与控件关联（house style：见 HookForm.tsx）。
    控件 id 由 `useId()` 生成，避免多个对话框里的字面量 id 撞车。 */
function Field({
  labelId,
  children,
}: {
  labelId: string;
  children: (controlId: string) => ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const controlId = useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={controlId}>{intl.formatMessage({ id: labelId })}</Label>
      {children(controlId)}
    </div>
  );
}

/** 一组控件（多选队员）的字段：用 `role="group"` + `aria-labelledby` 关联组名，
    而不是让 `label` 的 `htmlFor` 指向一个不存在的控件。 */
function FieldGroup({ labelId, children }: { labelId: string; children: ReactNode }) {
  const { intl } = useZCodeIntl();
  const groupId = useId();
  return (
    <div className="flex flex-col gap-1" role="group" aria-labelledby={groupId}>
      <span id={groupId} className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: labelId })}
      </span>
      {children}
    </div>
  );
}

export function TeamAgentDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (input: {
    name: string;
    systemPrompt: string;
    memoryScope: TeamAgent["memoryScope"];
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [memoryScope, setMemoryScope] = useState<TeamAgent["memoryScope"]>("project");

  return (
    <CreateDialogShell
      titleId="settings.experiments.squad.createTeamAgent"
      onClose={onClose}
      canSubmit={name.trim().length > 0 && systemPrompt.trim().length > 0}
      onSubmit={() => onSubmit({ name: name.trim(), systemPrompt, memoryScope })}
    >
      <Field labelId="settings.experiments.squad.name">
        {(controlId) => (
          <Input
            id={controlId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.systemPrompt">
        {(controlId) => (
          <SettingsFormTextarea
            id={controlId}
            value={systemPrompt}
            rows={4}
            onChange={(event) => setSystemPrompt(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.memoryScope">
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
                  {intl.formatMessage({ id: `settings.experiments.squad.memoryScope.${scope}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
    </CreateDialogShell>
  );
}

export function SquadDialog({
  candidates,
  members,
  onClose,
  onSubmit,
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
}) {
  const { intl } = useZCodeIntl();
  const [name, setName] = useState("");
  const [leaderAgentId, setLeaderAgentId] = useState("");
  const [stopCondition, setStopCondition] = useState("");
  const [maxRounds, setMaxRounds] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);

  const leaderName = candidates.find((agent) => agent.id === leaderAgentId)?.name;
  const selectableMembers = members.filter((agent) => agent.id !== leaderAgentId);

  return (
    <CreateDialogShell
      titleId="settings.experiments.squad.createSquad"
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
      <Field labelId="settings.experiments.squad.name">
        {(controlId) => (
          <Input
            id={controlId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.leaderAgent">
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
              <SelectValue
                placeholder={intl.formatMessage({ id: "settings.experiments.squad.leaderAgent" })}
              >
                {leaderName}
              </SelectValue>
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
      <FieldGroup labelId="settings.experiments.squad.memberAgents">
        {selectableMembers.length === 0 ? (
          <p className="text-ui-xs text-foreground-subtlest">
            {intl.formatMessage({ id: "settings.experiments.squad.memberAgents.none" })}
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
      <Field labelId="settings.experiments.squad.stopCondition">
        {(controlId) => (
          <Input
            id={controlId}
            value={stopCondition}
            onChange={(event) => setStopCondition(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.maxRounds">
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

export function WorkItemDialog({
  snapshot,
  onClose,
  onSubmit,
}: {
  snapshot: SquadSnapshot;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    body?: string;
    parentId?: string;
    assignee: { type: "user" | "agent" | "squad"; id: string };
  }) => void;
}) {
  const { intl } = useZCodeIntl();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("user");
  const [parentValue, setParentValue] = useState(NO_PARENT_VALUE);

  // 候选只含**可派发**的智能体 / 小队（停用与归档的不给：给了再被拒等于替用户制造一次失败）。
  const assigneeOptions = workItemAssigneeOptions(snapshot);

  return (
    <CreateDialogShell
      titleId="settings.experiments.squad.createWorkItem"
      onClose={onClose}
      canSubmit={title.trim().length > 0}
      onSubmit={() =>
        onSubmit({
          title: title.trim(),
          body: body.trim() ? body : undefined,
          parentId: parentValue === NO_PARENT_VALUE ? undefined : parentValue,
          assignee: parseAssigneeValue(assigneeValue),
        })
      }
    >
      <Field labelId="settings.experiments.squad.title">
        {(controlId) => (
          <Input
            id={controlId}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.body">
        {(controlId) => (
          <SettingsFormTextarea
            id={controlId}
            value={body}
            rows={3}
            onChange={(event) => setBody(event.target.value)}
          />
        )}
      </Field>
      <Field labelId="settings.experiments.squad.assignee">
        {(controlId) => (
          <Select value={assigneeValue} onValueChange={setAssigneeValue}>
            <SelectTrigger id={controlId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {assigneeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.kind === "user"
                    ? intl.formatMessage({ id: "settings.experiments.squad.assignee.user" })
                    : option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <Field labelId="settings.experiments.squad.parent">
        {(controlId) => (
          <Select value={parentValue} onValueChange={setParentValue}>
            <SelectTrigger id={controlId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PARENT_VALUE}>
                {intl.formatMessage({ id: "settings.experiments.squad.parent.none" })}
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
    </CreateDialogShell>
  );
}
