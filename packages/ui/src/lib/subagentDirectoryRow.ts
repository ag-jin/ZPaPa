/**
 * 子智能体目录条目的副文案（纯函数，可被 node:test 钉住）。
 *
 * 背景：孤儿收敛（重启后接管会话，给没有终态记录的后台 child 落盘 `subagent_outcome{lost}`）
 * 产生的 ended 行只显示「已丢失」——状态说了，成因没说。读面对这种行打 `reconciled` 标记，
 * 这里把它翻成成因文案；真实终态到场后标记消失，文案自然让位。
 *
 * 优先级：child 自己的 `summary` 优先。它是证据（child 落库的最后输出/错误），成因文案只是
 * 「没有别的可说时」的解释，不能盖住真结果。
 *
 * `formatMessage` 由调用方注入（与 `formatTaskRelativeTime(timestamp, intl)` 同款）：
 * 本模块不依赖 react-intl，判据才能在 node:test 里直接钉住。
 */
export function subagentDirectoryRowSummary(
  item: { summary?: string | undefined; reconciled?: boolean | undefined },
  formatMessage: (id: string) => string,
): string | undefined {
  if (item.summary) return item.summary;
  return item.reconciled === true
    ? formatMessage("subagentDirectory.summary.reconciled")
    : undefined;
}
