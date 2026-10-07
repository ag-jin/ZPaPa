import { useCallback, useMemo, useState } from "react";
import {
  WORK_ITEM_DECISION_KINDS,
  type CreateWorkItemDecisionRequest,
  type WorkItemDecisionKind,
  type WorkItemDecisionRecord,
} from "@zcode/services";
import { Scale } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Field } from "./squadDialogParts.js";
import { resolveSubmitId } from "./workItemCollaborationViewModel.js";
import {
  DECISION_KIND_MESSAGE_IDS,
  canSubmitDecision,
  decisionKindMessageId,
  decisionNeedsParent,
  decisionParentCandidates,
  decisionSubmitParentId,
  newDecisionRequestId,
  type DecisionFormState,
} from "./workItemDecisionViewModel.js";

/* C3.2：详情页协作区标题行的「记录决定」入口 + 决定表单对话框（任务卡 §5.1/§5.2-2/§5.2-3）。

   为什么入口与对话框同住一个模块：入口那颗按钮、它的禁用原因、对话框的开关是**同一件事**
   （一次写入意图的开合）。拆成两个文件只会让「谁能打开对话框」多一条缝。组件整体仍与
   `ReassignWorkItemDialog` 同款纪律：**自己不执行任何服务调用** —— 提交把选定的整套入参交回
   页面（`WorkItemDetailPage` 的 `runCollaborationAction` 是唯一执行器），组件只拿回调。

   五键 kind 的选择项来自服务面闭集 `WORK_ITEM_DECISION_KINDS` 本身（不手抄第二份清单），
   文案经 `DECISION_KIND_MESSAGE_IDS`（闭集穷尽映射；闭集外的值由访问器响亮抛）。

   幂等键（§8.1）：`sourceRequestId` 在一次**提交动作**内稳定，失败重试沿用同一把键
   （`resolveSubmitId` 是受测纯函数），成功后换新。失败**不丢草稿**：用户在表单里看到的是
   「未记录 + 重试」，重试沿用同一把键 ⇒ 一次成功只落一条决定。

   归档项：入口**存在但禁用**并给出原因（`writeDisabledReason` 的返回值），不静默消失
   —— 消失会让「为什么不能记录」变成一个只能靠猜的问题。 */

/** 提交入参 = 门面请求去掉 `workItemId`（页面用读面带回的工作项补上；UI 不自己造 id）。 */
export type DecisionSubmitInput = Omit<CreateWorkItemDecisionRequest, "workItemId">;

/** 提交禁用理由的帮助文案锚点（`aria-describedby` 指向它，不靠悬停才看得到）。 */
const SUBMIT_REASON_ID = "work-item-decision-submit-reason";
/** 入口禁用原因的锚点（同上：禁用必须说清为什么）。 */
const ENTRY_REASON_ID = "work-item-decision-record-reason";

export function WorkItemDecisionRecorder({
  decisions,
  disabledReasonMessageId,
  onSubmit,
}: {
  /** 既有决定（`state.read.decisions`，零新读调用）：父选择的候选来源。 */
  decisions: WorkItemDecisionRecord[];
  /** 不可写的原因文案键（归档 / 读取失败，来自 `writeDisabledReason`）；`null` = 可写。 */
  disabledReasonMessageId: string | null;
  /** 提交：由页面执行（写 + 只刷新协作读模型）。**拒绝** = 未写入（表单据此保留草稿与键）。 */
  onSubmit: (input: DecisionSubmitInput) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="outline"
        className="ml-auto"
        disabled={disabledReasonMessageId !== null}
        aria-describedby={disabledReasonMessageId === null ? undefined : ENTRY_REASON_ID}
        data-testid="work-item-decision-record"
        onClick={() => setOpen(true)}
      >
        <Scale aria-hidden className="size-3.5" />
        {intl.formatMessage({ id: "squad.workItemDetail.decision.record" })}
      </Button>
      {disabledReasonMessageId === null ? null : (
        <p
          id={ENTRY_REASON_ID}
          data-testid="work-item-decision-record-reason"
          className="text-ui-xs text-foreground-subtlest"
        >
          {intl.formatMessage({ id: disabledReasonMessageId })}
        </p>
      )}
      {open ? (
        <WorkItemDecisionDialog
          decisions={decisions}
          disabledReasonMessageId={disabledReasonMessageId}
          onClose={() => setOpen(false)}
          onSubmit={onSubmit}
        />
      ) : null}
    </>
  );
}

export function WorkItemDecisionDialog({
  decisions,
  disabledReasonMessageId,
  onClose,
  onSubmit,
}: {
  decisions: WorkItemDecisionRecord[];
  disabledReasonMessageId: string | null;
  onClose: () => void;
  onSubmit: (input: DecisionSubmitInput) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const [kind, setKind] = useState<WorkItemDecisionKind>("proposal");
  const [subject, setSubject] = useState("");
  const [rationale, setRationale] = useState("");
  const [parentDecisionId, setParentDecisionId] = useState<string | null>(null);
  const [sourceRequestId, setSourceRequestId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const form: DecisionFormState = { kind, subject, parentDecisionId };
  /* 父候选：纯函数过滤（reopened 不许选 proposal —— 那是服务面必然拒的死格），顺序原样。 */
  const candidates = useMemo(() => decisionParentCandidates(kind, decisions), [kind, decisions]);
  const needsParent = decisionNeedsParent(kind);
  const submitReady = canSubmitDecision(form);
  const canSubmit = !sending && disabledReasonMessageId === null && submitReady;
  /* 禁用理由优先级：写面不可用（归档 / 读取失败）> 没填事项 > 必填父未选。三格都必须**说出来**。 */
  const reasonMessageId =
    disabledReasonMessageId ??
    (submitReady
      ? null
      : subject.trim() === ""
        ? "squad.workItemDetail.decision.subjectRequired"
        : "squad.workItemDetail.decision.parentRequired");

  /** 提交（含重试）：同一函数同时承担首次与重试，重试沿用**同一把** `sourceRequestId`。 */
  const submit = useCallback(async () => {
    if (!canSubmit) return;
    const requestId = resolveSubmitId(sourceRequestId, "send", newDecisionRequestId);
    /* 父只带「必填 kind 且用户选过」的那个：切过 kind 的残留选择不得混进审计事实。 */
    const parentForSubmit = decisionSubmitParentId(kind, parentDecisionId);
    setSourceRequestId(requestId);
    setSending(true);
    setFailed(false);
    try {
      await onSubmit({
        kind,
        subject,
        ...(rationale.trim() === "" ? {} : { rationale }),
        ...(parentForSubmit === null ? {} : { parentDecisionId: parentForSubmit }),
        sourceRequestId: requestId!,
      });
      // 成功：换新键、清草稿、收起对话框（那条决定已经在时间线上，页面无需刷新）。
      setSourceRequestId(resolveSubmitId(requestId, "sent", newDecisionRequestId));
      setSubject("");
      setRationale("");
      setParentDecisionId(null);
      onClose();
    } catch {
      // 失败：草稿与幂等键**都留着**（重试必须沿用同一个键，否则库里长成两条决定）。
      setSourceRequestId(resolveSubmitId(requestId, "failed", newDecisionRequestId));
      setFailed(true);
    } finally {
      setSending(false);
    }
  }, [canSubmit, kind, subject, rationale, parentDecisionId, sourceRequestId, onSubmit, onClose]);

  return (
    <Dialog open onOpenChange={(next) => (next || sending ? undefined : onClose())}>
      <DialogContent data-testid="work-item-decision-dialog">
        <DialogHeader>
          <DialogTitle>{t("squad.workItemDetail.decision.dialogTitle")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field labelId="squad.workItemDetail.decision.field.kind">
            {(controlId) => (
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as WorkItemDecisionKind)}
              >
                <SelectTrigger id={controlId} data-testid="work-item-decision-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WORK_ITEM_DECISION_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {t(DECISION_KIND_MESSAGE_IDS[option])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>
          <Field labelId="squad.workItemDetail.decision.field.subject">
            {(controlId) => (
              <Input
                id={controlId}
                data-testid="work-item-decision-subject"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            )}
          </Field>
          {/* 父选择**仅在必填 kind 下渲染**（判据来自纯函数 decisionNeedsParent）。 */}
          {needsParent ? (
            <Field labelId="squad.workItemDetail.decision.field.parent">
              {(controlId) => (
                <Select
                  value={parentDecisionId ?? undefined}
                  onValueChange={(value) => setParentDecisionId(value)}
                >
                  <SelectTrigger id={controlId} data-testid="work-item-decision-parent">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((candidate) => (
                      <SelectItem key={candidate.id} value={candidate.id}>
                        {`${t(decisionKindMessageId(candidate.kind))} · ${candidate.subject}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </Field>
          ) : null}
          {needsParent && candidates.length === 0 ? (
            <p
              data-testid="work-item-decision-parent-empty"
              className="text-ui-xs text-foreground-subtlest"
            >
              {t("squad.workItemDetail.decision.parentEmpty")}
            </p>
          ) : null}
          <Field labelId="squad.workItemDetail.decision.field.rationale">
            {(controlId) => (
              <Textarea
                id={controlId}
                data-testid="work-item-decision-rationale"
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
              {t("squad.common.cancel")}
            </Button>
            <Button
              size="sm"
              className="ml-auto"
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              aria-describedby={SUBMIT_REASON_ID}
              data-testid="work-item-decision-submit"
              onClick={() => void submit()}
            >
              {sending
                ? t("squad.workItemDetail.decision.sending")
                : t("squad.workItemDetail.decision.submit")}
            </Button>
          </div>
          <p id={SUBMIT_REASON_ID} className="text-ui-xs text-foreground-subtlest">
            {reasonMessageId === null ? "" : t(reasonMessageId)}
          </p>
          {failed ? (
            <Alert variant="destructive" data-testid="work-item-decision-failure">
              <AlertDescription className="flex flex-wrap items-center gap-2 text-ui-xs">
                {t("squad.workItemDetail.decision.failed")}
                {/* 重试：同一把幂等键、同一份草稿 —— 一次成功只落一条决定。 */}
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canSubmit}
                  onClick={() => void submit()}
                >
                  {t("squad.workItemDetail.decision.retry")}
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
