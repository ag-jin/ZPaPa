import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { squadEntryErrorFeedback, type SquadEntryFeedback } from "./squadEntryViewModel.js";
import type { WorkItemProjectCreateResult } from "./useWorkItemProjects.js";
import {
  WORK_ITEM_PROJECT_SELECT_NEW,
  WORK_ITEM_PROJECT_SELECT_NONE,
  parseWorkItemProjectDraft,
  workItemProjectDraftErrorMessageId,
  workItemProjectEmptyDraft,
  workItemProjectPickerDisplay,
  workItemProjectShortCodeLooksValid,
  type WorkItemProjectDraft,
  type WorkItemProjectOption,
} from "./workItemProjectViewModel.js";

/* 项目**拾取器**（R-P2 项目绑定 · UI 轮）：创建流里的项目选择 + 「新建项目…」内联小表单
   （用户裁定的 v1 项目**管理入口**；独立项目管理页后置登记）。

   形态真源：multica 的 `ProjectPicker`（`packages/views/projects/components/project-picker.tsx`）
   —— 「无项目」选项用于**清除**（A1 的三层语义之三：选择器清除）；本仓加法是 v1 用「内联新建」
   承担管理入口（multica 的项目管理在项目页，本仓 v1 没有那个页面）。

   四条纪律（与快速创建/对话框同款）：
   ① **无项目是一等选项**（置顶、可清）：`undefined` 是合法状态，不是"没选"；
   ② **不记忆上次选择**：本组件不持有任何跨次状态；值由调用方按「父项继承 / 默认无项目」给出；
   ③ **唯一写路径**：新建项目只经注入的 `onCreateProject`（接线层 → `createProject` 服务面）；
      没有它 ⇒ 连「新建项目…」选项都不渲染（没有写路径的入口比没有更糟）；
   ④ **失败不吞 + 不乐观**：新建失败把原因就地显示并**保留表单**（用户不用重打）；
      成功选中的是**服务面读回的那条**（`WorkItemProjectCreateResult` 带回的 record）。 */

export function WorkItemProjectPicker({
  value,
  onChange,
  projects,
  onCreateProject,
  disabled,
  size = "sm",
  testId,
}: {
  /** UI 取值（哨兵见 `workItemProjectViewModel`；`WORK_ITEM_PROJECT_SELECT_NONE` = 无项目）。 */
  value: string;
  /** 选中变化（**只回传取值**：请求怎么拼由调用方按服务面契约做，本组件不碰请求）。 */
  onChange: (value: string) => void;
  /** 项目清单（`null` = 还没读到 ⇒ 只给「无项目」这一档）。 */
  projects: readonly WorkItemProjectOption[] | null;
  /** 内联新建的写路径（缺省 ⇒ 不渲染「新建项目…」）。 */
  onCreateProject?: (draft: WorkItemProjectDraft) => Promise<WorkItemProjectCreateResult>;
  disabled?: boolean;
  size?: "sm" | "default";
  /** 稳定锚点（两个宿主：快速创建条 / 完整表单）。 */
  testId: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [draft, setDraft] = useState<WorkItemProjectDraft>(workItemProjectEmptyDraft);
  const [formOpen, setFormOpen] = useState(false);
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** 表单里的名称输入框（打开内联表单即聚焦：这是一次「我要新建」的显式动作）。 */
  const nameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (formOpen) nameRef.current?.focus();
  }, [formOpen]);

  const display = workItemProjectPickerDisplay({ value, projects });
  const draftResult = parseWorkItemProjectDraft(draft);
  const canSubmit = draftResult.kind === "ok" && !submitting && !disabled;
  /* 就地字段提示（与提交后的失败共用同一格）：短码**填了但形状不对** ⇒ 立刻说（值原样带出，
     用户看得见自己打的是什么）；名称只有空白/空 ⇒ 只在提交后由失败原因说（一打开表单就一片红
     是噪音，且提交钮本来就置灰）。 */
  const shortCodeFailure =
    draft.shortCode.length > 0 && !workItemProjectShortCodeLooksValid(draft.shortCode)
      ? ({ kind: "invalid", field: "shortCode", value: draft.shortCode } as const)
      : null;
  const inlineFailure =
    failure !== null
      ? `${t(failure.messageId)}${failure.detail ? `：${failure.detail}` : ""}`
      : shortCodeFailure === null
        ? null
        : intl.formatMessage(
            { id: workItemProjectDraftErrorMessageId(shortCodeFailure) },
            { value: shortCodeFailure.value },
          );

  const submitNewProject = () => {
    if (onCreateProject === undefined || !canSubmit) return;
    const parsed = parseWorkItemProjectDraft(draft);
    if (parsed.kind !== "ok") return;
    setSubmitting(true);
    void (async () => {
      let result: WorkItemProjectCreateResult;
      try {
        result = await onCreateProject({ name: parsed.name, shortCode: parsed.shortCode });
      } catch (error) {
        // 接线层按契约不 reject；万一 reject 也不静默（翻成同一条可见原因）。
        result = { kind: "failed", feedback: squadEntryErrorFeedback(error) };
      }
      setSubmitting(false);
      if (result.kind === "failed") {
        setFailure(result.feedback);
        return;
      }
      /* 成功：选中**服务面读回的那条**，收起表单并清空草稿（下一次「新建」是全新的空白表单）。 */
      setFailure(null);
      setFormOpen(false);
      setDraft(workItemProjectEmptyDraft());
      onChange(result.project.id);
    })();
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={value}
        onValueChange={(next) => {
          if (next === WORK_ITEM_PROJECT_SELECT_NEW) {
            setFailure(null);
            setFormOpen(true);
            return;
          }
          setFormOpen(false);
          onChange(next);
        }}
      >
        <SelectTrigger
          size={size}
          disabled={disabled}
          aria-label={t("squad.workItems.project")}
          data-testid={testId}
        >
          <SelectValue>
            {display.kind === "none"
              ? t("squad.workItems.project.none")
              : display.kind === "project"
                ? display.name
                : /* 清单里查不到：回落显示 id（绝不显示成「无项目」—— 请求里仍然带着它） */
                  display.id}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {/* 「无项目」**置顶**（可清）：它是一个一等选项，不是"没选"。 */}
          <SelectItem value={WORK_ITEM_PROJECT_SELECT_NONE}>
            {t("squad.workItems.project.none")}
          </SelectItem>
          {(projects ?? []).map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
          {onCreateProject === undefined ? null : (
            <SelectItem value={WORK_ITEM_PROJECT_SELECT_NEW}>
              {t("squad.workItems.project.new")}
            </SelectItem>
          )}
        </SelectContent>
      </Select>
      {formOpen ? (
        /* 内联小表单（v1 的项目管理入口）：两枚必填 + 就地判据（短码形状单源在 shared）。
           它是**就地**的：失败保留输入并在同一处说原因；成功才收起并选中新项目。 */
        <span className="flex flex-wrap items-center gap-2" data-testid={`${testId}-new-form`}>
          <Input
            ref={nameRef}
            size="sm"
            className="w-32"
            disabled={disabled || submitting}
            aria-label={t("squad.common.name")}
            placeholder={t("squad.common.name")}
            data-testid={`${testId}-new-name`}
            value={draft.name}
            onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitNewProject();
              }
            }}
          />
          <Input
            size="sm"
            className="w-24"
            disabled={disabled || submitting}
            aria-label={t("squad.workItems.project.shortCode")}
            placeholder={t("squad.workItems.project.shortCodePlaceholder")}
            data-testid={`${testId}-new-short-code`}
            value={draft.shortCode}
            onChange={(event) =>
              setDraft((current) => ({ ...current, shortCode: event.target.value }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                submitNewProject();
              }
            }}
          />
          <Button
            size="sm"
            disabled={!canSubmit}
            data-testid={`${testId}-new-submit`}
            onClick={submitNewProject}
          >
            {submitting ? <Spinner className="size-3.5" /> : null}
            {t("squad.common.submit")}
          </Button>
          {inlineFailure === null ? null : (
            <p
              role="alert"
              className="w-full text-ui-sm text-destructive"
              data-testid={`${testId}-new-error`}
            >
              {inlineFailure}
            </p>
          )}
        </span>
      ) : null}
    </div>
  );
}
