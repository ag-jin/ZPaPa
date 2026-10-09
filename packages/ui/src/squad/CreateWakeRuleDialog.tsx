import { useState } from "react";
import type { CreateWakeRuleRequest, UpdateWakeRuleRequest } from "@zcode/services";
import type { WorkItem } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { CreateDialogShell, Field } from "./squadDialogParts.js";
import {
  buildCreateWakeRuleInput,
  buildUpdateWakeRuleInput,
  resolveWorkItemTitle,
  type CreateWakeRuleForm,
} from "./wakeRulesViewModel.js";

/* 「唤醒规则」对话框：**创建 / 编辑两用**（照 `TeamAgentDialog` / `SquadDialog` / `WorkItemDialog`
   的既有手法：可选 `mode` / `initial` / `titleId` / `submitLabelId`）——**只有这一份表单**；
   另抄一份编辑表单会让两个表单在字段与校验上陆续分叉，而分叉不报错。
   编辑模式的差异只有两处：① 工作项**只读**（挂载对象不可改）；② 提交走
   `buildUpdateWakeRuleInput`（与创建**同一份**校验核心）并交回 patch。

   三条纪律（创建 / 编辑共同遵守）：
   1. **mode 由 kind 推导、不作为独立选择**（第 39 轮硬约束）：`validateWakeRule` 强制
      at⇒once、every/cron⇒continuous —— 让用户自由组合只会邀请失败。界面只选 kind，
      另给一行 `kindHint.<kind>` 说明语义（含推导出的 mode）。编辑的 patch 里同样带**推导结果**
      （服务面不另写一份推导 —— `validateWakeRule` 互斥第 1 条是最终判据）。
   2. **kind 切换时清掉上一类的字段**：at/every/cron 三个排期字段一次只有一个有意义，
      留着上一类的值会被 `validateWakeRule` 的互斥拒绝（两种调度口径并存 = 静默死配置），
      但用户不必走到那一步 —— 切换即清空。上限（maxFires）在两个连续 kind（every/cron）
      之间切换时保留（同一个语义）；切进 `at`（once 没有上限语义）时**一并清掉** ——
      否则会留下一个**不可见也改不掉**的输入，把下一次提交变成一次必然失败。
   3. **本组件不执行任何服务调用**：校验不过 ⇒ 就地显示 reasonId 文案（不调服务、也不把
      必然失败的请求递上去）；通过 ⇒ 把入参 / patch 原样交回 `onSubmit`（执行在分区，与三个
      创建表单同款）。提交期间由分区透传的 `busy` 禁重复提交。 */

/** kind 的三种取值（与 `WakeRuleKind` 的排班三支一致；事件型不给入口 —— 需要未枚举的词汇表）。 */
const WAKE_RULE_FORM_KINDS = ["at", "every", "cron"] as const;
type WakeRuleFormKind = (typeof WAKE_RULE_FORM_KINDS)[number];

/** 提交的回执形状（判别联合）：创建交 `CreateWakeRuleRequest`、编辑交配置 patch（不含 workItemId）。 */
export type WakeRuleDialogSubmit =
  | { mode: "create"; input: CreateWakeRuleRequest }
  | { mode: "edit"; patch: UpdateWakeRuleRequest };

export function CreateWakeRuleDialog({
  workItems,
  busy,
  onClose,
  onSubmit,
  mode = "create",
  initial,
  titleId = "squad.rules.createTitle",
  submitLabelId = "squad.common.submit",
}: {
  /** 规则宿主候选（= 当前项目的工作项；分区从页面透传）。空数组 ⇒ 无处可挂，分区不会开这个框。 */
  workItems: WorkItem[];
  /** 提交在飞（分区状态）：期间禁掉重复提交（壳的 canSubmit）与关闭之外的交互。 */
  busy: boolean;
  onClose: () => void;
  /** 校验通过后原样交回入参 / patch（**本组件不执行任何服务调用**）。 */
  onSubmit: (submit: WakeRuleDialogSubmit) => void;
  /** `create`（默认）可选宿主；`edit` 宿主只读（挂载对象不可改）。 */
  mode?: "create" | "edit";
  /** 编辑既有规则时的初值（`wakeRuleDialogInitial` 给出）；省略 = 空白（仅 create 用得到）。 */
  initial?: CreateWakeRuleForm;
  /** 标题文案键；省略即「新建唤醒规则」。 */
  titleId?: string;
  /** 提交按钮文案键；省略即「创建」（编辑传「保存」——同一个表单不抄第二份）。 */
  submitLabelId?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  const isEdit = mode === "edit";
  const [workItemId, setWorkItemId] = useState(initial?.workItemId ?? workItems[0]?.id ?? "");
  const [kind, setKind] = useState<WakeRuleFormKind>(initial?.kind ?? "at");
  const [atLocal, setAtLocal] = useState(initial?.atLocal ?? "");
  const [intervalSecondsText, setIntervalSecondsText] = useState(
    initial?.intervalSecondsText ?? "",
  );
  const [cronExpression, setCronExpression] = useState(initial?.cronExpression ?? "");
  const [maxFiresText, setMaxFiresText] = useState(initial?.maxFiresText ?? "");
  /** 上一次提交被拒的文案 id（就地显示；改任何字段即清掉，避免把旧结论挂在新输入上）。 */
  const [reasonId, setReasonId] = useState<string | null>(null);

  const changeKind = (next: WakeRuleFormKind) => {
    setKind(next);
    // 见文件头第 2 条：三个排期字段全清（任何切换都换了「哪个字段有意义」）+ 进 at 清上限。
    setAtLocal("");
    setIntervalSecondsText("");
    setCronExpression("");
    if (next === "at") setMaxFiresText("");
    setReasonId(null);
  };

  const submit = () => {
    const form: CreateWakeRuleForm = {
      workItemId,
      kind,
      atLocal,
      intervalSecondsText,
      cronExpression,
      maxFiresText,
    };
    // `now` 取提交时刻（不是渲染时刻）：到点时刻必须严格晚于**提交**时刻，早一秒都会提交即过点。
    if (isEdit) {
      const result = buildUpdateWakeRuleInput(form, Date.now());
      if (!result.ok) {
        setReasonId(result.reasonId);
        return;
      }
      setReasonId(null);
      onSubmit({ mode: "edit", patch: result.patch });
      return;
    }
    const result = buildCreateWakeRuleInput(form, Date.now());
    if (!result.ok) {
      setReasonId(result.reasonId);
      return;
    }
    setReasonId(null);
    onSubmit({ mode: "create", input: result.input });
  };

  return (
    <CreateDialogShell
      titleId={titleId}
      submitLabelId={submitLabelId}
      onClose={onClose}
      canSubmit={workItemId !== "" && !busy}
      onSubmit={submit}
    >
      {/* kind 语义说明（含 mode 推导）：放在类型字段之外，用户切换前就能读到。 */}
      <p className="text-ui-xs text-foreground-subtle">{t("squad.rules.createHint")}</p>
      {/* 工作项：创建 = 可选宿主；编辑 = **只读**（挂载对象不可改 —— 改了等于换一条规则的归属，
          应删旧建新，见 `hostLocked` 的说明行）。只读用 disabled 输入框而不是禁用下拉：
          宿主可能已归档（`workItems` 里查不到），下拉会显示成空值 —— 输入框显示的话是
          标题回落 id 的诚实结果。 */}
      <Field labelId="squad.rules.workItem">
        {(controlId) =>
          isEdit ? (
            <Input id={controlId} value={resolveWorkItemTitle(workItems, workItemId)} disabled />
          ) : (
            <Select
              value={workItemId === "" ? undefined : workItemId}
              onValueChange={setWorkItemId}
            >
              <SelectTrigger id={controlId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workItems.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )
        }
      </Field>
      {isEdit ? (
        <p className="text-ui-xs text-foreground-subtle">{t("squad.rules.hostLocked")}</p>
      ) : null}
      <Field labelId="squad.rules.kind">
        {(controlId) => (
          <Select value={kind} onValueChange={(value) => changeKind(value as WakeRuleFormKind)}>
            <SelectTrigger id={controlId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WAKE_RULE_FORM_KINDS.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {t(`squad.rules.kind.${entry}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </Field>
      <p className="text-ui-xs text-foreground-subtle">{t(`squad.rules.kindHint.${kind}`)}</p>
      {kind === "at" ? (
        <Field labelId="squad.rules.atTime">
          {(controlId) => (
            <Input
              id={controlId}
              type="datetime-local"
              value={atLocal}
              onChange={(event) => {
                setAtLocal(event.target.value);
                setReasonId(null);
              }}
            />
          )}
        </Field>
      ) : kind === "every" ? (
        <Field labelId="squad.rules.intervalSeconds">
          {(controlId) => (
            <Input
              id={controlId}
              inputMode="numeric"
              value={intervalSecondsText}
              onChange={(event) => {
                setIntervalSecondsText(event.target.value);
                setReasonId(null);
              }}
            />
          )}
        </Field>
      ) : (
        <Field labelId="squad.rules.cronExpression">
          {(controlId) => (
            <Input
              id={controlId}
              value={cronExpression}
              onChange={(event) => {
                setCronExpression(event.target.value);
                setReasonId(null);
              }}
            />
          )}
        </Field>
      )}
      {/* 上限只对连续规则（every / cron）有意义：once 没有「上限」语义（弹一次就完了）。 */}
      {kind !== "at" ? (
        <Field labelId="squad.rules.maxFires">
          {(controlId) => (
            <Input
              id={controlId}
              inputMode="numeric"
              value={maxFiresText}
              onChange={(event) => {
                setMaxFiresText(event.target.value);
                setReasonId(null);
              }}
            />
          )}
        </Field>
      ) : null}
      {/* 校验不过**就地**显示（带原因，不调服务）：reasonId 由视图模型给出，这里只翻文案。 */}
      {reasonId !== null ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {t(reasonId)}
        </p>
      ) : null}
    </CreateDialogShell>
  );
}
