import type { ReactNode } from "react";
import type { WikiAutoUpdateFrequency, WikiProjectSettings } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { WikiFieldRow as FieldRow } from "@/settings/WikiFieldRow.js";

/** 频率三档：文档级更新不需要更细的粒度。 */
const FREQUENCY_OPTIONS: WikiAutoUpdateFrequency[] = ["daily", "every2days", "weekly"];

/**
 * 可选时间：每 30 分钟一档。
 *
 * 用下拉而不是原生 time 控件：原生控件在各平台外观不一致（截图里显示成
 * 03:00 AM），且无法用主题控制弹层；而下拉与页面其余选择器同源。
 * 半小时粒度对「文档级更新」足够，不需要分钟级精度。
 */
const TIME_OPTIONS: Array<{ hour: number; minute: number }> = Array.from(
  { length: 48 },
  (_, index) => ({ hour: Math.floor(index / 2), minute: (index % 2) * 30 }),
);

/** 时间选项的展示：补零成 HH:MM。 */
function clockLabel(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 时间选项的值：`H:MM`，用于 Select 的 value 匹配。 */
function timeOptionValue(hour: number, minute: number): string {
  return `${hour}:${minute}`;
}

/**
 * 把已配置的时间对齐到最近的可选档位。
 *
 * 既有配置可能是任意分钟（如 03:17），下拉里没有对应项；不对齐会让
 * Select 显示空白。向上取整到下一档更符合「什么时候跑」的直觉。
 */
function nearestTimeOption(hour: number, minute: number): { hour: number; minute: number } {
  const targetMinutes = hour * 60 + minute;
  let best = TIME_OPTIONS[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of TIME_OPTIONS) {
    const distance = Math.abs(option.hour * 60 + option.minute - targetMinutes);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = option;
    }
  }
  return best;
}

const SELECT_CONTENT_CLASS =
  "w-[var(--radix-select-trigger-width)] px-0 py-1.5 [&_[data-position=popper]]:px-1 [&_[data-slot=select-scroll-up-button]]:hidden [&_[data-slot=select-scroll-down-button]]:hidden";
const SELECT_ITEM_CLASS =
  "min-h-8 rounded-[8px] px-2 py-1.5 pr-8 text-ui-base leading-5 text-foreground-subtle data-[highlighted]:bg-menu-hover data-[highlighted]:text-foreground data-[state=checked]:bg-menu-hover data-[state=checked]:text-foreground";

/**
 * 定时自动更新区块。
 *
 * 天间隔与固定时间是两个独立控件：前者决定「多久一次」，后者决定「几点跑」，
 * 分开才便于各自调整。关闭定时时这些行仍渲染但置灰 —— 用户一眼能看到有
 * 哪些选项，不必先打开开关才发现。
 */
export function WikiScheduleFields({
  value,
  onChange,
  scheduledModelPicker,
}: {
  /** 当前生效值（可能是未保存的草稿）。 */
  value: WikiProjectSettings;
  onChange: (patch: Partial<WikiProjectSettings>) => void;
  /** 定时生成用的模型选择控件，由调用方构造。 */
  scheduledModelPicker: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const enabled = value.autoUpdateEnabled === true;
  const frequency = value.autoUpdateFrequency ?? "daily";
  const hour = value.autoUpdateHour ?? 3;
  const minute = value.autoUpdateMinute ?? 0;
  const selectedTime = nearestTimeOption(hour, minute);

  return (
    <div className="border-t border-border">
      <FieldRow
        label={intl.formatMessage({ id: "wiki.settings.autoUpdate.label" })}
        description={intl.formatMessage({ id: "wiki.settings.autoUpdate.projectHint" })}
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => onChange({ autoUpdateEnabled: checked })}
          />
        }
      />
      <fieldset
        disabled={!enabled}
        className={cn("border-t border-border", !enabled && "opacity-50")}
      >
        {/* 频率与时间合成一个控件：两者共同回答「什么时候跑」，
            拆成两行会让用户以为是两个独立设置。外层一个边框容器，
            内部左侧选间隔、右侧选时刻。 */}
        <FieldRow
          label={intl.formatMessage({ id: "wiki.settings.schedule.label" })}
          description={intl.formatMessage({ id: "wiki.settings.schedule.hint" })}
          control={
            <div
              className={cn(
                "flex h-8 items-center overflow-hidden rounded-lg border border-input-border bg-input",
                !enabled && "cursor-not-allowed opacity-60",
              )}
            >
              <Select
                value={frequency}
                onValueChange={(next) => {
                  if (next === "daily" || next === "every2days" || next === "weekly") {
                    onChange({ autoUpdateFrequency: next });
                  }
                }}
                disabled={!enabled}
              >
                <SelectTrigger className="h-8 w-28 rounded-none border-0 bg-transparent px-2.5 text-ui-base hover:bg-transparent focus-visible:ring-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  className={SELECT_CONTENT_CLASS}
                >
                  {FREQUENCY_OPTIONS.map((option) => (
                    <SelectItem key={option} value={option} className={SELECT_ITEM_CLASS}>
                      {intl.formatMessage({ id: `wiki.settings.frequency.${option}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* 分隔线让两个选择读作一个控件的两段，而不是两个控件挨着 */}
              <span className="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
              <Select
                value={timeOptionValue(selectedTime.hour, selectedTime.minute)}
                onValueChange={(next) => {
                  const [hourText, minuteText] = next.split(":");
                  const nextHour = Number(hourText);
                  const nextMinute = Number(minuteText);
                  if (!Number.isInteger(nextHour) || !Number.isInteger(nextMinute)) return;
                  onChange({ autoUpdateHour: nextHour, autoUpdateMinute: nextMinute });
                }}
                disabled={!enabled}
              >
                <SelectTrigger
                  className="h-8 w-24 rounded-none border-0 bg-transparent px-2.5 text-ui-base hover:bg-transparent focus-visible:ring-0"
                  aria-label={intl.formatMessage({ id: "wiki.settings.time.label" })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent
                  position="popper"
                  align="start"
                  side="bottom"
                  sideOffset={4}
                  className={SELECT_CONTENT_CLASS}
                >
                  {TIME_OPTIONS.map((option) => (
                    <SelectItem
                      key={timeOptionValue(option.hour, option.minute)}
                      value={timeOptionValue(option.hour, option.minute)}
                      className={SELECT_ITEM_CLASS}
                    >
                      {clockLabel(option.hour, option.minute)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          }
        />
        <div className="border-t border-border">
          <FieldRow
            label={intl.formatMessage({ id: "wiki.settings.scheduledModel.label" })}
            description={intl.formatMessage({ id: "wiki.settings.scheduledModel.hint" })}
            control={scheduledModelPicker}
          />
        </div>
      </fieldset>
    </div>
  );
}
