import { ChevronRight } from "lucide-react";
import type { WikiRenderNode } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";

/** 页面正文缺失时的占位（生成失败或尚未生成）。 */
export function MissingPageNotice({ title }: { title: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-4 text-center">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "wiki.page.notGenerated" }, { title })}
      </p>
    </div>
  );
}

/**
 * 目录树的一行。
 *
 * 分组节点可展开；页面节点点击后由父组件切换到正文。
 * 正文缺失的页面仍然渲染（划掉样式），而不是从目录里消失 ——
 * 否则用户无法知道哪些页生成失败了。
 */
export function CatalogTreeNode({
  node,
  depth,
  selectedPageId,
  onSelect,
  expandedIds,
  onToggle,
}: {
  node: WikiRenderNode;
  depth: number;
  selectedPageId: string | null;
  onSelect: (pageId: string) => void;
  expandedIds: ReadonlySet<string>;
  onToggle: (nodeId: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const expanded = expandedIds.has(node.id);
  const pageId = node.page?.id ?? null;
  const selected = pageId !== null && pageId === selectedPageId;
  const missing = pageId !== null && !node.page?.markdown;

  return (
    <div>
      <button
        type="button"
        onClick={() => {
          if (hasChildren) onToggle(node.id);
          if (pageId && node.page?.markdown) onSelect(pageId);
        }}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "flex w-full items-center gap-1 rounded px-2 py-1 text-left text-ui-base transition-colors hover:bg-hover",
          selected && "bg-hover text-foreground",
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
      >
        {hasChildren ? (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-foreground-subtle transition-transform",
              expanded && "rotate-90",
            )}
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span
          className={cn(
            "truncate",
            missing ? "text-foreground-subtlest line-through" : "text-foreground",
          )}
        >
          {node.title}
        </span>
      </button>
      {hasChildren && expanded
        ? node.children.map((child) => (
            <CatalogTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedPageId={selectedPageId}
              onSelect={onSelect}
              expandedIds={expandedIds}
              onToggle={onToggle}
            />
          ))
        : null}
    </div>
  );
}
