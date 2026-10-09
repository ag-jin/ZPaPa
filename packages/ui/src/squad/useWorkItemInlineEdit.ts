import { useRef, useState, type KeyboardEvent } from "react";
import type { WorkItem, WorkItemPriorityKey } from "@zcode/shared";
import type { SquadEntryFeedback } from "./squadEntryViewModel.js";
import {
  resolveWorkItemInlinePriorityEdit,
  resolveWorkItemInlineTitleEdit,
  resolveWorkItemInlineTitleKeyIntent,
  workItemInlineEditUnchanged,
  type WorkItemInlineEditPatch,
} from "./workItemInlineEditViewModel.js";

/* 工作项**行内编辑**的交互状态（阶段一轮 D，T-P1-R4）：一份实现，看板行的 `renderRow` 消费它。

   为什么拆出来（不是为了好看，是硬约束）：`WorkItemsBoard.tsx` 已经 323 个代码行（上限 400，
   oxlint max-lines 跳过空行与注释）。行内编辑的状态 + 提交 + 键盘语义全塞进去必然越线，而
   越线之后只剩「加 eslint-disable」一条路 —— 那是把上限变成摆设。本仓对「状态 + 提交」这层
   本来就有独立文件的先例（`useWorkItemCollaboration.ts`），这里照它办。

   分层：**判据**（字段 → patch、失败文案、归档）在 `workItemInlineEditViewModel`（纯函数，可逐格测）；
   **交互状态**（草稿、在飞去重、Escape 取消意图、输入法组合态）在本文件；**呈现**（编辑器 JSX）
   仍在 `renderRow` 里一处。三层的坏法各不相同，混在一起就没法分别测。

   ⚠️ 三条纪律，都在这里落地（且各只有一处实现）：
   ① **无乐观更新**：写成功前不改任何显示值；成功由页面以服务回读刷新，这里只把草稿态收干净。
   ② **失败不吞、不清行**：失败时草稿/待写值**原样留着**（回退成旧值 = 用户以为改成功了）。
   ③ **一次编辑只提交一次**：Enter 与 blur 会先后落在同一次编辑上，在飞去重挡掉第二次。 */

/** 就地失败原因（行内是它**唯一**的归宿：不是一条 toast）。 */
export type WorkItemInlineEditFailure = {
  messageId: string;
  /** 失败文案里的 `{value}`（哪一个值不对）—— 原样带着，不替用户改写。 */
  value: string;
  /** 原始失败细节（仅未知失败带；照页面的拼法一并显示，不吞错）。 */
  detail?: string;
};

export type WorkItemInlineEditApi = {
  /** 正在编辑的标题草稿；`null` = 这一行不在标题编辑态。 */
  titleDraftOf: (item: WorkItem) => string | null;
  /** 优先级显示的**待写值**（失败也保留 ⇒ 界面不悄悄退回旧值）。 */
  priorityValueOf: (item: WorkItem) => WorkItemPriorityKey | null;
  failureOf: (item: WorkItem) => WorkItemInlineEditFailure | null;
  beginTitleEdit: (item: WorkItem) => void;
  changeTitleDraft: (draft: string) => void;
  cancelTitleEdit: () => void;
  commitTitleEdit: (item: WorkItem) => void;
  /** 标题输入的键盘语义：Enter 提交 / Escape 恢复 / 编辑态不冒泡 / 输入法组合不当作提交。 */
  handleTitleKeyDown: (item: WorkItem, event: KeyboardEvent<HTMLInputElement>) => void;
  /** 输入法组合态的两个接线（一起给，调用方一行展开：组合期间 Enter 是候选确认，不是提交）。 */
  titleCompositionHandlers: {
    onCompositionStart: () => void;
    onCompositionEnd: () => void;
  };
  /** 优先级 picker 选了一项（含哨兵值 = 清除）⇒ 归一化并提交。 */
  commitPriorityEdit: (item: WorkItem, selectValue: string) => void;
};

export function useWorkItemInlineEdit({
  onInlineEdit,
}: {
  /** 页面的**唯一写路径**（本层不 import 服务、不拼请求）；`null` = 写成功。 */
  onInlineEdit: (
    item: WorkItem,
    patch: WorkItemInlineEditPatch,
  ) => Promise<SquadEntryFeedback | null>;
}): WorkItemInlineEditApi {
  const [titleEdit, setTitleEdit] = useState<{ id: string; draft: string } | null>(null);
  const [priorityEdit, setPriorityEdit] = useState<{
    id: string;
    value: WorkItemPriorityKey | null;
  } | null>(null);
  const [failure, setFailure] = useState<({ id: string } & WorkItemInlineEditFailure) | null>(null);
  /* Escape 取消意图：关掉输入会让 blur 紧随其后 —— 没有这个标记，用户**明确放弃**的那次编辑
     会被 blur 当成一次提交写出去（Escape 的语义是恢复原值，不是「保存我按 Escape 时看到的东西」）。 */
  const cancelRef = useRef(false);
  /** 写请求在飞：忽略同一次编辑的重复提交（Enter 与 blur 先后到达）。 */
  const inFlightRef = useRef(false);
  /** 输入法组合态：中文输入法的 Enter 是候选确认，不是提交（照 TaskRenameDialog 的既有做法）。 */
  const composingRef = useRef(false);

  /** 一次行内写入的公共执行路径：在飞去重 → 交页面 → 成功收草稿 / 失败**就地**留原因（草稿不动）。 */
  const submit = (
    item: WorkItem,
    patch: WorkItemInlineEditPatch,
    value: string,
    clearDraft: () => void,
  ) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    void onInlineEdit(item, patch)
      .then((feedback) => {
        if (feedback === null) {
          clearDraft();
          setFailure(null);
          return;
        }
        setFailure({
          id: item.id,
          messageId: feedback.messageId,
          value,
          ...(feedback.detail === undefined ? {} : { detail: feedback.detail }),
        });
      })
      .finally(() => {
        inFlightRef.current = false;
      });
  };

  const commitTitleEdit = (item: WorkItem) => {
    if (cancelRef.current) {
      cancelRef.current = false;
      return;
    }
    if (titleEdit === null || titleEdit.id !== item.id) return;
    const resolution = resolveWorkItemInlineTitleEdit(titleEdit.draft);
    if (resolution.kind !== "ok") {
      setFailure({ id: item.id, messageId: resolution.messageId, value: resolution.value });
      return;
    }
    const patch = resolution.patch;
    if (!("title" in patch)) return;
    if (workItemInlineEditUnchanged(item, patch)) {
      setTitleEdit(null);
      return;
    }
    submit(item, patch, patch.title, () => setTitleEdit(null));
  };

  /** Escape ⇒ **恢复**：丢弃草稿、关掉编辑器、**不写**（唯一的取消路径）。 */
  const cancelTitleEdit = () => {
    cancelRef.current = true;
    setTitleEdit(null);
  };

  return {
    titleDraftOf: (item) =>
      titleEdit !== null && titleEdit.id === item.id ? titleEdit.draft : null,
    priorityValueOf: (item) =>
      priorityEdit !== null && priorityEdit.id === item.id
        ? priorityEdit.value
        : (item.priority ?? null),
    failureOf: (item) => (failure !== null && failure.id === item.id ? failure : null),
    beginTitleEdit: (item) => {
      cancelRef.current = false;
      setFailure(null);
      setTitleEdit({ id: item.id, draft: item.title });
    },
    changeTitleDraft: (draft) =>
      setTitleEdit((current) => (current === null ? null : { ...current, draft })),
    cancelTitleEdit,
    commitTitleEdit,
    handleTitleKeyDown: (item, event) => {
      /* 编辑态的键盘事件**不冒泡**：Enter / Escape 不该喂给行导航与全局快捷键
         （编辑时阻止行导航是原文语义；这里连键位都不外传）。 */
      event.stopPropagation();
      /* 键位 → 意图的判据在纯函数里（可逐格测）：组合期（输入法候选确认）一律 ignore、
         非组合期 Enter = 提交、Escape = 取消、其余键不吃。本层只执行结论 —— 判据不再
         散在事件回调里（那样没有测试设施能钉住它，见 workItemInlineEditViewModel 的函注）。 */
      const intent = resolveWorkItemInlineTitleKeyIntent({
        key: event.key,
        compositionActive: composingRef.current,
        isComposing: event.nativeEvent.isComposing,
      });
      if (intent === "ignore") return;
      event.preventDefault();
      if (intent === "commit") {
        commitTitleEdit(item);
        return;
      }
      cancelTitleEdit();
    },
    titleCompositionHandlers: {
      onCompositionStart: () => {
        composingRef.current = true;
      },
      onCompositionEnd: () => {
        composingRef.current = false;
      },
    },
    commitPriorityEdit: (item, selectValue) => {
      const resolution = resolveWorkItemInlinePriorityEdit(selectValue);
      if (resolution.kind !== "ok") {
        setFailure({ id: item.id, messageId: resolution.messageId, value: resolution.value });
        return;
      }
      const patch = resolution.patch;
      if (!("priority" in patch)) return;
      /* 先落**待写值**再写库：失败时界面保留用户选的那一档（不静默退回旧值）。
         注意这不是乐观更新 —— 写成功前它只表达「用户选了这一档、还没落库」。 */
      setPriorityEdit({ id: item.id, value: patch.priority });
      if (workItemInlineEditUnchanged(item, patch)) {
        setPriorityEdit(null);
        return;
      }
      submit(item, patch, patch.priority ?? "", () => setPriorityEdit(null));
    },
  };
}
