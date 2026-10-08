import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workItemPrioritySelectOptions } from "./WorkItemPriorityField.js";
import { workItemSurfaceTwinControlLabel } from "./workItemSurfaceControlsViewModel.js";
import {
  WORK_ITEM_BULK_FIELD_MESSAGE_IDS,
  WORK_ITEM_BULK_FIELDS,
  WORK_ITEM_BULK_RESULT_MESSAGE_ID,
  resolveWorkItemBulkEdit,
  type WorkItemBulkDraft,
  type WorkItemBulkDraftIntent,
  type WorkItemBulkField,
  type WorkItemBulkResult,
} from "./workItemBulkViewModel.js";

/* 工作项**批量工具栏**（阶段二 · T-P2-R5）：多选行之后的动作条 —— 入口（批量操作）+ 已选计数 +
   清除选择 + 「哪个字段 / 取值」+ 应用到已选 + **逐条**结果。

   三条口径（各自的理由都在这里）：
   ① **受控**：草稿（字段 + 取值）与结果都在**页面**（会话内状态的所有者，与 `surface` /
      `laneDimension` 同款），本组件不持 useState —— 自持草稿 = 第二份真相（R6 的命名视图读不到它），
      且交互态无法被真渲染用例钉住（本包没有交互测试设施）。控件只回传**意图**（`onDraftIntent`）。
   ② **判据在纯函数**：取值合不合法问 `resolveWorkItemBulkEdit`（→ 表单/共享的那两份判据），
      "能不能应用"= 有选中 ∧ 取值 ok ∧ 不在飞；本组件只投影结论。
   ③ **零键增**：全部文案键都来自阶段二冻结清单与既有键（字段名 / 三枚写入判据 / 标签上限 /
      单条写失败词汇）—— 缺键要按阻塞上报，不得就地加。

   可及名称：入口按钮 = `bulk.label` 正文；字段下拉用 R4 的「族 + 当前值」组合名（「排序方向」
   那枚键不存在，同理"批量字段"也不存在），取值控件用**字段名**（与字段下拉的组合名可区分）。 */

/** 批量工具栏的入参（页面构造 `WorkItemBulkToolbarInput`；`disabledReason` 由控件带用同一份判据补上）。 */
export type WorkItemBulkToolbarProps = {
  /** 是否处于批量选择模式（勾选件只在模式开启时出现在行上）。 */
  active: boolean;
  /** 生效选择集的项数（页面按「可见 ∩ 可写」收敛后的数）。 */
  selectedCount: number;
  /** 取值草稿（页面持有；换字段时的重置走 `applyWorkItemBulkDraftIntent`）。 */
  draft: WorkItemBulkDraft;
  /** 取数不可用的原因（复用 `workItemSurfaceControlsDisabledReason` 的结论；`null` = 可用）。 */
  disabledReason: string | null;
  /** 批量写请求在飞（去重）。 */
  applying: boolean;
  /** 上一次批量写的结果（`null` = 还没有结果）。 */
  result: WorkItemBulkResult | null;
  onToggleActive: () => void;
  onClear: () => void;
  onDraftIntent: (intent: WorkItemBulkDraftIntent) => void;
  onApply: () => void;
};

/** 控件带侧要构造的入参（`disabledReason` 不必由页面算：控件带手里就有那份判据的结论）。 */
export type WorkItemBulkToolbarInput = Omit<WorkItemBulkToolbarProps, "disabledReason">;

const BULK_TOGGLE_MESSAGE_ID = "squad.workItems.bulk.label";
const BULK_COUNT_MESSAGE_ID = "squad.workItems.bulk.selected";
const BULK_CLEAR_MESSAGE_ID = "squad.workItems.bulk.clear";
const BULK_APPLY_MESSAGE_ID = "squad.workItems.bulk.apply";

export function WorkItemBulkToolbar(props: WorkItemBulkToolbarProps) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const {
    active,
    selectedCount,
    draft,
    disabledReason,
    applying,
    result,
    onToggleActive,
    onClear,
    onDraftIntent,
    onApply,
  } = props;

  const disabled = disabledReason !== null;
  const disabledTitle = disabledReason === null ? undefined : t(disabledReason);
  /* 取值判据单源：非 ok 就地说明是哪一项的哪个值不对，并拦下「应用到已选」。 */
  const resolution = resolveWorkItemBulkEdit(draft);
  const invalid = resolution.kind === "invalid" ? resolution : null;
  const applyEnabled = !disabled && !applying && selectedCount > 0 && resolution.kind === "ok";
  const fieldLabel = t(WORK_ITEM_BULK_FIELD_MESSAGE_IDS[draft.field]);
  const dateValue = draft.field === "startDate" || draft.field === "dueDate";

  return (
    <div
      role="group"
      aria-label={t(BULK_TOGGLE_MESSAGE_ID)}
      className="flex flex-wrap items-center justify-end gap-2"
    >
      {/* 入口**常驻**（与刷新 / 新建同一条姿态）：取数不可用时只置灰 + 给原因，不消失。
          开启后行上出现勾选件（行模块产出），三者（入口 / 勾选件 / 本条的其余控件）同进同出。 */}
      <Button
        variant="outline"
        size="sm"
        aria-pressed={active}
        disabled={disabled}
        title={disabledTitle}
        data-testid="work-items-bulk-toggle"
        onClick={onToggleActive}
      >
        {t(BULK_TOGGLE_MESSAGE_ID)}
      </Button>
      {active ? (
        <>
          <span className="text-ui-xs text-foreground-subtle" data-testid="work-items-bulk-count">
            {t(BULK_COUNT_MESSAGE_ID, { count: selectedCount })}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || selectedCount === 0}
            title={disabledTitle}
            data-testid="work-items-bulk-clear"
            onClick={onClear}
          >
            {t(BULK_CLEAR_MESSAGE_ID)}
          </Button>
          {/* 字段闭集（Q7：只有内容型字段）。选它只回传意图 —— 换字段时**取值重置**在该折叠里
              （把上一字段的值带过去会让用户从没输入过的内容被写进整批行）。 */}
          <Select
            value={draft.field}
            onValueChange={(value) =>
              onDraftIntent({ kind: "setField", field: value as WorkItemBulkField })
            }
          >
            <SelectTrigger
              size="sm"
              disabled={disabled}
              title={disabledTitle}
              aria-label={workItemSurfaceTwinControlLabel(t(BULK_TOGGLE_MESSAGE_ID), fieldLabel)}
              data-testid="work-items-bulk-field"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORK_ITEM_BULK_FIELDS.map((field) => (
                <SelectItem key={field} value={field}>
                  {t(WORK_ITEM_BULK_FIELD_MESSAGE_IDS[field])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* 取值控件随字段切换：优先级是**下拉**（复用表单字段的选项表：哨兵 + 四档 —— 空串是
              Radix 保留给 placeholder 的，选中态会飘），标签 / 日期是文本（日期就是 `YYYY-MM-DD`
              文本，不用 `type="date"`：那会把取值交给平台日期控件，随 locale/时区漂移）。 */}
          {draft.field === "priority" ? (
            <Select
              value={draft.value}
              onValueChange={(value) => onDraftIntent({ kind: "setValue", value })}
            >
              <SelectTrigger
                size="sm"
                disabled={disabled}
                title={disabledTitle}
                aria-label={fieldLabel}
                data-testid="work-items-bulk-priority"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workItemPrioritySelectOptions().map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.messageId)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              type="text"
              size="sm"
              className="w-40 text-mobile-input-safe md:text-ui-base/relaxed"
              disabled={disabled}
              title={disabledTitle}
              aria-label={fieldLabel}
              placeholder={dateValue ? t("squad.workItems.datePlaceholder") : undefined}
              data-testid="work-items-bulk-value"
              value={draft.value}
              onChange={(event) => onDraftIntent({ kind: "setValue", value: event.target.value })}
            />
          )}
          <Button
            size="sm"
            disabled={!applyEnabled}
            title={disabledTitle}
            data-testid="work-items-bulk-apply"
            onClick={onApply}
          >
            {t(BULK_APPLY_MESSAGE_ID)}
          </Button>
        </>
      ) : null}
      {/* 非法取值：就地说明（不清输入）；空标签（empty）**不是**错误，故这里不出现。
          `{value}` 用**原文**（哪一个值不对）—— 与对话框同一份拼法（判据也同一份）。 */}
      {active && invalid !== null ? (
        <p className="text-ui-xs text-destructive" data-testid="work-items-bulk-invalid">
          {t(invalid.messageId, { value: invalid.value, ...invalid.values })}
        </p>
      ) : null}
      {/* 结果：**汇总 + 逐条**。汇总里的失败数由 failures 现算（`failures.length`）——
          存两个数迟早对不上，而"只汇报总数"正是本卡要禁的形态。 */}
      {result === null ? null : (
        <div className="flex w-full flex-col gap-1" data-testid="work-items-bulk-result">
          <span className="text-ui-xs text-foreground-subtle">
            {t(WORK_ITEM_BULK_RESULT_MESSAGE_ID, {
              ok: result.okCount,
              failed: result.failures.length,
            })}
          </span>
          {result.failures.length === 0 ? null : (
            <ul className="flex flex-col gap-1">
              {result.failures.map((failure) => (
                <li
                  key={failure.workItemId}
                  data-testid="work-items-bulk-failure"
                  className="flex flex-wrap items-center gap-1.5 text-ui-xs"
                >
                  <span className="min-w-0 break-words font-medium text-foreground">
                    {failure.title}
                  </span>
                  <span className="text-destructive">{t(failure.messageId, failure.values)}</span>
                  {failure.detail === undefined ? null : (
                    <span className="text-foreground-subtlest">{failure.detail}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
