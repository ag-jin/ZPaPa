import type { DeliverableKind, WorkItemDeliverableRecord } from "@zcode/services";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";

/* #7 D1b：详情页**交付物区**的纯逻辑（设计 §3.4 呈现半边）。

   为什么这三件必须留在纯函数里（ui 包没有渲染测试设施，组件里算 = 不可测）：
   ① kind 的双语文案映射 —— `Record<DeliverableKind, string>` 的穷尽性让「服务面加一型而界面漏一型」
      直接编译失败，而不是界面上少一枚徽标（同 Activity kind 映射的既有手法）；
   ② 行的事实读取 —— `meta` 是 JSON（形状随产生点而变），缺字段必须**读成 null 而不是猜一个默认值**：
      把「没记提交数」显示成「0 个提交」就是造事实；
   ③ 手动登记表单的**可提交判据** —— 空标题/空 URL/非 http(s) 各自有定位文案，提交按钮按它禁用。

   本文件不 import React（照本域既定做法）；尺寸格式化经 `formatBytes`（J2：组件内不做数字格式化）。 */

const PREFIX = "squad.workItemDetail.deliverables";

/** v1 两型的可见徽标文案（闭集穷尽映射：新开一型 ⇒ 这里编译失败）。 */
export const DELIVERABLE_KIND_MESSAGE_IDS: Record<DeliverableKind, string> = {
  diff: `${PREFIX}.kind.diff`,
  link: `${PREFIX}.kind.link`,
};

/** 一行的**事实**（缺字段即 null，不猜）。 */
export type DeliverableFacts = {
  /** diff：产出所在的分支（`meta.branch`；批级行没有它）。 */
  branch: string | null;
  /** diff：范围里的提交数（`meta.commitCount`；非负整数才算）。 */
  commits: number | null;
  /** 正文大小（已格式化；link 无本地正文 ⇒ null）。 */
  size: string | null;
  /** diff：git `--stat` 原文（原样显示，不解析、不重排）。 */
  statSummary: string | null;
  /** link：外部 URL（`contentRef`）；diff 恒 null。 */
  url: string | null;
};

export function deliverableFacts(record: WorkItemDeliverableRecord): DeliverableFacts {
  const branch = record.meta.branch;
  const commits = record.meta.commitCount;
  const statSummary = record.meta.statSummary;
  return {
    branch: typeof branch === "string" && branch.trim() !== "" ? branch : null,
    commits:
      typeof commits === "number" && Number.isInteger(commits) && commits >= 0 ? commits : null,
    size: record.contentSize === null ? null : formatBytes(record.contentSize),
    statSummary: typeof statSummary === "string" && statSummary.trim() !== "" ? statSummary : null,
    url: record.kind === "link" ? record.contentRef : null,
  };
}

/** 手动登记表单的草稿（UI 只给这两格；`note` 属服务面可选，v1 界面不收集）。 */
export type DeliverableLinkDraft = { title: string; url: string };

export const EMPTY_DELIVERABLE_LINK_DRAFT: DeliverableLinkDraft = { title: "", url: "" };

/**
 * 可提交判据：返回**首个**问题的文案键（`null` = 可提交）。组件不自己内联这些判断，
 * 故「按钮禁用」与「提示哪一格不对」永远是同一份判据。
 */
export function deliverableLinkDraftProblemId(draft: DeliverableLinkDraft): string | null {
  if (draft.title.trim() === "") return `${PREFIX}.form.titleRequired`;
  const url = draft.url.trim();
  if (url === "") return `${PREFIX}.form.urlRequired`;
  // 外链形态闸（服务面/存储面只挡空白）：非 http(s) 的「链接」在界面上就是一个点不动的死字。
  if (!/^https?:\/\//i.test(url)) return `${PREFIX}.form.urlInvalid`;
  return null;
}
