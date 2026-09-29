import type { ReactNode } from "react";

/**
 * 配置项行：与设置页其余表单一致的 label + control 两列。
 *
 * 抽成独立文件让主分区保持在 400 行以内（architecture-policy 的全局限制）。
 */
export function WikiFieldRow({
  label,
  description,
  control,
}: {
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="min-w-0">
        <div className="text-ui-base font-medium text-foreground">{label}</div>
        {description ? (
          <div className="mt-0.5 text-ui-sm text-foreground-subtle">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}
