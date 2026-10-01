// scheduler(utilityProcess) ↔ main 的控制消息协议。两端都在 Electron 侧，走 parentPort.postMessage。
// 与 host↔main 的 CronRun/CronRunResult(见 @zcode/shared channels + validation)不同：
// 这层是 main 与「常驻 cron scheduler 进程」之间的私有通道；main 收到派发请求后再翻译成 CronRun 转发给 host。
import type { ModelSelection, NodeSelfResourceSample } from "@zcode/shared";

/** scheduler → main */
export type SchedulerToMainMessage =
  | {
      type: "cron-dispatch-request";
      automationId: string;
      runId: string;
      prompt: string;
      targetTaskId?: string;
      modelSelection?: ModelSelection;
      mode?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      // 闲时任务派发：与 cron 消息对独立。首跑不带 conversationId/sessionId，
      // host createTask 新建 session；续跑/中断恢复带上两者 resume 同一会话。
      type: "offpeak-dispatch-request";
      offPeakTaskId: string;
      prompt: string;
      permissionMode: string;
      modelSelection: ModelSelection;
      conversationId?: string;
      sessionId?: string;
      serverTicketId?: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      type: "scheduler-log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      // 唤醒规则到点（spec §5.7.1）。**薄消息**：字段与 `hostSquadWakeMessageSchema` 同形，
      // 只带「哪条规则到点了」。规划（解析工作项与小队、决定派给谁、渲染简报）在 **host 侧一处**
      // 完成——调度器**不读**小队定义（那是文件、由服务层拥有）。
      // 这里夹带 agentId / isLeaderTask / prompt 就是把规划搬到调度器、制造第二份实现（漂移不报错）。
      type: "squad-wake-dispatch-request";
      ruleId: string;
      workItemId: string;
      /** spec §5.7.1 四元组里的 revision（fencing：过期 revision 的派发自动作废）。 */
      revision: number;
      /** 幂等键的稳定一半，由唯一构造器 `computeEventKey` 产出。 */
      eventKey: string;
      workspacePath: string;
      workspaceIdentity?: string;
    }
  | {
      // 闲时任务 running 计数变化 → main 据此 + keepAwakeWhileRunning 设置
      // 决定是否开 powerSaveBlocker。每次 tick 后上报当前值（幂等）。
      type: "offpeak-active-count";
      count: number;
    }
  | {
      // scheduler 进程每 60 秒的自采样本。
      // main 只取其中的 heap 作 scheduler 角色事件的 heap 维度，CPU 与 RSS 仍以 getAppMetrics 为准。
      type: "scheduler-resource-sample";
      sample: NodeSelfResourceSample;
    };

/** main → scheduler */
export type MainToSchedulerMessage =
  | {
      type: "cron-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      /** deferred=目标绑定会话正在执行：等待空闲后重投，不计入 transient 重试预算。 */
      failureKind?: "transient" | "permanent" | "deferred";
    }
  | {
      // 闲时任务派发结果；迟到结果仅凭 offPeakTaskId 结算（无 inFlight 上下文也可，幂等）。
      type: "offpeak-dispatch-result";
      offPeakTaskId: string;
      ok: boolean;
      conversationId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent";
    }
  | {
      // 唤醒规则派发结果。`runId` 用幂等键里的 eventKey（调度器唯一稳定的那一半）。
      // deferred=绑定会话正在执行（等待型重投）；permanent=门禁关闭 / 运行时未注册 / 开树失败。
      type: "squad-wake-dispatch-result";
      runId: string;
      ok: boolean;
      taskId?: string;
      sessionId?: string;
      error?: string;
      failureKind?: "transient" | "permanent" | "deferred";
    }
  | {
      // main 在退出前通知 scheduler 优雅收尾（释放认领、关库）。
      type: "scheduler-dispose";
    }
  | {
      // manual run 已提交，立即触发一次 tick；automationId 仅用于日志关联。
      type: "scheduler-wake";
      automationId: string;
    };
