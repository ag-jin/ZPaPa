// `zcode reconcile-report`：重启缺口的只读对账命令（spec 2026-10-08-subagent-orphan-reconcile 裁决 4 = 4C）。
//
// 为什么由 CLI 出这条命令而不是让 board 直读 db.sqlite：board 不应知道 store 的内部 schema
// （schema 变更会静默破坏对账）；CLI 提供一个只读 seam，board / 人只消费输出。
// 判据全部是 durable 事实，禁止在线阈值（通知滞后 max 80s，时间窗判断必假阳）。

import type { Logger } from "@zcode/contracts";
import type { RunContext, GlobalOptions } from "@zcode/shared-types";
import type { readRestartGapReconcileReport } from "@zcode/bootstrap";
import type { CliEnv } from "./env.js";

type BootstrapModule = typeof import("@zcode/bootstrap");
type ReconcileReport = Awaited<ReturnType<typeof readRestartGapReconcileReport>>;

interface ReconcileReportCommandDependencies {
  env?: CliEnv;
  logger?: Logger;
  loadBootstrapModule?: () => Promise<BootstrapModule>;
  readReport?: (options: { env?: NodeJS.ProcessEnv }) => Promise<ReconcileReport>;
}

export const runReconcileReportCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: ReconcileReportCommandDependencies,
): Promise<number> => {
  try {
    const report = deps.readReport
      ? await deps.readReport({ env: deps.env })
      : await (
          await (deps.loadBootstrapModule ?? (() => import("@zcode/bootstrap")))()
        ).readRestartGapReconcileReport({ env: deps.env });
    if (options.json) {
      ctx.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return 0;
    }
    ctx.stdout.write(formatReconcileReport(report));
    return 0;
  } catch (error) {
    ctx.stderr.write(
      `reconcile-report failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
};

/** 人类可读输出：只陈述 durable 事实与机械结论，不做「通知丢失」类因果归因。 */
export function formatReconcileReport(report: ReconcileReport): string {
  const lines = [
    "Restart-gap reconcile report (read-only, durable facts only)",
    `generated_at: ${report.generatedAt}`,
    `sessions_scanned: ${report.sessionsScanned}`,
    "",
    "background-notification ledger (session_input, kind=backgroundNotification):",
    `  admitted (in flight): ${report.ledger.admitted}`,
    `  promoted (delivered): ${report.ledger.promoted}`,
    `  discarded: ${report.ledger.discarded} (of which resume-swept: ${report.resumeDiscarded})`,
    `  cancelled: ${report.ledger.cancelled}`,
    `  failed: ${report.ledger.failed}`,
    "",
    "subagent lost reconciliation (subagent_outcome{lost} vs subagent-orphan-wake ledger):",
    `  lost_children: ${report.lostChildren}`,
    `  wake_delivered: ${report.wakeDelivered}`,
    `  wake_missing: ${report.wakeMissing.length}`,
  ];
  for (const missing of report.wakeMissing) {
    lines.push(
      `    - ${missing.childSessionId} (wake ledger status: ${missing.wakeStatus ?? "absent"})`,
    );
  }
  lines.push(
    "",
    "note: this report makes no causal attribution for latency (completion-to-notification",
    "      latency is p99 39s / max 80s; time-window checks are false positives by design).",
  );
  return `${lines.join("\n")}\n`;
}
