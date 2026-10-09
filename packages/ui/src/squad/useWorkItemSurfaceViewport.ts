import { useEffect, useState } from "react";
import {
  WORK_ITEM_COMPACT_MEDIA_QUERY,
  workItemSurfaceViewport,
  type WorkItemSurfaceViewport,
} from "./workItemResponsiveViewModel.js";

/* 视口形态的**浏览器侧读取**（阶段三 · T-P3-R4）：判据全在 `workItemResponsiveViewModel`（纯函数），
   本文件只负责「去问浏览器」，与 `workItemPeekViewModel` / `RollingToolbarLabel` 同一分工。

   三条纪律：
   ① **SSR 传桌面默认**：无 window / 无 matchMedia ⇒ 判不出来（`null`）⇒ 纯函数给桌面 ——
      桌面这套是既有默认路径（分栏 + 行内），兜底不能把它换掉。
   ② **可注入**：`override` 直接短路浏览器这一路（测试/嵌入方唯一注入点）—— 本仓没有无头 DOM，
      两档形态都要测得到，就得有一个不进浏览器的入口。
   ③ **跟随变化**：订阅同一枚媒体查询的 `change`，卸载时摘掉（不留孤儿监听；本仓既有形态：
      `RollingToolbarLabel` / `useTheme`）。查询**只在这里问一次**（初始读与订阅共用同一枚查询
      常量，另抄一份查询字符串就是两处可以漂移的断点）。 */

/** 窄屏查询的浏览器句柄：判不出来（SSR / 无 matchMedia）⇒ `null`（由纯函数兜底成桌面）。 */
function resolveCompactQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(WORK_ITEM_COMPACT_MEDIA_QUERY);
}

export function useWorkItemSurfaceViewport(
  override?: WorkItemSurfaceViewport,
): WorkItemSurfaceViewport {
  const [compactMatch, setCompactMatch] = useState<boolean | null>(
    () => resolveCompactQuery()?.matches ?? null,
  );
  useEffect(() => {
    /* 注入覆盖时不订阅（形态由覆盖决定；订阅只会在覆盖之下白白重建监听）。 */
    if (override !== undefined) return;
    const query = resolveCompactQuery();
    if (query === null) return;
    const update = () => setCompactMatch(query.matches);
    /* 进来先对齐一次：初始态可能在「渲染 → effect」之间过期（首帧读与订阅之间窗口变了）。 */
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [override]);
  return override ?? workItemSurfaceViewport(compactMatch);
}
