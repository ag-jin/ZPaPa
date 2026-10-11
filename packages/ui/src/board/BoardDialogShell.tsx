/**
 * 看板内弹窗壳（卡 #90 / A4-4 自卡片弹窗抽出，禁二份）：卡片弹窗与 epic 弹窗共用同一外壳——
 * 面板容器内 absolute overlay（`<div data-board-pane>` 是 relative 定位上下文，非 fixed 全局遮罩）、
 * 遮罩点击关闭、`role="dialog"` + `aria-modal="true"`、Tab 首尾回绕（边界判据在
 * `boardDialogTabIntent`，DOM 读写只在这里）。
 *
 * 为什么不用 radix `Dialog`：本面板的渲染缝是 SSR（`react-dom/server`，卡 #32/#33 建立），
 * portal 里的弹窗内容在该缝里不可见；弹窗正文恰是各卡的交付主体，必须可断言。
 * 关闭路径：× 与遮罩在壳内（点即关），Esc 由宿主消费纯函数 `boardCardDialogKeyIntent`
 * ——壳内不判第二遍键位（同 `WorkItemMobileSheet` 的既有纪律）。
 *
 * 壳与内容的分界：本模块只管**外壳**（定位/遮罩/语义/焦点回绕）与共用区块壳 `DialogSection`；
 * 身份锚点（`data-board-dialog` / `data-board-epic-dialog`）由调用方经 `identityProps` 落在对话框
 * 盒上——「同一时刻最多一个弹窗」的宿主状态与测试锚点因此各归其位。
 */
import type { KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";
import { boardDialogTabIntent } from "./boardDialogViewModel.js";

/** 弹窗内可聚焦元素（Tab 循环的读取面；判据在 `boardDialogTabIntent`，DOM 读写只在这里）。 */
function boardDialogFocusables(root: HTMLElement): HTMLElement[] {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(selector)];
}

interface BoardDialogShellProps {
  /** 弹窗可及名称（卡片 = 标题；epic = 登记行标题）。 */
  ariaLabel: string;
  /** 身份锚点（如 `{ "data-board-dialog": node.id }`）——落在对话框盒上。 */
  identityProps: Record<string, string>;
  /** 关闭（遮罩/宿主消费的 Esc；× 按钮由各弹窗头部自行渲染）。 */
  onClose: () => void;
  children: ReactNode;
}

export function BoardDialogShell({
  ariaLabel,
  identityProps,
  onClose,
  children,
}: BoardDialogShellProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  /**
   * Tab 循环 containment（#59 M4）：边界判据在纯函数 `boardDialogTabIntent`，这里只做
   * DOM 读取（可聚焦序列）与 focus。焦点恢复（关闭后回到打开者）在宿主（打开链路的触发元素
   * 在那里记录）；本组件不引入 portal/第三方，SSR 缝（renderToStaticMarkup）不变。
   */
  const handleTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const root = shellRef.current;
    if (!root) return;
    const focusables = boardDialogFocusables(root);
    const activeIndex = focusables.indexOf(document.activeElement as HTMLElement);
    const intent = boardDialogTabIntent({
      shiftKey: event.shiftKey,
      activeIndex,
      focusableCount: focusables.length,
    });
    if (intent === "none") return;
    event.preventDefault();
    const target =
      intent === "wrap-first" || intent === "enter-first"
        ? focusables[0]
        : focusables[focusables.length - 1];
    target?.focus();
  };
  return (
    <div
      data-board-dialog-root=""
      className="absolute inset-0 z-50 flex items-start justify-center overflow-y-auto p-4"
    >
      {/* 遮罩：鼠标/触摸的关闭路径（键盘一路是 Esc，判据在宿主的纯函数里）。 */}
      <div
        data-board-dialog-scrim=""
        aria-hidden="true"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        ref={shellRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        {...identityProps}
        onKeyDown={handleTabKeyDown}
        className="relative my-auto flex max-h-[85vh] w-full max-w-[26rem] flex-col overflow-hidden rounded-2xl border border-popover-border bg-popover text-ui-base/relaxed text-foreground shadow-md"
      >
        {children}
      </div>
    </div>
  );
}

/** 区块壳：标题 + 内容，`data-board-dialog-section` 是呈现锚点（不含判据；两弹窗共用）。 */
export function DialogSection({
  name,
  title,
  className,
  children,
}: {
  name: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      data-board-dialog-section={name}
      className={className ?? "flex flex-col gap-1 border-t border-border/50 px-3 py-2"}
    >
      <h3 className="text-ui-xs font-medium text-foreground-subtle">{title}</h3>
      {children}
    </section>
  );
}
