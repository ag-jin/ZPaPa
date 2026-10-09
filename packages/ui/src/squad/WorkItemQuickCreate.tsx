import { useEffect, useRef, useState } from "react";
import type { WorkItem } from "@zcode/shared";
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
import { resolveWorkItemInlineTitleKeyIntent } from "./workItemInlineEditViewModel.js";
import {
  WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE,
  workItemQuickCreateDraftAfterSubmit,
  workItemQuickCreateEmptyDraft,
  workItemQuickCreateParentDisplay,
  workItemQuickCreateRequest,
  workItemQuickCreateSubmittable,
  type WorkItemQuickCreateDraft,
} from "./workItemQuickCreateViewModel.js";

/* 「快速创建」条（阶段三 · T-P3-R1）：**视图顶部**「输入标题即建」，必填仅标题，其余默认。

   为什么不放在行内（而是宿主/视图顶部）：① 行模块有 400 行硬线与「孩子槽位是行为的一部分」
   的结构纪律（多一个槽位就让默认路径的 `useId` 漂移，逐字节基线当场红）；② 「在某个批根下建」
   用**父项下拉**表达（选中批根 ⇒ 新项成为它的子项 = 批成员），与行内入口相比少一处行级状态。

   五条纪律（每条都有结构守卫，见 `workItemQuickCreate.test.ts`）：
   1. **唯一写路径**：本组件不 import 服务、不取 accessor、不拼请求 —— 只把
      `workItemQuickCreateRequest` 的结论交给注入的 `onSubmit`（接线层走 `createWorkItem` 单源）。
      没有注入就没有这个入口（宿主控制），"点得动但写不下去"在接线层面凑不出来。
   2. **无乐观插入 / 无本地临时行**：成功之后**只**清标题（`workItemQuickCreateDraftAfterSubmit`），
      新行必须来自服务回读（宿主 `reload()` → 快照 → 页面投影）；草稿类型里根本没有可塞行的位置。
   3. **失败就地原因 + 保留输入**：`onSubmit` 返回 `SquadEntryFeedback | null`（`null` = 成功），
      失败把 `messageId` 与原始 `detail` 都显示在条内（照 `WorkItemsPageStatus` 的既有形态），
      草稿原样保留（用户不用重打）。
   4. **可点性**：`createEnabled` 由宿主经 `workItemCreateEnabled`（本域既有判据）传入；
      提交判据只有 `workItemQuickCreateSubmittable` 一处（标题非空白 + 写面可用 + 无写动作在飞）。
   5. **键盘**：Enter = 提交、Escape = 清草稿、**IME 组合期一律忽略**（中文输入法的 Enter 是
      候选确认）—— 复用行内编辑标题输入的那枚纯判据 `resolveWorkItemInlineTitleKeyIntent`，
      本组件不写第二份 `isComposing` 链。不用 `<form>` 的浏览器原生提交：那条路径不经过组合闸。

   状态所有权：草稿 / 就地失败 / "本组件提交中" 都是**本组件的会话内状态**（不入库、不进 store）；
   工作项列表与"别的写动作在飞"由宿主投影（`workItems` / `busy`），本组件不持有任何"服务事实"。 */

/** 「不选父项」的 UI 取值（哨兵，见 `workItemQuickCreateViewModel`）—— 请求里是 `undefined`。 */
const NO_PARENT_VALUE = WORK_ITEM_QUICK_CREATE_NO_PARENT_VALUE;

export function WorkItemQuickCreate({
  workItems,
  createEnabled,
  busy,
  onSubmit,
  focusToken,
}: {
  /** 父项候选 = 快照的全量工作项（**不按 depth / 子项数预筛**：拒绝与否是服务面的判据，
      任何本地预筛都会把"服务面本来接受的父项"静默藏掉）。顺序即快照顺序（本层不重排）。 */
  workItems: WorkItem[];
  /** 写面可用吗（宿主经 `workItemCreateEnabled` 算好传入）：false ⇒ 整条置灰（入口常驻不消失）。 */
  createEnabled: boolean;
  /** 有别的写动作在飞（页面的 `busyWorkItemId`）：true ⇒ 不给第二次提交（一次写一条）。 */
  busy: boolean;
  /** 唯一写路径（接线层注入）：**返回失败原因（null = 成功），按契约不 reject**。
      成功返回 null 之后由接线层负责回读（本组件不去请求刷新、也不改列表）。 */
  onSubmit: (
    request: ReturnType<typeof workItemQuickCreateRequest>,
  ) => Promise<SquadEntryFeedback | null>;
  /** 聚光令牌（列头 `+` 的落点）：每次**递增**都把光标送进标题框 —— 列头新建入口落在
      这条既有入口上，不新开第二条写路径（值不变 ⇒ 不重复聚焦；`0` = 从未请求过）。 */
  focusToken?: number;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const [draft, setDraft] = useState<WorkItemQuickCreateDraft>(workItemQuickCreateEmptyDraft);
  /** 最近一次提交的失败（成功 ⇒ `null`）：就地显示，不做 toast（条本身就是它的归宿）。 */
  const [failure, setFailure] = useState<SquadEntryFeedback | null>(null);
  /** 本组件自己的"提交中"：`onSubmit` 的 promise 在飞期间重复点会建出两条（父级 busy 反映到
      DOM 有一拍延迟），所以这一格在这里也判一次。 */
  const [submitting, setSubmitting] = useState(false);
  /** 输入法组合态（Enter 是候选确认，不是提交；判据在纯函数里，见文件头第 5 条）。 */
  const composingRef = useRef(false);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const blocked = !createEnabled || busy || submitting;
  const canSubmit = workItemQuickCreateSubmittable({
    title: draft.title,
    createEnabled,
    busy: busy || submitting,
  });
  /* 触发器上那行字由纯判据给出（`none` / 命中标题 / 仅在快照缺席时回落 id）——Radix 的
     `SelectValue` 在"选中项从未打开过"时不渲染任何文本（它靠 item 挂载时回填），显式给
     children 才能让"当前挂着哪个父项"在首屏就说得出来。 */
  const parentDisplay = workItemQuickCreateParentDisplay(workItems, draft.parentValue);

  /* 列头 `+`（形态重排轮）：令牌一变就把光标送进标题框 —— 入口只有一个（本组件），
     所以「+ 新建」与「在这里敲标题」是同一件事的两步，不存在第二条创建路径。
     记下**已消费的令牌**而不是「布尔开关」：`busy`/`submitting` 变化不会重跑这一支
     （否则别的写动作结束时会把光标从用户手上抢走）。置灰时 `focus()` 是 no-op（不抢焦点）。 */
  const focusedTokenRef = useRef(0);
  useEffect(() => {
    if (focusToken === undefined || focusToken === focusedTokenRef.current) return;
    focusedTokenRef.current = focusToken;
    titleRef.current?.focus();
  }, [focusToken]);

  /** 提交：唯一判据 → 唯一请求构造 → 唯一写入口；结论只演进草稿与就地失败（不碰任何列表）。 */
  const submit = () => {
    if (
      !workItemQuickCreateSubmittable({
        title: draft.title,
        createEnabled,
        busy: busy || submitting,
      })
    ) {
      return;
    }
    setSubmitting(true);
    void (async () => {
      let feedback: SquadEntryFeedback | null;
      try {
        feedback = await onSubmit(workItemQuickCreateRequest(draft));
      } catch (error) {
        /* 接线层按契约不 reject；万一 reject 也不静默 —— 翻成同一条可见提示（归类仍是那一枚判据）。 */
        feedback = squadEntryErrorFeedback(error);
      }
      setSubmitting(false);
      setFailure(feedback);
      setDraft((current) => workItemQuickCreateDraftAfterSubmit({ draft: current, feedback }));
      // 成功（已清标题）把光标留在输入框：接着敲下一条即连续创建，不用再点一次。
      if (feedback === null) titleRef.current?.focus();
    })();
  };

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      data-testid="work-items-quick-create"
      aria-busy={submitting}
    >
      <Input
        ref={titleRef}
        type="text"
        size="sm"
        className="w-56 text-mobile-input-safe md:text-ui-base/relaxed"
        disabled={blocked}
        aria-label={t("squad.common.title")}
        placeholder={t("squad.workItems.quickCreate.placeholder")}
        data-testid="work-items-quick-create-title"
        value={draft.title}
        onChange={(event) => {
          const title = event.target.value;
          setDraft((current) => ({ ...current, title }));
        }}
        onCompositionStart={() => {
          composingRef.current = true;
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
        }}
        onKeyDown={(event) => {
          const intent = resolveWorkItemInlineTitleKeyIntent({
            key: event.key,
            compositionActive: composingRef.current,
            isComposing: event.nativeEvent.isComposing,
          });
          if (intent === "ignore") return;
          event.preventDefault();
          if (intent === "commit") {
            submit();
            return;
          }
          /* Escape = 清掉这条草稿（不写任何东西）：与搜索框的 Esc 同一语义（还没提交的东西取消掉），
             顺带把上一次的失败原因也收起来 —— 它说的是那条已不存在的输入。 */
          setDraft((current) => ({ ...current, title: "" }));
          setFailure(null);
        }}
      />
      {/* 父项：默认「无（顶层）」；选中某个批根 ⇒ 新项成为该批的子项（批成员）。
          候选不做任何深度/数量预筛（服务面拒绝什么，原样显示什么，见 props 注释）。 */}
      <Select
        value={draft.parentValue}
        onValueChange={(value) => {
          setDraft((current) => ({ ...current, parentValue: value }));
        }}
      >
        <SelectTrigger
          size="sm"
          disabled={blocked}
          aria-label={t("squad.common.parent")}
          data-testid="work-items-quick-create-parent"
        >
          <SelectValue>
            {parentDisplay.kind === "none"
              ? t("squad.common.parent.none")
              : parentDisplay.kind === "item"
                ? parentDisplay.title
                : /* 父项已不在快照：回落显示 id（绝不显示成「无」—— 请求里仍然带着它） */
                  parentDisplay.id}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_PARENT_VALUE}>{t("squad.common.parent.none")}</SelectItem>
          {workItems.map((item) => (
            <SelectItem key={item.id} value={item.id}>
              {item.title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        disabled={!canSubmit}
        data-testid="work-items-quick-create-submit"
        onClick={submit}
      >
        {submitting ? <Spinner className="size-3.5" /> : null}
        {t("squad.common.submit")}
      </Button>
      {failure ? (
        /* 就地原因：文案键 + 原始细节都显示（不吞错）—— 与 WorkItemsPageStatus / InboxPage 同一形态。 */
        <p
          role="alert"
          className="w-full text-ui-sm text-destructive"
          data-testid="work-items-quick-create-error"
        >
          {t(failure.messageId)}
          {failure.detail ? `：${failure.detail}` : ""}
        </p>
      ) : null}
    </div>
  );
}
