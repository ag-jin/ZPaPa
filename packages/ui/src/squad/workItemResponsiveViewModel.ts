/* 工作项 Surface 的**响应式判据**（阶段三 · T-P3-R4）：窄屏把快速创建交给底部抽屉
   （`WorkItemMobileSheet`），桌面保持行内。

   为什么独立成模块：与 `workItemPeekViewModel` 同款 —— 判据纯函数化才可测（ui 包没有交互测试
   设施，本仓既有做法：判据纯函数 + 组件只画）。本文件不 import React、不碰 window：
   **命中结果从参数来**，组件层负责去问浏览器（见 `useWorkItemSurfaceViewport`）。

   2026-10-09 口径变更（用户裁定「点击进详情页，预览先下线」）：窄屏抽屉目标里**不再有 peek** ——
   peek 的打开态从宿主整体摘除，抽屉只剩快速创建这一个来源（判据里留一个永远为 false 的
   `peekOpen` 参数 = 一条到不了的分支，故随下线一起删）。键位判据仍复用 peek 那一枚纯函数
   （`workItemPeekKeyIntent` 随组件保留，见 `WorkItemPeek.tsx`）。

   两条纪律：
   ① **同源断点**：窄屏分界与 Tailwind `md:` 是同一枚（768px）—— 本仓既有移动输入
      `text-mobile-input-safe md:text-ui-base` 用的就是它。另造一枚分界会让「输入已走移动档、
      布局却还是桌面档」这类错位静默发生（界面上没有任何错误可看）。
   ② **SSR 传桌面默认**：判不出宽度（无 window / 无 matchMedia / SSR）⇒ 按**桌面** —— 桌面这套
      是既有的默认路径，兜底不能把它换掉（三份逐字节基线因此保持真空）。 */

import { workItemPeekKeyIntent } from "./workItemPeekViewModel.js";

/** 窄屏媒体查询：与 Tailwind `md:`（≥768 = 桌面）互补的另一半。 */
export const WORK_ITEM_COMPACT_MEDIA_QUERY = "(max-width: 767px)";

/** 视口形态：`compact` = 窄屏（Sheet/底部抽屉）；`desktop` = ≥768（分栏/行内）。 */
export type WorkItemSurfaceViewport = "desktop" | "compact";

/** 媒体查询命中结果 → 视口形态。`null` = 判不出来（SSR / 无 matchMedia）⇒ **桌面默认**。 */
export function workItemSurfaceViewport(narrowMatch: boolean | null): WorkItemSurfaceViewport {
  return narrowMatch === true ? "compact" : "desktop";
}

/** 窄屏抽屉目标（**至多一个**）：peek 下线后只剩快速创建一个来源。 */
export function workItemCompactSheetTarget(input: {
  quickCreateOpen: boolean;
}): "quickCreate" | "none" {
  return input.quickCreateOpen ? "quickCreate" : "none";
}

/**
 * Esc 关的是哪一个抽屉（验收 ③「关闭路径至少一条可验证」的判据侧）：键位判据**复用 peek 那一枚**
 * （`workItemPeekKeyIntent`：`Escape` ⇒ close，其余键一律 none），本函数只回答「关谁」——
 * 不另写一份 `key === "Esc"` 的链（两份键位判据迟早对不上）。
 */
export function workItemCompactSheetKeyIntent(input: {
  key: string;
  quickCreateOpen: boolean;
}): "quickCreate" | "none" {
  if (workItemPeekKeyIntent(input.key) !== "close") return "none";
  return workItemCompactSheetTarget(input);
}
