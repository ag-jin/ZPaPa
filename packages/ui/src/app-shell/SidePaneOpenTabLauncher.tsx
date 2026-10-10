import type { CSSProperties, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { OpenTabLauncherItemId } from "@/app-shell/animatedSidePanePanelModel.js";

/* 「打开标签页」空态入口列表（从 AnimatedSidePanePanel 原样抽出，卡 #58）。

   抽出原因：面板宿主依赖整条重组件链（含图片资源），node 测试进程无法 import；
   而「入口在不在」是实验开关（默认关）最需要真渲染守卫的一格。抽出的组件只吃
   已经算好的 items —— 条目裁剪仍只在 resolveOpenTabLauncherItemIds 一处。 */

export interface OpenTabLauncherItem {
  id: OpenTabLauncherItemId;
  label: string;
  icon: LucideIcon;
  onOpen: () => void;
}

export function SidePaneOpenTabLauncher({
  items,
  isDesktop = false,
  captionControlsStyle,
  headerControls,
}: {
  items: OpenTabLauncherItem[];
  isDesktop?: boolean;
  captionControlsStyle?: CSSProperties;
  /** 右上角窗口控制区（关闭侧栏/窗口按钮）——由宿主装配，本组件只管版式。 */
  headerControls?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="side-pane-open-tab-shell flex h-full min-h-0 flex-col bg-background">
      <div
        className={cn(
          "flex h-12 shrink-0 items-center justify-end px-2",
          isDesktop && "[app-region:drag]",
        )}
        style={captionControlsStyle}
      >
        {headerControls}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-5 py-10">
        <div className="side-pane-open-tab-content flex w-full max-w-[20rem] flex-col gap-5">
          <div className="flex flex-col gap-2 text-center">
            <h2 className="text-xl font-semibold leading-7 text-foreground">
              {intl.formatMessage({ id: "sidePane.openTab" })}
            </h2>
            <p className="text-ui-base leading-5 text-foreground-subtle">
              {intl.formatMessage({ id: "sidePane.openTabDescription" })}
            </p>
          </div>
          <div className="side-pane-open-tab-list flex w-full flex-col gap-2">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-side-pane-open-tab-item={item.id}
                  className="side-pane-open-tab-button flex h-12 min-w-0 items-center gap-3 rounded-xl bg-surface px-3 text-ui-base font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={item.onOpen}
                >
                  <Icon className="size-4 text-foreground-subtle" />
                  <span className="side-pane-open-tab-button-label min-w-0 flex-1 truncate text-left">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
