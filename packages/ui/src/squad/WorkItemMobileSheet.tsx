import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/* **底部抽屉壳**（阶段三 · T-P3-R4）：窄屏下承载 peek 与快速创建的 Sheet（底部面板 + 遮罩）。

   为什么要一个共用壳（而不是两面各写一份）：壳只负责三件事 —— ①贴底、铺满视口的定位面；
   ②点遮罩关闭（鼠标/触摸那一路）；③**有标题**时的头部（标题 + 关闭钮，role=dialog + aria-modal）。
   两条纪律：
   · **无标题 ⇒ 不画头部、壳体也不承担语义**：peek 抽屉走这一支 —— 它的可及名称与关闭钮在
     peek 面板自身（保持 T-P3-R2 的「非模态速览」口径，壳体不再造第二枚关闭钮与重复标题）。
   · **Esc 不在这里判**：键位判据在宿主的键盘层（`workItemCompactSheetKeyIntent`，纯函数一处判定）
     —— 壳内再判一次就是两份键位判据，迟早对不上（与 peek 的既有做法同款）。
   配色全部走语义 token（bg-card / border-card-border / text-foreground-subtlest；遮罩沿用对话框
   那一枚 bg-black/60）⇒ Zai Light/Dark 两主题自动跟随，本模块不出现具体色值。 */

export function WorkItemMobileSheet({
  title,
  onClose,
  children,
}: {
  /** 头部标题（同时是可及名称）：**有标题才有头部**；peek 抽屉不传（见文件头纪律一）。 */
  title?: string;
  /** 关闭（遮罩按下 / 头部关闭钮 / 宿主键盘层）—— 壳不自己持有打开态。 */
  onClose: () => void;
  /** 抽屉内容：peek 面板或快速创建条（本层不解释内容）。 */
  children: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const dialogProps =
    title === undefined
      ? {}
      : ({ role: "dialog", "aria-modal": true, "aria-label": title } as const);
  return (
    <div
      data-testid="work-item-mobile-sheet"
      className="fixed inset-0 z-50 flex flex-col justify-end"
    >
      {/* 遮罩：鼠标/触摸的关闭路径（键盘一路是 Esc，判据在宿主）。aria-hidden —— 它是纯装饰，
          语义化的关闭钮在头部（无标题的 peek 抽屉则在 peek 面板上）。 */}
      <div
        data-testid="work-item-mobile-sheet-scrim"
        aria-hidden="true"
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />
      <div
        {...dialogProps}
        data-testid="work-item-mobile-sheet-panel"
        className="relative max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-card-border bg-card px-4 pt-3 pb-6 text-ui-base/relaxed text-foreground shadow-md"
      >
        {title === undefined ? null : (
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-ui-xs text-foreground-subtlest">{title}</span>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              data-testid="work-item-mobile-sheet-close"
              aria-label={t("squad.workItems.sheet.close")}
              onClick={onClose}
            >
              <X aria-hidden className="size-3.5" />
            </Button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
