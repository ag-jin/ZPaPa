import { useState } from "react";
import type { CreateWakeRuleRequest } from "@zcode/services";
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
import { buildCreateWakeRuleInput, type CreateWakeRuleForm } from "./wakeRulesViewModel.js";

/* 「新建唤醒规则」对话框（分区「新建规则」钮的落点）。复用 `squadDialogParts` 的壳与原语
   （与三个创建 / 编辑表单、改派对话框同款外观与焦点行为）。

   三条纪律：
   1. **mode 由 kind 推导、不作为独立选择**（第 39 轮硬约束）：`validateWakeRule` 强制
      at⇒once、every/cron⇒continuous —— 让用户自由组合只会邀请失败。界面只选 kind，
      另给一行 `kindHint.<kind>` 说明语义（含推导出的 mode）。
   2. **kind 切换时清掉上一类的字段**：at/every/cron 三个排期字段一次只有一个有意义，
      留着上一类的值会被 `validateWakeRule` 的互斥拒绝（两种调度口径并存 = 静默死配置），
      但用户不必走到那一步 —— 切换即清空。上限（maxFires）在两个连续 kind（every/cron）
      之间切换时保留（同一个语义）；切进 `at`（once 没有上限语义）时**一并清掉** ——
      否则会留下一个**不可见也改不掉**的输入，把下一次提交变成一次必然失败。
   3. **本组件不执行任何服务调用**：`buildCreateWakeRuleInput` 校验不过 ⇒ 就地显示
      reasonId 文案（不调服务、也不把必然失败的请求递上去）；通过 ⇒ 把入参原样交回
      `onSubmit`（执行在分区，与三个创建表单同款）。提交期间由分区透传的 `busy` 禁重复提交。 */

/** kind 的三种取值（与 `WakeRuleKind` 的排班三支一致；event 不给入口 —— 需要未枚举的事件词汇表）。 */
const WAKE_RULE_FORM_KINDS = ["at", "every", "cron"] as const;
type WakeRuleFormKind = (typeof WAKE_RULE_FORM_KINDS)[number];

export function CreateWakeRuleDialog({
  workItems,
  busy,
  onClose,
  onSubmit,
}: {
  /** 规则宿主候选（= 当前项目的工作项；分区从页面透传）。空数组 ⇒ 无处可挂，分区不会开这个框。 */
  workItems: WorkItem[];
  /** 提交在飞（分区状态）：期间禁掉重复提交（壳的 canSubmit）与关闭之外的交互。 */
  busy: boolean;
  onClose: () => void;
  /** 校验通过后原样交回 `createWakeRule` 的入参（**本组件不执行任何服务调用**）。 */
  onSubmit: (input: CreateWakeRuleRequest) => void;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });

  const [workItemId, setWorkItemId] = useState(workItems[0]?.id ?? "");
  const [kind, setKind] = useState<WakeRuleFormKind>("at");
  const [atLocal, setAtLocal] = useState("");
  const [intervalSecondsText, setIntervalSecondsText] = useState("");
  const [cronExpression, setCronExpression] = useState("");
  const [maxFiresText, setMaxFiresText] = useState("");
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
    // `now` 取提交时刻（不是渲染时刻）：到点时刻必须严格晚于**提交**时刻，早一秒都会建成即过点。
    const result = buildCreateWakeRuleInput(form, Date.now());
    if (!result.ok) {
      setReasonId(result.reasonId);
      return;
    }
    setReasonId(null);
    onSubmit(result.input);
  };

  return (
    <CreateDialogShell
      titleId="squad.rules.createTitle"
      onClose={onClose}
      canSubmit={workItemId !== "" && !busy}
      onSubmit={submit}
    >
      {/* kind 语义说明（含 mode 推导）：放在类型字段之外，用户切换前就能读到。 */}
      <p className="text-ui-xs text-foreground-subtle">{t("squad.rules.createHint")}</p>
      <Field labelId="squad.rules.workItem">
        {(controlId) => (
          <Select value={workItemId === "" ? undefined : workItemId} onValueChange={setWorkItemId}>
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
        )}
      </Field>
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
