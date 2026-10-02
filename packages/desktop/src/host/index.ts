/* eslint-disable max-lines -- Host 入口集中编排 local/remote service wiring，本次退出保护需要在同一处桥接 host 上报。 */
/* eslint-disable max-lines -- host process 入口集中维护 local/remote 初始化和资源回收，realtime bridge 接入后先保持同文件收口。 */
/**
 * Host Process 入口 —— 每个窗口对应一个独立的 host process
 *
 * 同一窗口的 Renderer 和手机 都 attachment 到这个 Host：
 *   Renderer / Mobile ←MessagePort→ Window Host
 *                                      ├─ local services
 *                                      └─ remote connection registry
 *
 * 启动流程：
 * 1. main 进程通过 Electron `utilityProcess.fork()` 创建本进程
 * 2. main 进程只发送一次 init-local 初始化窗口 Host
 * 3. 后续远端 connect / scoped attachment 都由同一 Host 处理
 */
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";
import { randomUUID } from "node:crypto";
import {
  MessagePortProtocol,
  ChannelServer,
  type IDisposable,
  type IChannelServer,
  LoggingChannelServer,
  NetworkTelemetryChannelServer,
} from "@zcode/rpc";
import { registerHostNetworkTelemetry, stopHostNetworkTelemetry } from "./hostNetworkTelemetry.js";
import { registerHostServiceResourceTelemetry } from "./hostServiceResourceTelemetry.js";
import { resolveResourceTelemetryEnvironmentKey } from "./hostResourceTelemetryEnvironment.js";
import { reportHostSessionCreate } from "./hostSessionCreateTelemetry.js";
import { createBrowserControlMainBridge } from "./browserControlMainBridge.js";
import { materializeBrowserRecordingArtifact } from "./browserRecordingArtifactMaterializer.js";
import {
  ServiceCollection,
  IBotsService,
  IFileService,
  IClientConfigService,
  IMediaPreviewService,
  IOffPeakTaskService,
  IModelSelectionService,
  ISettingService,
  IWindowControllerService,
  IConversationShareService,
  IZCodeAgentService,
  IZCodeTaskService,
  IZCodeSessionService,
  ICuaPipSessionService,
  IProviderProvisioningTargetService,
  ISquadRuntimeService,
  type OpenMemberRunResult,
  createUntrustedProviderProvisioningTarget,
  isProviderProvisioningTrustedClientMode,
  createZCodeAgentConnectionScope,
  type ZCodeAgentV4ClientMode,
  collectServiceMemoryDiagnostics,
} from "@zcode/services";
import {
  createLocalServices,
  getOffPeakRequestAuthBuilder,
  disposeServiceResources,
  disposeServiceResourcesAndWait,
  AutomationRepo,
  OffPeakTaskRepo,
  OffPeakTaskService,
  createServiceLogger,
  buildTaskChangeSummary,
  createHostApiNetworkTransport,
  createSettingServiceWithMigrations,
  OffPeakModelUnavailableError,
  OffPeakPermanentDispatchError,
  planDispatch,
  renderLeaderBriefingPrompt,
  type HostApiNetworkTransport,
  type OffPeakRequestAuthBuilder,
  type SquadDispatchRequest,
} from "@zcode/services/node";
import { createHostResourceUsageResponder } from "./hostResourceUsage.js";
import {
  decideSquadDispatch,
  isSquadDispatchDisabledError,
  ledgerActionForRunClass,
  watchLeaderRunSettlement,
  watchMemberRunSettlement,
  type SquadDispatchKind,
  type SquadMemberRunTerminalOutcome,
} from "./squadDispatch.js";
import { resolveSquadWorkspaceBinding } from "./squadWorkspaceBinding.js";
import {
  assertBoundSessionDispatchable,
  resolveOffPeakDispatchKind,
} from "./offPeakDispatchPlan.js";
import {
  BoundSessionBusyError,
  createBoundSessionExecutingProbe,
} from "./boundSessionBusyGate.js";
import {
  HostMessageTypes,
  HostResponseTypes,
  ZCODE_VERSION,
  formatLogPrefix,
  formatZCodeHostProcessName,
  formatZodError,
  buildRemoteWorkspaceIdentity,
  buildRemoteEnvironmentKey,
  isOffPeakTicketExpiredError,
  isRemoteWorkspaceIdentity,
  resolveWorkspaceKey,
  formatModelPickerValue,
  type ZCodePromptAttachment,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type TaskStreamMirrorableEvent,
  type TraceId,
  type ZCodeTaskMode,
  type WindowHostAttachmentScope,
  type ZCodeAutomation,
  type ZCodeAutomationRun,
  type ZCodeAutomationRunOutcome,
  type ModelSelection,
  type WorkItem,
} from "@zcode/shared";
import {
  parseHostIncomingMessageEvent,
  rejectUnavailableAttachedServicePort,
} from "./hostMessagePortGuard.js";
import { disposeResidentExposure, exposeAsResidentHost } from "./residentExposure.js";
// remote backend 相关模块延迟加载：ssh2 的 CJS 依赖链（asn1 等）在 asar 打包后路径断裂，
// 静态 import 会导致 local 模式的 host process 也崩溃。
// 改为动态 import，仅 remote 模式时才加载。
import type {
  ConnectOptions,
  DeployLockMode,
  IRemoteBackend,
  RemoteRuntimeNetworkOptions,
  RemoteAssetNetworkPort,
  RemoteConnection,
} from "@zcode/server/remote";
import type { RemoteTarget } from "@zcode/shared";
import { wrapElectronPort } from "./electronPort.js";
import { createTaskRealtimeBridgeForHostInit } from "./taskRealtimeBridge.js";
import { resolveRpcLogLevel } from "./rpcLogLevel.js";
import { createHostWorkspaceTaskTracker } from "./hostWorkspaceTaskTracker.js";
import {
  createRemoteMediaPreviewProxy,
  type RemoteMediaPreviewProxy,
} from "./remoteMediaPreviewProxy.js";
import { watchCronRunBotDelivery } from "./cronBotDelivery.js";
import { createHostRemoteWorkspaceProxyState } from "./hostRemoteWorkspaceProxyState.js";
import { createRemoteWorkspaceServiceCollection } from "./remoteWorkspaceServiceCollection.js";
import { getRemoteProviderProvisioningExecutor } from "./remoteProviderProvisioningService.js";
import { createRemotePromptAttachmentTransferService } from "./promptAttachmentTransferService.js";
import { shouldReportHostConsoleError, stringifyHostLogArg } from "./hostLog.js";
import { flushHostE2ECoverage } from "./e2eCoverage.js";
import { runHostShutdownPhases, type HostShutdownResult } from "./hostShutdownPhases.js";
import { initializeHostApiNetworkTransportOwner } from "./hostInitialization.js";
import { createHostUncaughtExceptionHandler } from "./hostUncaughtExceptionGuard.js";
import {
  recordCronRunOutcomeBestEffort,
  startManualClaimHeartbeat,
  settleCronRunTerminalOutcome,
  settleManualDispatchFailureBestEffort,
} from "./cronRunLifecycle.js";
import {
  createRemotePromptAttachmentSessionService,
  createRemotePromptAttachmentTaskService,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";
import { scopeConversationShareServiceForAttachment } from "./conversationShareAttachmentService.js";
import {
  createWindowRemoteConnectionRegistry,
  type WindowRemoteConnectionCloseEvent,
  type WindowRemoteConnectionHandle,
} from "./windowRemoteConnectionRegistry.js";
import { createWindowHostControllerRuntime } from "./windowHostControllerService.js";
import { resolveAutomationSubmissionModelSelection } from "./automationModelSelection.js";
import { createRemoteConnectionProgressContext } from "@zcode/server/remote/remoteConnectionProgressContext.js";
import { startHostSelfResourceTelemetry } from "./hostSelfResourceTelemetry.js";
type RemoteBackendHostConnection = RemoteConnection & {
  backend: IRemoteBackend;
};
type HostRemoteConnection = RemoteBackendHostConnection;
interface HostRemoteConnectionCapabilities {
  browserRecordingUploader?: Pick<IRemoteBackend, "upload">;
  remoteMediaPreviewFactory?: (
    scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  ) => RemoteMediaPreviewProxy;
  /**
   * 在 A 开一条本地 TCP 隧道，转发到对端回环端口（工单 08）。
   *
   * 用途：远程项目里跑起来的预览服务监听在对端回环，A 的内嵌浏览器直接访问
   * 127.0.0.1 会打到本机。Controller 通过此能力按需建隧道，把对端端口映射到
   * A 的本地临时端口。
   *
   * 只在 SSH backend 提供（`openTcpTunnel` 是可选方法）；WSL/Docker 未实现时
   * 保持 undefined，调用方按能力探测退化。
   */
  openTcpTunnel?: (options: {
    remoteHost: string;
    remotePort: number;
  }) => Promise<{ localPort: number; dispose(): void }>;
}

let activeRemoteMediaRequests = 0;
const hostRemoteMediaRequestLimiter = {
  tryAcquire: () => {
    if (activeRemoteMediaRequests >= 4) return false;
    activeRemoteMediaRequests += 1;
    return true;
  },
  release: () => {
    activeRemoteMediaRequests = Math.max(0, activeRemoteMediaRequests - 1);
  },
  getState: () => ({ active: activeRemoteMediaRequests, limit: 4 }),
};
const remoteMediaRangePreviewEnabled =
  process.env["ZCODE_REMOTE_MEDIA_RANGE_PREVIEW_ENABLED"] !== "0";

type RemoteAssetDirs = Pick<
  ConnectOptions,
  "mockCdnDir" | "remoteCdnBaseUrl" | "remoteCdnBaseUrls" | "remoteCacheDir"
>;

const { parentPort } = process;

// 进程检索体验优化：host 由 utilityProcess 拉起时外壳仍是 Electron Helper，
// 这里根据 main 传入的窗口 label 补一层稳定的 zcode-* title，方便系统进程列表过滤。
process.title = formatZCodeHostProcessName(process.env["ZCODE_PROCESS_LABEL"]);

type HostLogLevel = "info" | "warn" | "error";

interface PendingFeedbackLogArchiveRequest {
  resolve: (archive: { path: string; size: number }) => void;
  reject: (error: Error) => void;
  onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
}

interface PendingLocalMediaPreviewPathAuthorization {
  resolve: (path: string) => void;
  reject: (error: Error) => void;
}

const pendingFeedbackLogArchiveRequests = new Map<string, PendingFeedbackLogArchiveRequest>();
let nextFeedbackLogArchiveRequestSeq = 0;
const pendingLocalMediaPreviewPathAuthorizations = new Map<
  string,
  PendingLocalMediaPreviewPathAuthorization
>();

function authorizeLocalMediaPreviewPath(path: string): Promise<string> {
  if (!parentPort) {
    return Promise.reject(new Error("parentPort unavailable"));
  }
  const requestId = randomUUID();
  return new Promise<string>((resolve, reject) => {
    pendingLocalMediaPreviewPathAuthorizations.set(requestId, { resolve, reject });
    try {
      parentPort.postMessage({
        type: HostResponseTypes.LocalMediaPreviewPathAuthorizeRequest,
        requestId,
        path,
      });
    } catch (error) {
      pendingLocalMediaPreviewPathAuthorizations.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

// browser-use host↔main 桥：把 agent 的 browser 命令经 parentPort 转给 main（WebContentsView+CDP）。
// parentPort 为空（不应发生于 host 进程）时 postToMain 抛错，bridge 自身返回 backend_unavailable。
const browserControlMainBridge = createBrowserControlMainBridge({
  postToMain: (message) => {
    if (!parentPort) {
      throw new Error("parentPort unavailable");
    }
    parentPort.postMessage(message);
  },
  materializeRecording: (input) => {
    let remoteBackend: Pick<IRemoteBackend, "upload"> | undefined;
    if (input.remoteSessionId) {
      const workspaceIdentity = input.workspaceIdentity;
      if (!workspaceIdentity?.trim()) {
        throw new Error("remote Browser recording materialization requires workspaceIdentity");
      }
      // Window Host 重构后同一进程可同时持有多个远端连接，旧的进程级
      // remoteConnection 会串 session。必须用完整 scope 从 registry 的权威 entry 取 uploader。
      remoteBackend = windowRemoteConnectionRegistry.resolveScopedCapabilities({
        kind: "remote",
        remoteSessionId: input.remoteSessionId,
        workspacePath: input.workspacePath,
        workspaceIdentity,
      })?.browserRecordingUploader;
    }
    return materializeBrowserRecordingArtifact({
      ...input,
      ...(remoteBackend ? { remoteBackend } : {}),
    });
  },
});

function reportHostLog(level: HostLogLevel, args: unknown[]): void {
  if (!parentPort) {
    return;
  }

  try {
    parentPort.postMessage({
      type: HostResponseTypes.Log,
      level,
      source: "host",
      message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
    });
  } catch {
    // 日志上报失败不应影响 host 主流程。
  }
}

const rawConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

const remoteConnectionProgressContext = createRemoteConnectionProgressContext({
  emit: ({ requestId, level, args }) => {
    if (!parentPort) {
      return;
    }
    try {
      parentPort.postMessage({
        type: HostResponseTypes.RemoteWorkspaceConnectionLog,
        requestId,
        level,
        message: args.map((arg) => stringifyHostLogArg(arg)).join(" "),
      });
    } catch {
      // 连接进度上报失败不应中断 SSH/WSL/Docker 的真实连接流程。
    }
  },
});

function writeHostLog(level: HostLogLevel, ...args: unknown[]): void {
  const prefix = formatLogPrefix("zcode-host", process.pid);
  const consoleFn =
    level === "error" ? rawConsole.error : level === "warn" ? rawConsole.warn : rawConsole.log;
  consoleFn(prefix, ...args);
  reportHostLog(level, [prefix, ...args]);
}

function createFullFeedbackLogArchiveViaMain(
  sourceDir: string,
  options?: {
    onProgress?: (event: { processedBytes: number; totalBytes: number }) => void;
  },
): Promise<{ path: string; size: number }> {
  const requestId = `feedback-log-archive-${Date.now()}-${nextFeedbackLogArchiveRequestSeq++}`;
  options?.onProgress?.({ processedBytes: 0, totalBytes: 0 });

  return new Promise((resolve, reject) => {
    pendingFeedbackLogArchiveRequests.set(requestId, {
      resolve,
      reject,
      onProgress: options?.onProgress,
    });
    // 问题反馈以前在 host service 内走 compactLogArchive 的 full fallback，
    // 收集范围和“导出日志”不一致，缺少 zcode-cli 日志、rollout/debug 以及导出链路脱敏。
    // 这里把完整日志打包委托给 main process 的导出日志同源逻辑，host 只拿 zip 路径继续上传。
    try {
      parentPort.postMessage({
        type: HostResponseTypes.FeedbackLogArchiveRequest,
        requestId,
        sourceDir,
      });
    } catch (error) {
      pendingFeedbackLogArchiveRequests.delete(requestId);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

const logger = {
  info: (...args: unknown[]) => writeHostLog("info", ...args),
  warn: (...args: unknown[]) => writeHostLog("warn", ...args),
  error: (...args: unknown[]) => writeHostLog("error", ...args),
};

const cronAutomationRepo = new AutomationRepo();
const cronRunSubscriptions = new Map<string, { dispose(): void }>();

// ---- 闲时任务（off-peak）派发：与 cron 并行的独立链路（表/消息/常量互不复用）----
const offPeakTaskRepo = new OffPeakTaskRepo();
const offPeakRunSubscriptions = new Map<string, { dispose(): void }>();
/**
 * 续跑提示词（"实现时定"的落地）：3h 时间盒到期 / app 重启恢复后 resume 同一
 * session 续发。不重发原始 prompt（会让模型从头再做一遍），而是指示接续未完成的工作。
 */
const OFF_PEAK_RESUME_PROMPT =
  "Continue the previous task from where it left off. The run was interrupted " +
  "(app restart or execution window expired). Do not start over; review what has " +
  "already been done and complete the remaining work.";

// ---- off-peak 运行时装配（server client + 进程内 mock 网关 + 编排服务，host 域属主）----
// ⚠ 多窗口=多 host 会各自跑一份 sync 轮询（批量接口幂等、写入同库同数据，重复仅多耗请求）；
// mock 网关用固定端口单实例共享票据状态。若多窗口轮询放大成本，再加跨 host 选主。
interface OffPeakRuntime {
  service: OffPeakTaskService;
  /** 派发时按本段票据构造逐请求鉴权；静态模型事实由 CLI Built-in Config 提供。 */
  buildRequestAuth: OffPeakRequestAuthBuilder;
  validateSelection: (selection: {
    providerId: string;
    modelId: string;
    options?: { reasoningLevel?: string };
  }) => Promise<boolean>;
}
let offPeakRuntime: OffPeakRuntime | null = null;

async function ensureOffPeakRuntime(): Promise<OffPeakRuntime | null> {
  if (offPeakRuntime) return offPeakRuntime;
  const services = activeServices;
  if (!services) return null;
  const service = services.getOptional(IOffPeakTaskService);
  const buildRequestAuth = getOffPeakRequestAuthBuilder(services);
  if (!service || !buildRequestAuth) {
    logger.warn("off-peak runtime unavailable: missing host services");
    return null;
  }
  offPeakRuntime = {
    service: service as OffPeakTaskService,
    buildRequestAuth,
    validateSelection: (selection) =>
      (service as OffPeakTaskService).validateDispatchModelSelection(selection),
  };
  logger.info("off-peak runtime ready (service from local collection)");
  return offPeakRuntime;
}

function disposeOffPeakRuntime(): void {
  if (!offPeakRuntime) return;
  offPeakRuntime = null;
}

interface OffPeakRunDispatchRequest {
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

function offPeakRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

function disposeOffPeakRunSubscription(key: string): void {
  const disposable = offPeakRunSubscriptions.get(key);
  if (!disposable) return;
  offPeakRunSubscriptions.delete(key);
  disposable.dispose();
}

/** 终态回填 files_changed：复用现有 task diff 汇总（工具写盘型统计，Bash 改动不计入，接受）。 */
async function resolveOffPeakFilesChanged(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): Promise<number | undefined> {
  try {
    const snapshot = await params.zcodeTaskService.getTaskSnapshot({
      taskId: params.taskId,
      workspacePath: params.workspacePath,
      ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    });
    const fileChanges = snapshot?.fileChanges;
    if (!fileChanges) return undefined;
    // 汇总为空（无文件改动）按 0 计——"改了 0 个文件"对完成通知是真实信息。
    return buildTaskChangeSummary(fileChanges)?.fileCount ?? 0;
  } catch (error) {
    logger.warn("off-peak files_changed 汇总失败（不阻塞终态落库）:", error);
    return undefined;
  }
}

/** loop 终态 → off_peak_tasks 终态：succeeded→completed、stopped→cancelled（用户手动停止）、其余→failed。 */
async function finalizeOffPeakRun(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): Promise<void> {
  // 自动续跑：票据过期（active 3h 到期 / ready 废票）不是失败——
  // 同 task_id 重取号回 queued，等下一个 ready 再 resume 同 session 续跑。
  if (params.outcome === "failed" && isOffPeakTicketExpiredError(params.error)) {
    const runtime = await ensureOffPeakRuntime();
    if (runtime) {
      await runtime.service.handleTicketExpiredDuringRun(params.offPeakTaskId);
      logger.info(
        `off-peak segment expired, requeued for continuation task=${params.offPeakTaskId}`,
      );
      return;
    }
    // 运行时不可用（服务缺失）时按普通失败落库，避免任务卡在 running。
  }
  const status =
    params.outcome === "succeeded"
      ? ("completed" as const)
      : params.outcome === "stopped"
        ? ("cancelled" as const)
        : ("failed" as const);
  const filesChanged = await resolveOffPeakFilesChanged(params);
  const updated = await offPeakTaskRepo.markTerminal(params.offPeakTaskId, {
    status,
    endedAt: Date.now(),
    ...(params.error ? { failureReason: params.error } : {}),
    ...(filesChanged !== undefined ? { filesChanged } : {}),
  });
  if (!updated) {
    // 终态不可逆出：任务已被用户先一步取消/删除等，丢弃迟到回写（幂等兜底）。
    logger.info(
      `off-peak terminal writeback dropped (already terminal) task=${params.offPeakTaskId}`,
    );
    return;
  }
  logger.info(
    `off-peak run finished task=${params.offPeakTaskId} status=${status} filesChanged=${filesChanged ?? "n/a"}`,
  );
  // 后台完成统一置未读，打开 task 时由导航链路清除（与 cron 同款）。
  void params.zcodeTaskService.setTaskUnread({
    taskId: params.taskId,
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    unread: true,
  });
}

function trackOffPeakRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  offPeakTaskId: string;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
}): void {
  const key = offPeakRunSubscriptionKey(params.taskId, params.traceId);
  disposeOffPeakRunSubscription(key);
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      disposeOffPeakRunSubscription(key);
      void finalizeOffPeakRun({
        zcodeTaskService: params.zcodeTaskService,
        offPeakTaskId: params.offPeakTaskId,
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        outcome: result.outcome,
        ...(result.error ? { error: result.error } : {}),
      }).catch((error) => logger.warn("off-peak 终态回写失败:", error));
    },
  );
  offPeakRunSubscriptions.set(key, disposable);
}

/**
 * 把一次闲时任务派发提交给当前 host 的 V4 task service。
 * 首跑（无 conversationId）createTask 新建专属 session；续跑/中断恢复 resume
 * 同一会话并以续跑提示词继续。闲时完整 Selection/鉴权仅注入本次执行。
 */
async function dispatchOffPeakRun(request: OffPeakRunDispatchRequest): Promise<{
  conversationId: string;
  sessionId: string;
}> {
  const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const runtime = await ensureOffPeakRuntime();
  if (!runtime) {
    throw new Error("off-peak runtime is not available");
  }
  if (!request.serverTicketId) {
    // schedulable 必然已取号；无票派发说明快照失序，按 transient 回执等下轮（轮询会补票）。
    throw new Error("off-peak dispatch without server ticket");
  }
  // idle plan 使用普通 Selection；单次执行约束保证它不写入 Session Selection。
  const idleSelection = request.modelSelection;
  if (!(await runtime.validateSelection(idleSelection))) {
    throw new OffPeakModelUnavailableError("idlePlan");
  }
  const requestAuth = await runtime.buildRequestAuth(request.serverTicketId);
  // 首次派发与复用会话的恢复派发需要在轮次事实中可区分；该字段只描述
  // 当前自动 turn 的调度阶段，不改变稳定 task ID、独立 message ID 或手动消息语义。
  const dispatchKind = resolveOffPeakDispatchKind(request);
  const offPeakRunType = dispatchKind === "resume" ? "resume" : "init";
  let trackedKey: string | null = null;
  try {
    let taskId: string;
    let traceId: TraceId;
    let promptContent = request.prompt;
    if (dispatchKind === "bound-first-run") {
      // 绑定首跑：会话内创建的任务在创建它的会话里执行（对齐 dispatchCronRun 的 targetTaskId 路径）。
      // 先探测再写配置：绑定的是用户的工作会话，忙碌时直接 transient 交给调度器退避，
      // 不能先 setMode 再被 session/send 以 -32010 拒绝（那会悄悄改掉用户会话的权限模式）。
      taskId = request.sessionId!;
      traceId = `${request.offPeakTaskId}:bound:${randomUUID()}` as TraceId;
      const workspaceScope = {
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
      };
      const [deletedIds, tasks] = await Promise.all([
        zcodeTaskService.listDeletedTaskIds(workspaceScope),
        zcodeTaskService.listTasks(workspaceScope),
      ]);
      assertBoundSessionDispatchable({
        sessionId: taskId,
        deleted: deletedIds.includes(taskId),
        running: tasks.find((task) => task.taskId === taskId)?.status === "running",
      });
      await zcodeTaskService.resumeTask({
        ...workspaceScope,
        taskId,
        // 绑定会话首次盖章归属标记，侧栏归入闲时分组（机制同 cron targetTaskId）。
        offPeakTaskId: request.offPeakTaskId,
      });
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
    } else if (dispatchKind === "resume") {
      // 续跑段：resume 同一 session（冷恢复水合历史；send 前必须先 resume）。
      taskId = request.conversationId!;
      // 原因：offPeakTaskId 只用于跨 talk 关联；每次自动轮必须生成独立消息身份，
      // 不能复用 task ID，也不能依赖同毫秒时间戳避免碰撞。
      traceId = `${request.offPeakTaskId}:resume:${randomUUID()}` as TraceId;
      promptContent = OFF_PEAK_RESUME_PROMPT;
      await zcodeTaskService.resumeTask({
        taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // pre-打点会话续跑时补写归属标记（bootstrap 回填之外的双保险）。
        offPeakTaskId: request.offPeakTaskId,
      });
      // 权限模式随派发下发（resume 后显式设置，幂等）。
      await zcodeTaskService.setConfigOption({
        taskId,
        traceId,
        configId: "mode",
        value: request.permissionMode,
      });
      // 档位是 idle Selection 的一部分，只在 sendPrompt 注入；单独写档位会污染用户会话。
    } else {
      const task = await zcodeTaskService.createTask({
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        // 空 Session 沿用普通初始化；idle Selection 只在下方执行中注入。
        // 在此写入会让闲时轮结束后的普通消息继续使用无票的隐藏 Provider。
        mode: request.permissionMode as ZCodeTaskMode,
        // 闲时任务是无界面的 createTask + sendPrompt 连续派发；空 session 必须在首条
        // V4 admission 内先持久化，否则 session_input 外键会先于 session 主记录写入。
        deferPersistenceUntilFirstPrompt: true,
        // 创建时即盖章持久归属标记（月亮图标/后续系统分组只看该标记，不再反查 store）。
        offPeakTaskId: request.offPeakTaskId,
      });
      taskId = task.taskId;
      traceId = task.traceId;
    }
    trackedKey = offPeakRunSubscriptionKey(taskId, traceId);
    trackOffPeakRunOutcome({
      zcodeTaskService,
      offPeakTaskId: request.offPeakTaskId,
      taskId,
      traceId,
      workspacePath: request.workspacePath,
      ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    });
    await zcodeTaskService.sendPrompt({
      taskId,
      traceId,
      content: promptContent,
      clientMode: "desktop-continuous",
      // Bug 原因：闲时自动 turn 以前只注入 idle plan，没有限制工具面，模型可在后台创建
      // 持久化定时任务。首跑与续跑在此收敛，显式隐藏 CronCreate 且不伪造 cron automation 归属。
      // 闲时轮同时隐藏 OffPeakCreate，OffPeakList 只读保留。
      toolDenylist: ["CronCreate", "OffPeakCreate"],
      modelSelection: idleSelection,
      modelExecution: {
        // 闲时执行凭据只服务主 Turn；完成后不再派生自动 Memory 请求。
        memoryExtraction: "skip",
        selectionScope: "execution",
        requestAuth,
        subagents: {
          foregroundModel: "submission",
          background: "deny",
        },
      },
      offPeakTaskId: request.offPeakTaskId,
      offPeakRunType,
    });
    // 只有 init 实际新建；绑定首跑和跨票续跑只是原 Session 的后续输入。
    if (dispatchKind === "init") {
      reportHostSessionCreate(parentPort, {
        sessionId: taskId,
        messageId: traceId,
        source: "automation_idle",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { conversationId: taskId, sessionId: taskId };
  } catch (error) {
    if (trackedKey) disposeOffPeakRunSubscription(trackedKey);
    throw error;
  }
}

interface CronRunDispatchRequest {
  automationId: string;
  runId: string;
  prompt: string;
  targetTaskId?: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
}

function resolveAutomationTargetServices(request: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ServiceCollection {
  const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(request);
  if (remoteSession) {
    if (!remoteSession.workspaceIdentity) {
      throw new Error("Automation 目标 Remote Host 缺少 workspaceIdentity");
    }
    return windowRemoteConnectionRegistry.resolveScopedServices({
      kind: "remote",
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: request.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    });
  }
  // 远程 Automation 找不到目标 logical session 时，旧派发会静默落到 Local Host，
  // 从而使用本地模型首选与 Registry。远程身份只能失败，不能跨 Environment fallback。
  if (request.workspaceIdentity && isRemoteWorkspaceIdentity(request.workspaceIdentity)) {
    throw new Error("Automation 目标 Remote Host 当前不可用");
  }
  if (!activeServices) {
    throw new Error("Local Host services are not initialized.");
  }
  return activeServices;
}

function cronRunSubscriptionKey(taskId: string, traceId: TraceId): string {
  return `${taskId}\u0000${traceId}`;
}

/**
 * 队员 run 的 prompt（spec §6.1 / §3.3）：工作项标题 + 正文 + 一句隔离说明。
 *
 * 为什么必须把「你的工作树是独立的」写进 prompt：开树是 host 做的，而队员**不知道**
 * 自己的工作区已经被换过 —— 不说明，它可能照着主工作区的路径去改文件（改到别处、且不报错），
 * 或者把结论写在一个队长看不到的地方（工作项才是整批的信息汇点）。
 */
function buildMemberRunPrompt(workItem: WorkItem): string {
  return [
    `# ${workItem.title}`,
    workItem.body.trim() === "" ? "" : workItem.body,
    "你的工作树是独立的，请只在其中工作（不要改主工作区）；完成后请把结论汇报到本工作项。",
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

/**
 * **单独安排的智能体** run 的 prompt（spec §6.1）：工作项标题 + 正文 + 一句「直接改工作区」的说明。
 *
 * 为什么**不能**复用 `buildMemberRunPrompt`：那一段写着「你的工作树是独立的……**不要改主工作区**」，
 * 而单独安排的智能体**恰好相反** —— 它就在主工作区里干活（没有工作树、没有合并那一步，§6.1）。
 * 把队员那段发给它，等于让一个没有独立工作区的智能体去找一棵并不存在的工作树：表现是「它不在
 * 指定位置改文件」或「改完说找不到」，而两边都不报错。故文案必须按类别分开发。
 */
function buildStandaloneRunPrompt(workItem: WorkItem): string {
  return [
    `# ${workItem.title}`,
    workItem.body.trim() === "" ? "" : workItem.body,
    "本次任务没有独立工作树：请直接在工作区里完成（没有合并那一步）；完成后请把结论汇报到本工作项。",
  ]
    .filter((section) => section !== "")
    .join("\n\n");
}

/** 启动恢复只该跑一次（`publish` 在重试/重复发布时会多次带 `phase: "ready"`）。两件事共用这一道闸。 */
let squadStartupRecoveryStarted = false;

/**
 * 启动回收（spec §6.4 / §6.6）—— **best-effort，但绝不静默**。
 *
 * 为什么必须做：孤儿工作树会**占住分支名**，下次对同一 (工作项, 队员) 再派发时开树会撞
 * 「分支已被占用」而失败 —— 清理是**重派发**的正确性前置，不是可选的维护动作。
 *
 * 为什么是异步（调用点 `void` 它）：回收要起 git 子进程（`worktree list` / `prune` / `branch -D`），
 * 同步跑会顶住启动（spec §11.4：孤儿清理在启动时异步）。
 *
 * 为什么失败只记日志、不阻断启动：一次回收失败不该让整个 Host 起不来（用户还有别的活要干）；
 * 但**必须**带原文 warn —— 静默吞掉会让「孤儿没收掉」和「本来就没有孤儿」长得一模一样。
 *
 * 为什么候选多于一个时只记日志：本期只支持单 workspace（多 workspace 属 P2c）。
 * `resolveSquadWorkspaceBinding` 会**列出候选**后抛，这里把它当一次**响亮**的「本次不回收」处理，
 * 而不是挑一个动手 —— 回收会删分支，挑错的代价是删别人仓库里的东西。
 */
async function reapStartupOrphansBestEffort(
  services: ServiceCollection | null,
  candidates: ReadonlyArray<{ path: string; identity: string }>,
): Promise<void> {
  let target: { path: string; identity: string };
  try {
    target = resolveSquadWorkspaceBinding(candidates);
  } catch (error) {
    logger.warn(
      "[squad] startup reap skipped（候选 workspace 不是恰好一个；多 workspace 支持属 P2c）",
      error,
    );
    return;
  }
  try {
    // 服务可能没有注册（例如不是桌面的本机权威装配）：这不是错误，是没有小队域可回收。
    const squadRuntime = services?.getOptional(ISquadRuntimeService);
    if (!squadRuntime) return;
    const outcome = await squadRuntime.reapStartupOrphans(target);
    logger.info(
      `[squad] startup reap done reclaimed=${outcome.reclaimed.length}` +
        ` branches=${outcome.reclaimedBranches.length} kept=${outcome.kept.length}` +
        ` foreign=${outcome.foreign.length}`,
    );
  } catch (error) {
    // 响亮（带原文）：best-effort 不等于静默。
    logger.warn("[squad] startup reap failed", error);
  }
}

/**
 * 启动**重驱**未收尾的批次（spec §6.6 / S15；裁定 Important-2，2026-10-02）—— best-effort 但**绝不静默**。
 *
 * 为什么必须有这一步：批次收尾（`advanceAfterChildrenDone`）的**唯一**驱动者是「子项完成」事件的转发器。
 * 若进程在「末个子项已 `done` 提交」与「`finalize` 落地」之间崩溃，重启后**没有任何东西会重发**
 * `child_completed` ⇒ 父项永远停在 `in_review`、集成分支不再有人合回主分支；更危险的是 `merged`
 * 的队员分支**不在 `listActive`** ⇒ 下次启动会被回收器当孤儿**连树带枝收掉**（有丢成果风险）。
 * 所以恢复动作必须是**幂等的重驱**（不是重放事件）：对「子项全部终态、但该批尚未 finalize」的父项
 * 再跑一次收尾。幂等性由编排层保证（重放闸 + 前置读当时状态的 CAS），这里只是把它接上。
 *
 * 为什么异步（调用点 `void`）：收尾要起 git 子进程做合并，同步跑会顶住启动（与启动回收同理由）。
 * 为什么失败只记日志、不阻断启动：一次重驱失败不该让 Host 起不来；但**逐条带原文**记 —— 静默会让
 * 「这批没恢复」和「本来就没有待恢复的批」长得一模一样。
 */
async function replayUnfinalizedBatchesBestEffort(
  services: ServiceCollection | null,
  candidates: ReadonlyArray<{ path: string; identity: string }>,
): Promise<void> {
  let target: { path: string; identity: string };
  try {
    target = resolveSquadWorkspaceBinding(candidates);
  } catch (error) {
    logger.warn(
      "[squad] startup batch replay skipped（候选 workspace 不是恰好一个；多 workspace 支持属 P2c）",
      error,
    );
    return;
  }
  try {
    const squadRuntime = services?.getOptional(ISquadRuntimeService);
    if (!squadRuntime) return;
    const outcome = await squadRuntime.replayUnfinalizedBatches(target);
    for (const failure of outcome.failures) {
      // 逐条 error 带**原错误对象**：一次注定失败的调用若只留个计数，事后无从下手。
      logger.error(
        `[squad] startup batch replay failed parent=${failure.parentWorkItemId}`,
        failure.error,
      );
    }
    logger.info(
      `[squad] startup batch replay done replayed=${outcome.replayed.length}` +
        ` failed=${outcome.failures.length}`,
    );
  } catch (error) {
    // 响亮（带原文）：best-effort 不等于静默。
    logger.warn("[squad] startup batch replay failed", error);
  }
}

/**
 * run 的**终态订阅句柄**（照 cron 侧 `cronRunSubscriptions` 的既有形态）。**队员与队长 run 共用**：
 * 两者都是真实会话、终态都在同一条出口上可观察，句柄的生死规则也一样（终态后解绑 / 重投先撤旧）。
 *
 * 为什么必须有人持有它：`watchMemberRunSettlement` / `watchLeaderRunSettlement` 内部的订阅是
 * 「等**这个 run** 的终态回调」，而派发中途抛错（createTask / resumeTask / sendPrompt 抛）时那个回调
 * **可能永远不来**（run 停在 `open`，本就是需要人工处置的残局）⇒ 句柄若无人持有，就残留到进程退出。
 * 键与 cron 侧**同形**（`(taskId, traceId)`，用同一个构造器，免得两处各写一份分隔符约定）；
 * 两张表各自独立，即使同键也不会互相影响。
 *
 * 与 cron 的一处刻意差异：cron 侧在 `trackCronRunOutcome` 内部持有句柄（订阅与登记在同一函数里），
 * 而这里订阅发生在 `watch*RunSettlement`（另一 lane 的文件）内部 —— 本文件不改它的接口，
 * 而是在**自己传进去的 `subscribe` 闭包**里把返回值接住（那正是「本处发起订阅」的返回值）。
 */
const squadRunSubscriptions = new Map<string, { dispose(): void }>();

function disposeSquadRunSubscription(key: string): void {
  const disposable = squadRunSubscriptions.get(key);
  if (!disposable) return;
  squadRunSubscriptions.delete(key);
  disposable.dispose();
}

/**
 * 完成通知（recon.md 缺口 #11，**best-effort**）：后台跑完把 task 置未读，用户在列表上看得见
 * 「这一轮跑完了」。
 *
 * 为什么不照抄 `watchCronRunBotDelivery`：那条通道要 automation 上的 Bot 回推目标
 * （`ZCodeAutomationBotDeliveryTarget`），小队 run 没有这样的配置；本阶段只保留与 cron
 * 同源的这一条可见性通知（`trackCronRunOutcome` 里的 `setTaskUnread` 同款）。
 *
 * **失败只 warn、绝不阻断派发**：通知是辅助通道，为了通知把派发拦下，用户看到的是
 * 「到点了什么都没发生」——比通知没发出去糟得多。
 */
function watchSquadRunCompletion(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}): void {
  try {
    let disposable: IDisposable | null = null;
    disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(() => {
      disposable?.dispose();
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
    });
  } catch (error) {
    logger.warn("[squad] run completion notification subscription failed", error);
  }
}

function parseCronRunScheduledAt(runId: string, automationId: string): number | null {
  const prefix = `${automationId}:`;
  if (!runId.startsWith(prefix)) return null;
  const value = Number(runId.slice(prefix.length).split(":")[0]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function markCronRunOutcome(params: {
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
  outcome: ZCodeAutomationRunOutcome;
  error?: string;
}): void {
  void recordCronRunOutcomeBestEffort({
    ...params,
    repo: cronAutomationRepo,
    logWarn: (message, error) => logger.warn(message, error),
  });
}

function disposeCronRunSubscription(key: string): void {
  const disposable = cronRunSubscriptions.get(key);
  if (!disposable) return;
  cronRunSubscriptions.delete(key);
  disposable.dispose();
}

async function applyCronRunConfigToExistingTask(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  modelSelection?: ModelSelection;
  mode?: string;
}): Promise<void> {
  let thoughtAppliedWithModel = false;
  let modeAppliedWithModel = false;
  if (params.modelSelection) {
    await params.zcodeTaskService.setAutomationSessionConfig({
      taskId: params.taskId,
      traceId: params.traceId,
      modelSelection: params.modelSelection,
      thoughtLevel: params.modelSelection.options?.reasoningLevel,
      mode: params.mode?.trim() as ZCodeTaskMode | undefined,
    });
    thoughtAppliedWithModel = true;
    modeAppliedWithModel = true;
  }
  if (!modeAppliedWithModel && params.mode?.trim()) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "mode",
      value: params.mode.trim(),
    });
  }
  if (!thoughtAppliedWithModel && params.modelSelection?.options?.reasoningLevel) {
    await params.zcodeTaskService.setConfigOption({
      taskId: params.taskId,
      traceId: params.traceId,
      configId: "thought_level",
      value: params.modelSelection.options.reasoningLevel,
    });
  }
}

function trackCronRunOutcome(params: {
  zcodeTaskService: IZCodeTaskService;
  taskId: string;
  traceId: TraceId;
  workspacePath: string;
  workspaceIdentity?: string;
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt: number | null;
  trigger: "schedule" | "manual";
}): void {
  const key = cronRunSubscriptionKey(params.taskId, params.traceId);
  disposeCronRunSubscription(key);
  markCronRunOutcome({ ...params, outcome: "running" });
  const disposable = params.zcodeTaskService.onDynamicTaskTerminalOutcome(params.taskId)(
    (result) => {
      if (result.inputId !== params.traceId) return;
      void settleCronRunTerminalOutcome({
        ...params,
        outcome: result.outcome,
        error: result.error,
        repo: cronAutomationRepo,
        logWarn: (message, error) => logger.warn(message, error),
      });
      // 定时任务在后台完成后统一置为未读，真正打开 task 时再由导航链路清除。
      void params.zcodeTaskService.setTaskUnread({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        unread: true,
      });
      disposeCronRunSubscription(key);
    },
  );
  const claimHeartbeat =
    params.trigger === "manual"
      ? startManualClaimHeartbeat({
          ...params,
          repo: cronAutomationRepo,
          logWarn: (message, error) => logger.warn(message, error),
        })
      : null;
  cronRunSubscriptions.set(key, {
    dispose() {
      claimHeartbeat?.dispose();
      disposable.dispose();
    },
  });
}

/**
 * 把一次 cron/manual run 直接提交给当前 host 的 V4 task service。
 * 会话内 automation 可能绑定到未激活 session，必须先恢复再应用保存的运行参数。
 */
async function dispatchCronRun(request: CronRunDispatchRequest): Promise<{
  taskId: string;
  sessionId: string;
}> {
  const targetServices = resolveAutomationTargetServices(request);
  const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
  if (!zcodeTaskService) {
    throw new Error("ZCode task service is not initialized.");
  }
  const modelSelectionService = targetServices.getOptional(IModelSelectionService);
  if (!modelSelectionService) {
    throw new Error("目标 Host Model Selection service is not initialized.");
  }
  // 长期配置是原意图；首次派发在目标 Host 解析后固定。已有 run 必须直接复用，
  // 不能因账号变化或本次 Registry 读取失败重新解释历史执行选择。
  const existingRun = await cronAutomationRepo.getRun(request.runId);
  const resolvedSubmissionModelSelection = await resolveAutomationSubmissionModelSelection({
    selection: request.modelSelection,
    fixedSelection: existingRun?.modelSelection,
    modelSelectionService,
    // Repo 已在读取前完成离线导入；不再为迁移绕行 Agent/账号服务。
    // 未迁入或损坏的新值仍由此入口明确拒绝，不能当成跟随 Workspace。
    readSelection: () =>
      cronAutomationRepo.getModelSelectionForDispatch(
        request.automationId,
        resolveWorkspaceKey(request),
      ),
  });
  const submissionModelSelection = await cronAutomationRepo.fixRunModelSelection(
    request.runId,
    resolvedSubmissionModelSelection,
  );
  let trackedKey: string | null = null;
  const workspaceKey = resolveWorkspaceKey(request);
  const trigger = request.runId.includes(":manual:") ? "manual" : "schedule";
  const scheduledAt = parseCronRunScheduledAt(request.runId, request.automationId);
  // 绑定会话正在执行时不得投递：既不排队也不插队，交由调度器等待空闲后重投。
  // 必须在 resumeTask / applyCronRunConfigToExistingTask 之前——setMode 没有活跃 turn
  // 检查，先写配置再撞忙会把用户会话悄悄改成任务的权限模式（off-peak 的同款教训）。
  if (request.targetTaskId) {
    const agentService = targetServices.getOptional(IZCodeAgentService);
    if (agentService) {
      const executing = await createBoundSessionExecutingProbe({
        agentService,
        logWarn: (message, error) => logger.warn(message, error),
      })({
        sessionId: request.targetTaskId,
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      });
      if (executing) throw new BoundSessionBusyError(request.targetTaskId);
    }
  }
  try {
    const task = request.targetTaskId
      ? { taskId: request.targetTaskId }
      : await zcodeTaskService.createTask({
          workspacePath: request.workspacePath,
          workspaceIdentity: request.workspaceIdentity,
          model: formatModelPickerValue(submissionModelSelection),
          mode: request.mode,
          thoughtLevel: submissionModelSelection.options?.reasoningLevel,
          automationId: request.automationId,
        });
    // 未绑定会话时不能沿用 createTask 的 session trace 作为首条 prompt trace：
    // CLI 无法从 inputId 还原 manual/schedule admission。
    // 建会话 trace 与执行 runId 是两种身份；两条派发路径的 prompt 都必须统一使用 runId。
    const promptTraceId = request.runId as TraceId;
    if (request.targetTaskId) {
      // 绑定会话在 app 重启或切换 workspace 后通常不处于 active；旧实现直接
      // setConfig/sendPrompt 会立即报 Session is not active，看起来像「立即运行」没有触发。
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
        model: formatModelPickerValue(submissionModelSelection),
        thoughtLevel: submissionModelSelection.options?.reasoningLevel,
        automationId: request.automationId,
      });
      await applyCronRunConfigToExistingTask({
        zcodeTaskService,
        taskId: task.taskId,
        traceId: promptTraceId,
        modelSelection: submissionModelSelection,
        mode: request.mode,
      });
    }
    const botsService = targetServices.getOptional(IBotsService);
    if (botsService) {
      try {
        await watchCronRunBotDelivery({
          automationId: request.automationId,
          workspaceKey,
          workspacePath: request.workspacePath,
          ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
          taskId: task.taskId,
          repo: cronAutomationRepo,
          botsService,
        });
      } catch (error) {
        // Bot 回推是 best-effort 辅助通道；配置/凭据/订阅失败不能阻断 automation 派发与结算。
        logger.warn(
          `automation Bot delivery subscription failed automation=${request.automationId} provider=unknown`,
          error,
        );
      }
    }
    trackedKey = cronRunSubscriptionKey(task.taskId, promptTraceId);
    trackCronRunOutcome({
      zcodeTaskService,
      taskId: task.taskId,
      traceId: promptTraceId,
      workspacePath: request.workspacePath,
      workspaceIdentity: request.workspaceIdentity,
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
    });
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId: promptTraceId,
      content: request.prompt,
      clientMode: "desktop-continuous",
      automationId: request.automationId,
    });
    // prompt 创建的定时任务带 targetTaskId，追加原会话不能计成 session_create。
    if (!request.targetTaskId) {
      reportHostSessionCreate(parentPort, {
        sessionId: task.taskId,
        messageId: promptTraceId,
        source: "automation_scheduled",
        workspaceIdentity: request.workspaceIdentity,
      });
    }
    return { taskId: task.taskId, sessionId: task.taskId };
  } catch (error) {
    if (trackedKey) disposeCronRunSubscription(trackedKey);
    markCronRunOutcome({
      runId: request.runId,
      automationId: request.automationId,
      workspaceKey,
      scheduledAt,
      trigger,
      outcome: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function dispatchManualAutomationRun(params: {
  automation: ZCodeAutomation;
  run: ZCodeAutomationRun;
}): Promise<void> {
  logger.info(
    `direct manual automation dispatch started automation=${params.automation.automationId} runId=${params.run.runId}`,
  );
  let result: Awaited<ReturnType<typeof dispatchCronRun>>;
  try {
    result = await dispatchCronRun({
      automationId: params.automation.automationId,
      runId: params.run.runId,
      prompt: params.automation.prompt,
      targetTaskId: params.automation.targetTaskId,
      modelSelection: params.run.modelSelection ?? params.automation.modelSelection,
      mode: params.automation.mode,
      workspacePath: params.automation.workspacePath,
      workspaceIdentity: params.automation.workspaceIdentity,
    });
  } catch (error) {
    logger.warn(
      `direct manual automation dispatch failed automation=${params.automation.automationId} runId=${params.run.runId}:`,
      error,
    );
    await settleManualDispatchFailureBestEffort({
      repo: cronAutomationRepo,
      automationId: params.automation.automationId,
      runId: params.run.runId,
      workspaceKey: params.automation.workspaceKey,
      scheduledAt: params.run.scheduledAt ?? null,
      trigger: "manual",
      dispatchError: error,
      logWarn: (message, releaseError) => logger.warn(message, releaseError),
    });
    throw error;
  }

  try {
    await cronAutomationRepo.markManualRunDispatched({
      runId: params.run.runId,
      sessionId: result.sessionId,
      dispatchedAt: Date.now(),
    });
  } catch (error) {
    // prompt 已经 accepted/queued，台账和累计次数回写失败不能伪装成派发失败并提前释放锁；
    // 真实终态仍由 trackCronRunOutcome 收口，避免同一 automation 重复排队。
    logger.warn(
      `回写 manual automation dispatched 状态与运行次数失败 automation=${params.automation.automationId} runId=${params.run.runId}`,
      error,
    );
  }
  // sendPrompt ACK 可能只表示进入 busy queue；manual claim 必须保留到对应 turn 终态。
  logger.info(
    `direct manual automation dispatch accepted automation=${params.automation.automationId} runId=${params.run.runId} taskId=${result.taskId}`,
  );
}

// Node warning 不是远端连接失败，改成结构化 warn，避免默认 stderr 被误染成 error。
process.on("warning", (warning) => logger.warn(`${warning.name}: ${warning.message}`));

registerHostNetworkTelemetry(parentPort);
// Host 进程自身的 60 秒采样：一次读数两个出口——门控后写本地
// `[memory]` 行，同一次读数换算成 HostResourceSample 经 parentPort 送 main 作 heap 来源。
// services 计数器由各 service 工厂自注册。
const hostSelfResourceTelemetry = startHostSelfResourceTelemetry({
  logger,
  collectCounters: collectServiceMemoryDiagnostics,
  postMessage: parentPort ? (message) => parentPort.postMessage(message) : undefined,
});

const runtimeProcessLifecycleReporter = {
  onSpawn(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessSpawned,
      ...event,
    });
  },
  onReady(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessReady,
      ...event,
    });
  },
  onExit(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessExited,
      ...event,
      signal: event.signal ?? null,
    });
  },
  onError(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentProcessError,
      ...event,
    });
  },
  onException(event) {
    parentPort?.postMessage({ type: HostResponseTypes.AgentProcessException, ...event });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["processLifecycleReporter"];

const runtimeTaskReporter = {
  onRunningTaskCountChanged(event) {
    if (!parentPort) {
      return;
    }

    parentPort.postMessage({
      type: HostResponseTypes.AgentRunningTaskCountChanged,
      runningTaskCount: event.runningTaskCount,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["taskRuntimeReporter"];

const cuaOperationStateReporter = {
  onStateChanged(event) {
    if (!parentPort) {
      return;
    }
    parentPort.postMessage({
      type: HostResponseTypes.CuaOperationState,
      ...event,
    });
  },
} satisfies NonNullable<Parameters<typeof createLocalServices>[0]>["cuaOperationStateReporter"];

let untrackedPromptRpcCount = 0;
function reportHostRunningTaskCount(): void {
  runtimeTaskReporter.onRunningTaskCountChanged({
    runningTaskCount: workspaceTaskTracker.getTotalRunningTaskCount() + untrackedPromptRpcCount,
  });
}

const workspaceTaskTracker = createHostWorkspaceTaskTracker((event) => {
  parentPort?.postMessage({
    type: HostResponseTypes.WorkspaceRunningTaskCountChanged,
    ...event,
  });
  windowRemoteConnectionRegistry.setWorkspaceRunningTaskCount(event);
  reportHostRunningTaskCount();
});

function isZCodeTaskMeta(value: unknown): value is ZCodeTaskMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    "taskId" in value &&
    "workspacePath" in value &&
    "traceId" in value &&
    typeof (value as { taskId?: unknown }).taskId === "string" &&
    typeof (value as { workspacePath?: unknown }).workspacePath === "string" &&
    typeof (value as { traceId?: unknown }).traceId === "string"
  );
}

function isRemoteMirrorableStreamEvent(
  event: ZCodeStreamEvent,
): event is TaskStreamMirrorableEvent {
  return event.type !== "task_stream_mirror_batch" && event.type !== "task_snapshot_updated";
}

function createReportingRemoteZCodeTaskService<T extends object>(
  service: T,
  options?: {
    reportRunningPromptCount?: boolean;
    taskRealtimePort?: ReturnType<typeof createTaskRealtimeBridgeForHostInit>;
    materializePromptAttachments?: (params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    }) => Promise<{ content: string; attachments?: ZCodePromptAttachment[] }>;
  },
): T {
  const workspaceProxyState = createHostRemoteWorkspaceProxyState();

  function forwardSessionMessageRequest(request: unknown): void {
    parentPort?.postMessage({
      type: HostResponseTypes.SessionMessageSendRequested,
      request,
    });
  }

  function subscribeSessionMessageRequests(target: T, meta: ZCodeTaskMeta): void {
    const onDynamicWorkspaceEvent = Reflect.get(target, "onDynamicWorkspaceEvent");
    if (typeof onDynamicWorkspaceEvent !== "function") {
      return;
    }
    const subscribe = onDynamicWorkspaceEvent.call(target, {
      workspacePath: meta.workspacePath,
      ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
    });
    if (typeof subscribe !== "function") {
      return;
    }
    workspaceProxyState.ensureWorkspaceSubscription(meta, () =>
      subscribe((event: unknown) => {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "workspace_session_message_send_requested"
        ) {
          forwardSessionMessageRequest((event as { request?: unknown }).request);
        }
      }),
    );
  }

  function rememberTaskMeta(result: unknown): void {
    if (isZCodeTaskMeta(result)) {
      workspaceProxyState.rememberTaskMeta(result);
      subscribeSessionMessageRequests(service, result);
      parentPort?.postMessage({
        type: HostResponseTypes.SessionRouteAnnounce,
        route: {
          sessionId: result.taskId,
        },
      });
    }
  }

  function rememberTaskMetasFromResult(result: unknown): void {
    if (Array.isArray(result)) {
      for (const item of result) {
        rememberTaskMetasFromResult(item);
      }
      return;
    }
    rememberTaskMeta(result);
    if (typeof result !== "object" || result === null) {
      return;
    }
    const items = (result as { items?: unknown }).items;
    if (Array.isArray(items)) {
      for (const item of items) {
        rememberTaskMeta(item);
      }
    }
    const snapshot = (result as { snapshot?: unknown }).snapshot;
    if (typeof snapshot === "object" && snapshot !== null) {
      rememberTaskMeta((snapshot as { meta?: unknown }).meta);
    }
    rememberTaskMeta((result as { meta?: unknown }).meta);
  }

  async function prepareRemotePromptParams(params: {
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }): Promise<{
    taskId: string;
    traceId: TraceId;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }> {
    if (!options?.materializePromptAttachments) {
      return params;
    }
    return {
      ...params,
      ...(await options.materializePromptAttachments(params)),
    };
  }

  async function mirrorRemotePrompt(
    target: T,
    sendPrompt: (...args: unknown[]) => Promise<unknown>,
    params: {
      taskId: string;
      traceId: TraceId;
      content: string;
      attachments?: ZCodePromptAttachment[];
    },
  ): Promise<unknown> {
    const taskRealtimePort = options?.taskRealtimePort;
    const meta = workspaceProxyState.getTaskMeta(params.taskId);
    if (!taskRealtimePort || !meta) {
      return sendPrompt.call(target, params);
    }

    const mirrorTarget = {
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      workspaceKey: resolveWorkspaceKey(meta),
      taskId: params.taskId,
      runId: params.traceId,
      traceId: params.traceId,
    };
    const leaseResult = await taskRealtimePort
      .acquireTaskRunLease(mirrorTarget)
      .catch((error: unknown) => {
        logger.warn("Bot remote runtime realtime lease failed:", error);
        return null;
      });
    if (!leaseResult?.acquired) {
      return sendPrompt.call(target, params);
    }

    taskRealtimePort.publishStreamOp(mirrorTarget, {
      kind: "user_message",
      messageId: `user-${params.traceId}`,
      content: params.content,
      attachments: params.attachments,
      timestamp: Date.now(),
    });

    // 写路径（send/stop/交互回执）已收敛 v4 命令面；本镜像属**读路径**——
    // taskRealtimePort → 手机 relay → 手机端
    // zcodeSessionStore 的整条消费链词表都是 ZCodeStreamEvent。两个方案的评估结论：
    // a) relay 直接转发 v4 帧、手机端消费 v4 store（正解）：需要重做 relay stream-op
    //    协议 + 手机端 store；
    // b) 帧→ZCodeStreamEvent 薄映射：等价复刻 adapter mapSessionEvent，
    //    否决。
    // 结论：本镜像保持 legacy 源不动。
    const dynamicStreamEvent = Reflect.get(target, "onDynamicStreamEvent");
    const streamDisposable =
      typeof dynamicStreamEvent === "function"
        ? dynamicStreamEvent.call(
            target,
            params.taskId,
          )((event: ZCodeStreamEvent) => {
            if (isRemoteMirrorableStreamEvent(event)) {
              taskRealtimePort.publishStreamOp(mirrorTarget, {
                kind: "stream_event",
                event,
              });
            }
          })
        : null;

    try {
      return await sendPrompt.call(target, params);
    } finally {
      // 远端 zcode-server 没有 desktop realtime port；由窗口 Host 内的
      // remote facade 接管 lease 和 stream mirror，确保 UI 能持续收到远端会话流。
      streamDisposable?.dispose();
      taskRealtimePort.releaseTaskRunLease(mirrorTarget);
    }
  }

  function finishWorkspaceTask(taskId: string, meta: ZCodeTaskMeta): void {
    workspaceProxyState.disposeTaskReadySubscription(taskId);
    workspaceTaskTracker.finish(taskId, meta);
  }

  function beginWorkspaceTask(target: T, taskId: string, meta: ZCodeTaskMeta): boolean {
    const started = workspaceTaskTracker.begin(taskId, meta);
    if (!started) {
      return false;
    }
    const onDynamicTaskReady = Reflect.get(target, "onDynamicTaskReady");
    if (typeof onDynamicTaskReady !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task service does not expose onDynamicTaskReady");
    }
    const subscribe = onDynamicTaskReady.call(target, taskId);
    if (typeof subscribe !== "function") {
      workspaceTaskTracker.finish(taskId, meta);
      throw new Error("remote ZCode task ready event is not subscribable");
    }
    workspaceProxyState.trackTaskReady(
      taskId,
      meta,
      (listener) => subscribe(listener),
      () => finishWorkspaceTask(taskId, meta),
    );
    return true;
  }

  // remote workspace 的 ZCode Agent manager 跑在远端 server，desktop main 不能直接看到
  // `handles` 状态。sendPrompt Promise 只是远端 ACK，必须等待 task ready 才能允许回收 workspace。
  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === "createTask" || property === "resumeTask") && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMeta(result);
          return result;
        };
      }
      if (
        (property === "listTasks" ||
          property === "listPinnedTasks" ||
          property === "listTaskList" ||
          property === "listArchivedTasks" ||
          property === "getTaskMeta" ||
          property === "getTaskSnapshot" ||
          property === "getTaskSnapshotWithEtag") &&
        typeof value === "function"
      ) {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          rememberTaskMetasFromResult(result);
          return result;
        };
      }
      if (property === "releaseWorkspacePreparation" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const context = args[0];
          if (
            typeof context === "object" &&
            context !== null &&
            typeof (context as { workspacePath?: unknown }).workspacePath === "string"
          ) {
            const workspaceContext = context as {
              workspacePath: string;
              workspaceIdentity?: string;
            };
            // pooled Host 不随 tab 退出；runtime 成功释放后必须同步解除 Host 代理层引用，
            // 否则 task meta 和动态事件 listener 会在整个应用生命周期内单调增长。
            workspaceProxyState.clearWorkspace(workspaceContext);
            workspaceTaskTracker.clearWorkspace(workspaceContext);
          }
          return result;
        };
      }
      const shouldWrapSendPrompt =
        options?.reportRunningPromptCount !== false ||
        Boolean(options?.taskRealtimePort) ||
        Boolean(options?.materializePromptAttachments);
      if (property !== "sendPrompt" || typeof value !== "function" || !shouldWrapSendPrompt) {
        return value;
      }

      return async (...args: unknown[]) => {
        let trackedTask: { taskId: string; meta: ZCodeTaskMeta; started: boolean } | undefined;
        let tracksOnlyRpcLifetime = false;
        try {
          const params = args[0];
          if (
            typeof params === "object" &&
            params !== null &&
            typeof (params as { taskId?: unknown }).taskId === "string" &&
            typeof (params as { traceId?: unknown }).traceId === "string" &&
            typeof (params as { content?: unknown }).content === "string"
          ) {
            const promptParams = params as {
              taskId: string;
              traceId: TraceId;
              content: string;
              attachments?: ZCodePromptAttachment[];
            };
            const taskMeta = workspaceProxyState.getTaskMeta(promptParams.taskId) as
              | ZCodeTaskMeta
              | undefined;
            if (taskMeta) {
              trackedTask = {
                taskId: promptParams.taskId,
                meta: taskMeta,
                started: beginWorkspaceTask(target, promptParams.taskId, taskMeta),
              };
            } else if (options?.reportRunningPromptCount !== false) {
              // task meta 缺失时无法安全伪造 workspace identity；仅保留 ACK 期间的 Host 退出诊断，
              // 不让该 fallback 参与 workspace runtime 的释放裁决。
              tracksOnlyRpcLifetime = true;
              untrackedPromptRpcCount += 1;
              reportHostRunningTaskCount();
            }
            const preparedParams = await prepareRemotePromptParams(promptParams);
            return await mirrorRemotePrompt(
              target,
              value.bind(target) as (...promptArgs: unknown[]) => Promise<unknown>,
              preparedParams,
            );
          }
          if (options?.reportRunningPromptCount !== false) {
            tracksOnlyRpcLifetime = true;
            untrackedPromptRpcCount += 1;
            reportHostRunningTaskCount();
          }
          return await value.apply(target, args);
        } catch (error) {
          if (trackedTask?.started) {
            finishWorkspaceTask(trackedTask.taskId, trackedTask.meta);
          }
          throw error;
        } finally {
          if (tracksOnlyRpcLifetime) {
            untrackedPromptRpcCount = Math.max(0, untrackedPromptRpcCount - 1);
            reportHostRunningTaskCount();
          }
        }
      };
    },
  });
}

function warmUpZCodeAgent(
  services: ServiceCollection,
  context: { workspacePath?: string; workspaceIdentity?: string },
  reason: string,
): void {
  if (!context.workspacePath) {
    return;
  }
  const workspacePath = context.workspacePath;
  const workspaceIdentity = context.workspaceIdentity;
  const zcodeSessionService = services.getOptional(IZCodeSessionService);
  if (!zcodeSessionService) {
    return;
  }
  void zcodeSessionService
    .initializeWorkspace({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    })
    .then((result) => {
      if (!result.available) {
        if (result.reasonCode === "provider_not_ready") {
          logger.info(
            `ZCode agent warmup waiting for provider/model (${reason}) workspace=${workspacePath}`,
          );
          return;
        }
        logger.warn(
          `ZCode agent warmup unavailable (${reason}) workspace=${workspacePath} reason=${result.reason ?? "unknown"}`,
        );
        return;
      }
      // 模型候选和首选项已经由目标 Host ModelSelectionView 提供；workspace
      // presentation 只剩 mode 与 slash commands。预热不能为读取 presentation 额外创建
      // Agent App，否则其 MCP close 会占住协议通道并阻塞真正的 Session 初始化。
      logger.info(
        `ZCode agent warmup ready (${reason}) workspace=${workspacePath} transport=${result.transportKind ?? "unknown"}`,
      );
    })
    .catch((error) => {
      logger.warn(`ZCode agent warmup failed (${reason}) workspace=${workspacePath}:`, error);
    });
}

// 后台输出轮询仍需独立的 debug logger，不能随其他日志调用方移除而丢失工厂导入。
const rpcDebugLogger = createServiceLogger("rpc");

function logRpc(message: string, ...args: unknown[]): void {
  const level = resolveRpcLogLevel(message, ...args);
  if (level === "debug") {
    rpcDebugLogger.debug(undefined, message, ...args);
    return;
  }
  logger[level](message, ...args);
}

function formatRemoteTargetForLog(target: RemoteTarget): string {
  switch (target.kind) {
    case "ssh":
      return `ssh:${target.username}@${target.host}:${target.port ?? 22}`;
    case "wsl": {
      const user = target.user?.trim();
      const distro = target.distro ?? "default";
      return user ? `wsl:${distro}:${user}` : `wsl:${distro}`;
    }
    case "docker":
      return `docker:${target.container}`;
  }
}

console.log = (...args: unknown[]) => {
  rawConsole.log(...args);
  reportHostLog("info", args);
  remoteConnectionProgressContext.report("info", args);
};

console.warn = (...args: unknown[]) => {
  rawConsole.warn(...args);
  reportHostLog("warn", args);
  remoteConnectionProgressContext.report("warn", args);
};

console.error = (...args: unknown[]) => {
  rawConsole.error(...args);
  // Electron 会把 Node warning 先走 console.error，而 process warning listener 随后还会
  // 结构化记录 warn；若这里继续上报，就会为同一个 warning 留下一条 error 和一条 warn。
  if (!shouldReportHostConsoleError(args)) {
    return;
  }
  reportHostLog("error", args);
  remoteConnectionProgressContext.report("error", args);
};

/** 当前 host 已注册的服务集合，进程退出时用于统一回收本地资源 */
let databaseStartup: ReturnType<typeof createHostDatabaseStartup> | undefined;
const pendingStartupAttachments = new Map<string, () => void>();
let activeServices: ServiceCollection | null = null;
let activeHostApiNetworkTransport: HostApiNetworkTransport | null = null;
/** 本地 host services 的资源遥测订阅；远端连接的订阅由各自的 connection handle 持有。 */
let activeLocalResourceTelemetry: IDisposable | null = null;
// 资源管理器采样只在 main 请求时执行一次，Host 不维护任何周期定时器。
const hostResourceUsageResponder = createHostResourceUsageResponder({
  getAgentService: () => activeServices?.getOptional(IZCodeAgentService),
  postMessage: (message) => parentPort?.postMessage(message),
});
let activeSessionRealtimePort: ReturnType<typeof createTaskRealtimeBridgeForHostInit> = null;
let hasDisposedHostResources = false;
let disposeHostResourcesInFlight: Promise<HostShutdownResult> | null = null;

function requireActiveHostApiNetworkTransport(): HostApiNetworkTransport {
  if (!activeHostApiNetworkTransport) {
    // Bug 原因：remote asset 若在 Host 网络策略就绪前回退 global fetch，会绕过设置页显式代理。
    throw new Error("Window Host network transport is not initialized");
  }
  return activeHostApiNetworkTransport;
}

async function resolveDesktopRemoteRuntimeNetwork(
  target: RemoteTarget,
): Promise<RemoteRuntimeNetworkOptions | undefined> {
  if (target.kind !== "wsl") {
    return undefined;
  }
  const settingService = activeServices?.getOptional(ISettingService);
  if (!settingService) {
    return undefined;
  }
  try {
    const settings = await settingService.get();
    return {
      authoritative: true,
      httpProxy: settings.httpProxy,
      noProxy: settings.httpProxyNoProxy,
    };
  } catch {
    // 设置读取失败时保留原有远程连接行为，不让网络增强把 WSL 工作区直接阻断。
    return undefined;
  }
}

async function disposeHostRemoteConnection(connection: HostRemoteConnection): Promise<void> {
  await connection.disposeAndWait({ timeoutMs: 5_000 });
}

async function createWindowRemoteConnectionHandle(params: {
  target: RemoteTarget;
  remoteAssets: RemoteAssetDirs;
  signal: AbortSignal;
}): Promise<WindowRemoteConnectionHandle<ServiceCollection, HostRemoteConnectionCapabilities>> {
  if (!activeServices) throw new Error("Local Host services are not initialized.");
  const clientConfigService = activeServices.get(IClientConfigService);
  if (params.signal.aborted) {
    throw new Error("远程连接已取消");
  }
  const closeListeners = new Set<(event: WindowRemoteConnectionCloseEvent) => void>();
  const notifyClose = (event: WindowRemoteConnectionCloseEvent) => {
    for (const listener of closeListeners) {
      listener(event);
    }
  };
  const connection = await setupRemoteConnection(
    params.target,
    params.remoteAssets,
    { fetch: requireActiveHostApiNetworkTransport().fetch },
    await resolveDesktopRemoteRuntimeNetwork(params.target),
    (exitCode) => notifyClose({ exitCode, signal: null }),
    params.target.kind === "ssh" ? "caller-serialized" : "remote",
    params.target.kind === "ssh" ? params.signal : undefined,
  );

  if (params.signal.aborted) {
    await disposeHostRemoteConnection(connection);
    throw new Error("远程连接已取消");
  }

  const backendConnection = connection;
  const materializePromptAttachments = async (request: {
    taskId: string;
    traceId: TraceId | string;
    content: string;
    attachments?: ZCodePromptAttachment[];
  }) => {
    const result = await materializeRemotePromptAttachments(request, {
      backend: backendConnection.backend,
    });
    return { content: result.content, attachments: result.attachments };
  };
  const promptAttachmentTransferService = createRemotePromptAttachmentTransferService(
    backendConnection.backend,
    {
      onJanitorError: (error: unknown) =>
        logger.warn("remote prompt attachment janitor failed", error),
    },
  );
  const services = createRemoteWorkspaceServiceCollection({
    clientConfigService,
    connectionServices: backendConnection.services,
    sourceServices: activeServices ?? undefined,
    parentPort,
    createRemotePromptAttachmentSessionService: (service) =>
      createRemotePromptAttachmentSessionService(service, {
        materializePromptAttachments,
      }),
    createRemotePromptAttachmentTaskService: (service) =>
      createRemotePromptAttachmentTaskService(service, {
        materializePromptAttachments,
      }),
    createReportingRemoteZCodeTaskService: (service) =>
      createReportingRemoteZCodeTaskService(service, {
        taskRealtimePort: activeSessionRealtimePort ?? undefined,
      }),
    promptAttachmentTransferService,
    runtimePreferencesBridge: {
      onError: (error: unknown) => logger.warn("remote runtime preferences bridge failed", error),
    },
  });

  let disposed = false;
  // 远端 workspace 的 CLI 与 MCP 样本走与本地同一条路径：远端 zcode-server → 本地 Host → main。
  // 订阅寿命等于这份远端 services 的寿命：由 connection handle 持有，registry 释放 entry
  // （WSL idle 回收、最后一个 logical session 关闭、掉线后的 session 清理）时随 dispose 一起收口。
  const resourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "remote",
    environmentKey: resolveResourceTelemetryEnvironmentKey(params.target),
    onError: (error) => logger.warn("remote resource telemetry subscription failed", error),
  });
  const remoteMediaPreviewFactory = !remoteMediaRangePreviewEnabled
    ? undefined
    : (scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>) =>
        createRemoteMediaPreviewProxy({
          fileService: services.get(IFileService),
          logger: {
            debug: (message, metadata) => {
              if (process.env.NODE_ENV !== "production") logger.info(message, metadata);
            },
            warn: (message, metadata) => logger.warn(message, metadata),
          },
          scope,
          requestLimiter: hostRemoteMediaRequestLimiter,
        });
  return {
    services,
    capabilities:
      "backend" in connection
        ? {
            browserRecordingUploader: connection.backend,
            ...(remoteMediaPreviewFactory ? { remoteMediaPreviewFactory } : {}),
            // 回环预览隧道（工单 08）：把对端 backend 的 openTcpTunnel 透给
            // Controller。绑定 this 到 backend —— 该方法内部访问 this.client，
            // 拆出来裸调会丢上下文。
            ...(connection.backend.openTcpTunnel
              ? {
                  openTcpTunnel: (options: { remoteHost: string; remotePort: number }) =>
                    connection.backend.openTcpTunnel!(options),
                }
              : {}),
          }
        : {},
    onDidClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      closeListeners.clear();
      resourceTelemetry.dispose();
      await disposeServiceResourcesAndWait(services);
      await disposeHostRemoteConnection(connection);
    },
  };
}

const windowRemoteConnectionRegistry = createWindowRemoteConnectionRegistry<
  ServiceCollection,
  HostRemoteConnectionCapabilities
>({
  connect: (request) => createWindowRemoteConnectionHandle(request),
  createId: randomUUID,
  releaseWorkspace: async (services, context) => {
    await services.get(IZCodeTaskService).releaseWorkspacePreparation({
      workspacePath: context.workspacePath,
      ...(context.workspaceIdentity ? { workspaceIdentity: context.workspaceIdentity } : {}),
      provider: "glm",
    });
    logger.info(
      `released WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
    );
  },
  onWorkspaceReleaseError: (context, error) => {
    logger.warn(
      `failed to release WSL workspace runtime, workspaceKey=${context.workspaceIdentity?.trim() || context.workspacePath}`,
      error,
    );
  },
  onSessionClosed: (event) => {
    // logical session 已离线时 attachment 仍持有旧 services/订阅；后续 sessionId
    // 换代只释放 transport，无法按旧 ID 找回这些端口。Host 在失效源头统一关闭所有 clientMode。
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(event.remoteSessionId);
    const session = windowRemoteConnectionRegistry.getSession(event.remoteSessionId);
    if (session?.workspacePath && session.workspaceIdentity) {
      windowHostControllerRuntime.disconnectSource({
        kind: "remote",
        remoteSessionId: event.remoteSessionId,
        workspacePath: session.workspacePath,
        workspaceIdentity: session.workspaceIdentity,
      });
    }
    parentPort?.postMessage({
      type: HostResponseTypes.RemoteWorkspaceClosed,
      remoteSessionId: event.remoteSessionId,
      reason: "connection-closed",
      exitCode: event.exitCode,
      signal: event.signal,
      ...(event.error ? { error: event.error } : {}),
    });
    logWindowHostTopology("remote-connection-closed");
  },
});

const windowHostControllerRuntime = createWindowHostControllerRuntime({
  createId: randomUUID,
  onSourceError: (scope, operation, error) => {
    logger.warn(
      `window Controller source ${operation} failed, scope=${scope.kind}, workspaceKey=${scope.workspaceIdentity?.trim() || scope.workspacePath}`,
      error,
    );
  },
  resolveSource: (scope) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (remoteSession?.workspacePath && remoteSession.workspaceIdentity) {
      const controllerScope = {
        kind: "remote" as const,
        remoteSessionId: remoteSession.remoteSessionId,
        workspacePath: remoteSession.workspacePath,
        workspaceIdentity: remoteSession.workspaceIdentity,
      };
      if (remoteSession.sourceAvailability !== "online") {
        return { scope: controllerScope, sourceAvailability: "offline" as const };
      }
      const services = windowRemoteConnectionRegistry.resolveScopedServices(controllerScope);
      return {
        scope: controllerScope,
        taskService: services.get(IZCodeTaskService),
        agentService: services.getOptional(IZCodeAgentService),
        sourceAvailability: "online" as const,
      };
    }
    // 远程 history scope 未连接或已被移除时，绝不能落回本地 tasks-index。
    if (scope.workspaceIdentity && isRemoteWorkspaceIdentity(scope.workspaceIdentity)) {
      return null;
    }
    const taskService = activeServices?.getOptional(IZCodeTaskService);
    if (!taskService) {
      return null;
    }
    return {
      scope: {
        kind: "local" as const,
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      },
      taskService,
      agentService: activeServices?.getOptional(IZCodeAgentService),
      sourceAvailability: "online" as const,
    };
  },
  /**
   * 回环预览隧道（工单 08）：把宿主手里对端 backend 的 forwardOut 能力，
   * 按 scope 暴露给 Controller。
   *
   * 只对已连接的远端 scope 生效；本地 scope 或对端不支持（非 SSH）时返回 null，
   * Controller 据此抛错让调用方退化 —— 不静默返回一个假的本地端口。
   */
  openTunnel: async (scope, remotePort) => {
    const remoteSession = windowRemoteConnectionRegistry.findSessionForWorkspace(scope);
    if (!remoteSession?.workspacePath || !remoteSession.workspaceIdentity) {
      return null;
    }
    const controllerScope = {
      kind: "remote" as const,
      remoteSessionId: remoteSession.remoteSessionId,
      workspacePath: remoteSession.workspacePath,
      workspaceIdentity: remoteSession.workspaceIdentity,
    };
    const capabilities =
      windowRemoteConnectionRegistry.resolveScopedCapabilities(controllerScope);
    if (!capabilities?.openTcpTunnel) {
      return null;
    }
    // 隧道固定转发到对端回环：预览/开发服务几乎都只 bind 127.0.0.1，
    // 允许调用方指定 remoteHost 会变成任意地址探测面，不必要。
    return capabilities.openTcpTunnel({ remoteHost: "127.0.0.1", remotePort });
  },
});

function wireLocalResourceTelemetry(services: ServiceCollection): void {
  activeLocalResourceTelemetry?.dispose();
  activeLocalResourceTelemetry = registerHostServiceResourceTelemetry({
    services,
    postMessage: (message) => parentPort?.postMessage(message),
    runtimeSurface: "local",
    onError: (error) => logger.warn("local resource telemetry subscription failed", error),
  });
}

function disposeLocalResourceTelemetry(): void {
  try {
    activeLocalResourceTelemetry?.dispose();
  } catch {
    // 资源遥测释放失败不能阻塞 Host 的既有 shutdown barrier。
  } finally {
    activeLocalResourceTelemetry = null;
  }
}

type ExposedServicePortHandle = {
  server: IChannelServer & { ready(): void };
  dispose(): void;
};

function createControllerRoutedTaskService(
  base: IZCodeTaskService,
  attachmentScope: WindowHostAttachmentScope,
): IZCodeTaskService {
  const route = async (
    params: {
      taskId: string;
      workspacePath: string;
      workspaceIdentity?: string;
    },
    mutation:
      | { kind: "pin"; pinned: boolean }
      | { kind: "archive"; archived: boolean }
      | { kind: "delete" }
      | { kind: "mark-read"; expectedUnreadAt?: number }
      | { kind: "mark-unread" },
  ) =>
    windowHostControllerRuntime.service.mutateTask({
      address: await windowHostControllerRuntime.resolveTaskAddress({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        attachmentScope,
      }),
      mutation,
    });

  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "setTaskPinned") {
        return async (params: Parameters<IZCodeTaskService["setTaskPinned"]>[0]) => {
          const meta = await route(params, { kind: "pin", pinned: params.pinned });
          if (!meta) throw new Error("pin mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "archiveTask" || property === "unarchiveTask") {
        return async (
          params:
            | Parameters<IZCodeTaskService["archiveTask"]>[0]
            | Parameters<IZCodeTaskService["unarchiveTask"]>[0],
        ) => {
          const meta = await route(params, {
            kind: "archive",
            archived: property === "archiveTask",
          });
          if (!meta) throw new Error("archive mutation 后 task 投影缺失");
          return meta;
        };
      }
      if (property === "deleteTask") {
        return async (params: Parameters<IZCodeTaskService["deleteTask"]>[0]) => {
          await route(params, { kind: "delete" });
        };
      }
      if (property === "deleteArchivedTasks") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTasks"]>[0]) => {
          if (params.taskIds.length === 0) {
            return { deletedTaskIds: [], skippedTaskIds: [], failedTaskIds: [] };
          }
          return windowHostControllerRuntime.service.deleteArchivedTasks({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              taskId: params.taskIds[0]!,
              attachmentScope,
              allowMissingTask: true,
            }),
            taskIds: params.taskIds,
          });
        };
      }
      if (property === "deleteArchivedTask") {
        return async (params: Parameters<IZCodeTaskService["deleteArchivedTask"]>[0]) =>
          windowHostControllerRuntime.service.deleteArchivedTask({
            address: await windowHostControllerRuntime.resolveTaskAddress({
              ...params,
              attachmentScope,
              allowMissingTask: true,
            }),
          });
      }
      if (property === "setTaskUnread") {
        return async (params: Parameters<IZCodeTaskService["setTaskUnread"]>[0]) => {
          const meta = await route(
            params,
            params.unread
              ? { kind: "mark-unread" }
              : {
                  kind: "mark-read",
                  ...(params.expectedUnreadAt != null
                    ? { expectedUnreadAt: params.expectedUnreadAt }
                    : {}),
                },
          );
          if (!meta) throw new Error("unread mutation 后 task 投影缺失");
          return meta;
        };
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function exposeServicesOnMessagePort(
  port: Electron.MessagePortMain,
  services: ServiceCollection,
  deferInit: boolean,
  clientMode: ZCodeAgentV4ClientMode = "desktop-continuous",
  attachmentScope: WindowHostAttachmentScope = { kind: "local" },
  capabilities?: HostRemoteConnectionCapabilities,
): ExposedServicePortHandle {
  const wrappedPort = wrapElectronPort(port);
  const protocol = new MessagePortProtocol(wrappedPort);
  // remote 模式延迟发送 Initialize：远程建连需要时间，如果构造时就发 Initialize，
  // renderer 会立即发请求但 channel 还没注册，导致 "Unknown channel" 超时错误。
  // attach 模式复用已就绪服务，必须立即初始化新的 RPC MessagePort。
  logger.info(`creating ChannelServer (deferInit=${deferInit})`);
  const rawServer = new ChannelServer(protocol, "host", 1000, deferInit);
  const loggedServer = new LoggingChannelServer(rawServer, logRpc);
  const server = new NetworkTelemetryChannelServer(loggedServer);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `host-rpc-${randomUUID()}`,
        clientMode,
      })
    : undefined;
  services.register(IWindowControllerService, windowHostControllerRuntime.service);
  const controllerAttachment = windowHostControllerRuntime.createAttachmentService();
  const overrides = new Map<string, unknown>([
    [IWindowControllerService.channelName, controllerAttachment],
  ]);
  // 远端媒体必须按 attachment 的 clientMode 选择数据面：桌面使用 Host loopback Range，手机保持 inline。
  const remoteMediaPreviewProxy =
    attachmentScope.kind === "remote" && clientMode === "desktop-continuous"
      ? capabilities?.remoteMediaPreviewFactory?.(attachmentScope)
      : undefined;
  if (remoteMediaPreviewProxy) {
    overrides.set(IMediaPreviewService.channelName, remoteMediaPreviewProxy.service);
  }
  const taskService = services.getOptional(IZCodeTaskService);
  if (taskService) {
    overrides.set(
      IZCodeTaskService.channelName,
      createControllerRoutedTaskService(taskService, attachmentScope),
    );
  }
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  const conversationShareService = services.getOptional(IConversationShareService);
  if (conversationShareService) {
    // Share service 若继续持有 raw Agent，会绕过当前 MessagePort 已握手的 trusted carrier，
    // rowsRange 会以 connection untrusted 拒绝。必须复用同一 attachment connection scope。
    overrides.set(
      IConversationShareService.channelName,
      scopeConversationShareServiceForAttachment(
        conversationShareService,
        clientMode,
        connectionScope?.service,
      ),
    );
  }
  // Provisioning 携带跨 Environment 凭据，只允许受信 Desktop Host 使用。
  // 本 host 暴露多个 attachment：桌面 UI / 投射端挂载是 desktop-continuous，
  // 手机与 Web 远控是 web-remote-replayable。与 server HTTP 面（http.ts 的同一道门控）
  // 共用同一份判定，非受信连接即使知道频道名也只能拿到抛错的桩。
  if (
    !isProviderProvisioningTrustedClientMode(clientMode) &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(
      IProviderProvisioningTargetService.channelName,
      createUntrustedProviderProvisioningTarget(),
    );
  }
  services.exposeOnChannelServer(server, overrides);
  let disposed = false;
  let flowUpdateChain = Promise.resolve();
  const forwardFlowState = (state: "saturated" | "drained" | "closed") => {
    if (!connectionScope) return Promise.resolve();
    const update = flowUpdateChain.then(() => connectionScope.setTransportFlowState(state));
    flowUpdateChain = update.catch((error) => {
      logger.warn("failed to forward attachment connection flow state", {
        state,
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return update;
  };
  const flowStateDisposable = protocol.onFlowState((state) => {
    if (disposed) return;
    // MessagePort sideband 已在 protocol 层与 Uint8Array 分流；这里只把 owning scope
    // 的 edge 串行送往 CLI，不能由 control object 指定 connectionId。
    void forwardFlowState(state).catch(() => {});
  });
  const handle: ExposedServicePortHandle = {
    server,
    dispose() {
      if (disposed) return;
      disposed = true;
      flowStateDisposable.dispose();
      controllerAttachment.dispose();
      void remoteMediaPreviewProxy?.dispose().catch((error: unknown) => {
        logger.warn("failed to dispose remote media preview proxy", error);
      });
      // close 排在所有已接收 SAT/DRN 之后；scope.dispose 自身会再次幂等确保 closed，
      // 但绝不让迟到 saturated 在 close 后复活 CLI pause state。
      void forwardFlowState("closed")
        .catch(() => {})
        .then(() => connectionScope?.dispose());
      rawServer.dispose();
      protocol.disconnect();
    },
  };
  port.once("close", () => handle.dispose());
  logger.info(`service connection ready mode=${clientMode}`);
  return handle;
}

const windowHostAttachmentRegistry = createWindowHostAttachmentRegistry<
  ServiceCollection,
  Electron.MessagePortMain,
  HostRemoteConnectionCapabilities
>({
  resolveScope: (scope: WindowHostAttachmentScope) => {
    if (scope.kind === "local") {
      if (!activeServices) {
        throw new Error("local services 尚未初始化");
      }
      return { services: activeServices, generation: 1 };
    }
    const session = windowRemoteConnectionRegistry.getSession(scope.remoteSessionId);
    if (!session) {
      throw new Error(`未找到远程 logical session，remoteSessionId=${scope.remoteSessionId}`);
    }
    return {
      services: windowRemoteConnectionRegistry.resolveScopedServices(scope),
      generation: session.generation,
      capabilities: windowRemoteConnectionRegistry.resolveScopedCapabilities(scope),
    };
  },
  expose: ({ port, services, clientMode, scope, capabilities }) =>
    exposeServicesOnMessagePort(port, services, false, clientMode, scope, capabilities),
});

function logWindowHostTopology(reason: string): void {
  const stats = windowRemoteConnectionRegistry.getStats();
  logger.info(
    `window Host topology, reason=${reason}, pid=${process.pid}, connections=${stats.connectionCount}, logicalSessions=${stats.logicalSessionCount}, attachments=${windowHostAttachmentRegistry.size()}`,
  );
}

function disposeAttachedServicePorts(): void {
  windowHostAttachmentRegistry.dispose();
}

async function disposeHostResources(reason: string): Promise<HostShutdownResult> {
  databaseStartup?.dispose();
  pendingStartupAttachments.clear();
  if (hasDisposedHostResources) {
    return (
      (await disposeHostResourcesInFlight) ?? {
        exitCode: 0,
        failedPhases: [],
        timedOutPhases: [],
      }
    );
  }
  hasDisposedHostResources = true;

  disposeHostResourcesInFlight = (async () => {
    logger.info(`disposing host resources, reason=${reason}`);

    stopHostNetworkTelemetry();
    hostSelfResourceTelemetry.stop();
    disposeLocalResourceTelemetry();
    // 先撤掉对外挂载与发现文件：本 host 即将退出，投射端应立刻看到"设备离线"，
    // 而不是继续连一个已死的端口。
    disposeResidentExposure();
    disposeAttachedServicePorts();
    windowHostControllerRuntime.dispose();
    for (const key of Array.from(cronRunSubscriptions.keys())) {
      disposeCronRunSubscription(key);
    }
    cronAutomationRepo.close();
    for (const key of Array.from(offPeakRunSubscriptions.keys())) {
      disposeOffPeakRunSubscription(key);
    }
    disposeOffPeakRuntime();
    offPeakTaskRepo.close();

    if (activeSessionRealtimePort) {
      activeSessionRealtimePort.dispose();
      activeSessionRealtimePort = null;
    }

    const servicesToDispose = activeServices;
    activeServices = null;
    // Registry 是全部远端 connection 的唯一 owner；释放失败不能阻塞本地服务继续收口。
    const shutdownResult = await runHostShutdownPhases(
      [
        {
          name: "remote-registry-dispose",
          run: () => windowRemoteConnectionRegistry.dispose(),
          timeoutMs: 6_000,
        },
        ...(servicesToDispose
          ? [
              {
                name: "service-dispose",
                run: () => disposeServiceResourcesAndWait(servicesToDispose),
                timeoutMs: 3_500,
              },
            ]
          : []),
      ],
      {
        phaseTimeoutMs: 5_000,
        log: (message, details) => logger.warn(message, details),
      },
    );
    if (shutdownResult.exitCode !== 0) {
      logger.warn("host resource cleanup completed with errors", {
        failedPhases: shutdownResult.failedPhases,
        reason,
        timedOutPhases: shutdownResult.timedOutPhases,
      });
    }
    activeHostApiNetworkTransport = null;
    return shutdownResult;
  })();

  const shutdownResult = await disposeHostResourcesInFlight;
  flushHostE2ECoverage((error) => {
    logger.warn("[e2e-coverage] host coverage flush failed", error);
  });
  return shutdownResult;
}

function disposeHostResourcesBestEffort(reason: string): void {
  if (hasDisposedHostResources) {
    return;
  }
  hasDisposedHostResources = true;

  logger.info(`disposing host resources, reason=${reason}`);
  stopHostNetworkTelemetry();
  disposeLocalResourceTelemetry();
  disposeAttachedServicePorts();
  windowHostControllerRuntime.dispose();
  for (const key of Array.from(cronRunSubscriptions.keys())) {
    disposeCronRunSubscription(key);
  }
  cronAutomationRepo.close();
  for (const key of Array.from(offPeakRunSubscriptions.keys())) {
    disposeOffPeakRunSubscription(key);
  }
  disposeOffPeakRuntime();
  offPeakTaskRepo.close();
  void windowRemoteConnectionRegistry.dispose();

  if (activeServices) {
    try {
      disposeServiceResources(activeServices);
    } catch (error) {
      logger.error("failed to dispose local services:", error);
    } finally {
      activeServices = null;
      activeHostApiNetworkTransport = null;
    }
  }

  if (activeSessionRealtimePort) {
    activeSessionRealtimePort.dispose();
    activeSessionRealtimePort = null;
  }
}

process.once("SIGTERM", () => {
  void disposeHostResources("SIGTERM").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("SIGINT", () => {
  void disposeHostResources("SIGINT").then(
    (result) => process.exit(result.exitCode),
    () => process.exit(1),
  );
});

process.once("disconnect", () => {
  // parent IPC 消失后不会再有人发送 Dispose；有界清理结束后必须明确退出，避免 Host 常驻。
  void disposeHostResources("disconnect").finally(() => process.exit(1));
});

process.once("exit", () => {
  disposeHostResourcesBestEffort("exit");
});

let handlingFatalUncaughtException = false;
process.on(
  "uncaughtException",
  createHostUncaughtExceptionHandler({
    onRecovered: (error, origin) => {
      const memoryUsage = process.memoryUsage();
      logger.warn("contained host allocation failure from native TLS callback", {
        arrayBuffers: memoryUsage.arrayBuffers,
        external: memoryUsage.external,
        heapUsed: memoryUsage.heapUsed,
        message: error.message,
        origin,
        rss: memoryUsage.rss,
      });
    },
    onFatal: (error, origin) => {
      if (handlingFatalUncaughtException) {
        process.exit(1);
      }
      handlingFatalUncaughtException = true;
      logger.error(`uncaughtException origin=${origin}:`, error);
      void disposeHostResources(`uncaughtException:${origin}`).finally(() => process.exit(1));
    },
  }),
);

/* ───────────────────────── 小队派发桥（**唯一**的派发路径） ─────────────────────────
   两条入口都走 `runSquadDispatch`：① 规则到点的 `squad-wake` 消息；② 队长派单（`squad/assign-work-item`）
   经服务面 hub 转来的派发请求。**只差 `trigger`**：规则触发必须指名规则（`planDispatch` 会留下
   `wake.rule_fired`，也是幂等四元组的一半）；**人发起豁免三道闸**（spec §5.5：`max_fires`/`loop`/`rate`
   只约束规则型），因此**不写、也不要求**任何唤醒规则 —— 这正是「指派不得先写一条唤醒规则」的落点。 */

/** 派发请求的触发源：规则触发带规则 id；人发起（含队长派单）没有。 */
type SquadDispatchTrigger = { trigger: "rule"; ruleId: string } | { trigger: "user" };

/** 一次派发的请求：消息形状的两路入口共用（`eventKey` 是幂等键里稳定的那一半，也是台账 runId）。 */
type SquadDispatchRequestMsg = SquadDispatchTrigger & {
  workItemId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  eventKey: string;
};

/** 派发结论：字段与线上 `HostResponseTypes.SquadWakeResult` 一一对应（规则路径原样回执给调度器）。 */
type SquadDispatchReport = {
  ok: boolean;
  error?: string;
  failureKind?: "transient" | "permanent" | "deferred";
  taskId?: string;
  sessionId?: string;
  /** 本次派发的 run 种类：**只进日志**，不上线（线上契约里没有这一维）。 */
  kind?: SquadDispatchKind;
};

/**
 * **唯一的小队派发实现**（host 派发桥的两路入口都调它）。
 *
 * 为什么必须只有一处：这里是「解析工作项与小队 → 决定派给谁 → 渲染简报 → 开树 → 建会话 → 订阅收口 →
 * 发 prompt」的全过程。两处实现迟早在判定次序/收口路径上分叉，而分叉的表现是「同一件事按哪条路进来
 * 结论不同」，且不报错。故规则路径与人发起路径**共用这一个**函数，只由 `trigger` 分流。
 *
 * 消息（请求）是**薄**的：调度器与服务面都不读小队定义（那是文件、由服务层拥有），规划只在这里做一次。
 */
async function runSquadDispatch(msg: SquadDispatchRequestMsg): Promise<SquadDispatchReport> {
  if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
    return { ok: false, error: "Local database startup is not ready", failureKind: "transient" };
  }
  const eventKey = msg.eventKey;
  /** 日志里的触发源标签：规则触发要指名规则；**人发起**（队长派单）没有规则（spec §5.5）。 */
  const triggerLabel = msg.trigger === "rule" ? `rule=${msg.ruleId}` : "trigger=user";
  /** planDispatch 的 ruleId 只在规则触发时给（人发起不写、也不要求任何规则）。 */
  const ruleId = msg.trigger === "rule" ? msg.ruleId : undefined;
  /* 本次派发是否**已经**在台账里留下自己的行（队员：`openMemberRun`；队长：`recordLeaderRun`）：
     派发中途失败时（如 createTask / 发 prompt 抛），那一行会留在 `open` —— 队员行对应的可能是一棵
     已建好的工作树，队长行虽无树但留在活跃集也会让「进行中」永真（§5.7(1) 的合并判据被架空）——
     两者都必须留痕（见外层 catch）。声明在 try 之外：catch 要读它。 */
  let ledgerRowRegistered = false;
  /* 本次派发登记的终态订阅键（`(taskId, traceId)`）。声明在 try 之外：catch 要在失败路径上解绑它
     —— 派发中途抛错时那次 run 的终态可能永远不来，订阅留着就残留到进程退出。
     **队员与队长共用这一个键**：两者在同一次派发里只有一个 run（kind 决定是哪一个）。 */
  let runSubscriptionKey: string | undefined;
  /* 失败出口要用、而 catch 在 try 之外的作用域，故按既有形态（`ledgerRowRegistered` 同款）声明在外：
     · `target` 只由 msg 算出（纯计算，不会抛）；
     · `squadRuntimeRef` 在 try 里拿到服务后回填；
     · `ledgerRowRegistered` 在队员开树 / 队长登记成功后回填（失败出口对两者都生效）。 */
  const target = { path: msg.workspacePath, identity: msg.workspaceIdentity ?? "" };
  let squadRuntimeRef: ISquadRuntimeService | undefined;
  /** 确定性失败（重试不会自愈）的结论：门禁关闭 / 运行时未注册 / 开树失败 / 数据契约违例。 */
  const failPermanent = (error: string): SquadDispatchReport => ({
    ok: false,
    error,
    failureKind: "permanent",
  });
  try {
    const targetServices = resolveAutomationTargetServices(msg);
    const squadRuntime = targetServices.getOptional(ISquadRuntimeService);
    if (!squadRuntime) {
      // 静默跳过会让用户看到「到点了但什么都没发生」，且没有任何线索指向「服务没注册」。
      logger.error("[squad] squad runtime service is not registered; squad wake dropped");
      return failPermanent("squad runtime service is not registered");
    }
    squadRuntimeRef = squadRuntime;

    // 门禁：判据在**服务层单点**（spec §5.7.6 的三个入口共用一处判据）。
    // 这里**不读 appSettings** —— 读一次就多一份判据，改一处漏一处，正是「关掉实验照旧派发」的形态。
    // 本调用只读设置、只抛错：**不中断在途 run**（不关会话、不动 squad_runs 行）。
    try {
      await squadRuntime.assertDispatchEnabled(target);
    } catch (error) {
      if (isSquadDispatchDisabledError(error)) {
        // permanent：关闭实验是确定性状态，重试不会自愈 —— 别让调度器按 transient 空转退避。
        return failPermanent(error instanceof Error ? error.message : String(error));
      }
      throw error;
    }

    // 规划（**唯一一处**）：工作项与小队都从服务面读，派发结论由 planDispatch 给
    // （用户指派 / 队长派单 / 规则触发三路共用同一处解析，spec §5.1）。
    const snapshot = await squadRuntime.getSnapshot(target);
    const workItem = snapshot.workItems.find((candidate) => candidate.id === msg.workItemId);
    if (!workItem) {
      return failPermanent(`work item not found: ${msg.workItemId}`);
    }
    const squad =
      workItem.assignee.type === "squad"
        ? (snapshot.squads.find((candidate) => candidate.id === workItem.assignee.id) ?? null)
        : null;
    /* **派发时的事实**（spec §6.1/§6.2）：本项的父项 —— 用来判「这是不是小队批次里的队员任务」
       （父项被指派给小队 ⇒ 队员 ⇒ 开工作树；否则是**单独安排的智能体** ⇒ 直接在工作区改）。
       从**同一份快照**取（`snapshot.workItems` 已按 workspace 过滤）：拿不到就是拿不到（`null`），
       由 `planDispatch` 按「没有在批次里的证据」处理 —— 本层不自己判类别（判据只有 `planDispatch` 一处）。 */
    const parentWorkItem = workItem.parentId
      ? (snapshot.workItems.find((candidate) => candidate.id === workItem.parentId) ?? null)
      : null;
    let events: ReturnType<typeof planDispatch>;
    try {
      events = planDispatch({
        workItem,
        squad,
        parentWorkItem,
        trigger: msg.trigger,
        ...(ruleId !== undefined ? { ruleId } : {}),
      });
    } catch (error) {
      /* `planDispatch` 的输入契约违例（工作项形状/小队定义不对）是**数据**问题：
         重投同一条事实会再次撞上同一个违例 —— 按 transient 退避是空转，按 permanent 收口并留痕。
         （只有「数据被改好」才会自愈，而那时是一条新的事实、新的 eventKey。） */
      logger.error(`[squad] planDispatch contract violation ${triggerLabel}`, error);
      return failPermanent(
        `planDispatch contract violation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const enqueued = events.find((event) => event.kind === "run.enqueued");
    if (enqueued?.kind !== "run.enqueued") {
      /* 没有 run（inbox.notified：指派给人 / 小队不存在 / 已归档 / 已停用）⇒ **skip 不是失败**。
         spec §3.9 的 dispatch_skipped 不进失败率：报成失败会让人去查一个并不存在的错误。 */
      const skip = events.find((event) => event.kind === "inbox.notified");
      logger.info(
        `[squad] wake skipped ${triggerLabel} workItem=${msg.workItemId}` +
          ` reason=${skip?.kind === "inbox.notified" ? skip.reason : "no dispatch event"}`,
      );
      return { ok: true };
    }

    const kind: SquadDispatchKind = enqueued.runClass;
    /* 台账 / 开树这一格按**类别**分流（`runClass` 是 `planDispatch` 给的显式判别字段）。为什么必须是
       显式三分类、不能靠 `isLeaderTask` 二分：那样**单独安排的智能体**（不在小队里的 agent，
       spec §6.1）会落进「非队长 ⇒ 开树」那条腿 —— 于是它也被塞进一条分支，而那条分支
       **永不合并、也永不被回收**（`activeBranches` 口径只覆盖小队命名空间），全程不报错。
       三类的动作由 `ledgerActionForRunClass` 一处查表（纯函数，可直接断言）：
         · 队员 ⇒ 开工作树 + 登记台账行（会话落在树里）；
         · 队长 ⇒ **只登记台账行**、**不开树**（§6.1/§6.2，队长在目标工作区执行）；
         · 单独安排 ⇒ **两者都不做**：直接在工作区改（§6.1）——没有工作树、没有分支、也没有台账行。 */
    let worktree: OpenMemberRunResult | undefined;
    const ledgerAction = ledgerActionForRunClass(kind);
    if (ledgerAction === "open_member_run") {
      try {
        worktree = await squadRuntime.openMemberRun(target, {
          runId: eventKey,
          workItemId: workItem.id,
          parentWorkItemId: workItem.parentId ?? workItem.id,
          agentId: enqueued.agentId,
          isLeaderTask: false,
        });
        ledgerRowRegistered = true;
      } catch (error) {
        // 开树失败是**确定性**失败（分支残枝 / base 不存在 / 目录冲突 ⇒ 重试撞「已存在」），
        // 按 permanent 回执，别让调度器按 transient 一直空转重试。
        return failPermanent(error instanceof Error ? error.message : String(error));
      }
    } else if (ledgerAction === "record_leader_run") {
      /* 队长 run 的**台账行**（spec §5.7(1)）：没有它就无法判「进行中」，`getSnapshot().runs`
         也看不见队长 run（「谁在被唤醒」这一格失真）。`recordLeaderRun` **只登记不执行** ——
         不开工作树（队长在目标工作区执行，spec §6.1/§6.2）、不改工作项状态（§5.7(2)）。
         `runId` 取 `eventKey`（幂等键的稳定一半）⇒ 同一事实重投不会生成第二条 run。
         台账行的 `is_leader_task=1` / `branch=null` 是它与队员行可区分的判据。 */
      try {
        await squadRuntime.recordLeaderRun(target, {
          runId: eventKey,
          workItemId: workItem.id,
          parentWorkItemId: workItem.parentId ?? workItem.id,
          agentId: enqueued.agentId,
        });
        ledgerRowRegistered = true;
      } catch (error) {
        /* 与开树失败同口径按 permanent 回执：主键冲突（同一 `eventKey` 已登记过）重投必然再撞，
           属确定性失败 —— 别让调度器按 transient 空转。响亮（带上原文）好过静默少一行台账。 */
        return failPermanent(error instanceof Error ? error.message : String(error));
      }
    }
    /* 单独安排（`ledgerAction === "none"`）刻意**什么都不做**，但**不是**「跳过这次派发」：
       §6.1 要的是「直接在工作区改」，所以下面的会话照发（落在 `msg.workspacePath`）。
       不给它台账行的理由见 `ledgerActionForRunClass` 的注释（台账是小队台账；它无分支 ⇒ 对
       `activeBranches` 零贡献；且它没有 merge/review 那一步，`completeMemberRun` 会把工作项推
       `in_review`（不存在的审查步骤），`completeLeaderRun` 又只收队长行 ⇒ 有行反而没有合法出口，
       只会把行永久留在 `open`（`listActive` 永不收缩，正是本项目一路在消灭的那种僵尸行）。 */
    const sessionWorkspacePath = worktree?.worktreePath ?? msg.workspacePath;

    /* 忙检查（硬约束 1）：**强探测** —— 读的是 Agent runtime 快照，不是 tasks-index 的投影
       （投影判据 `status === "running"` 会在崩溃/强杀留下的残留行上永久卡住派发，
       见 boundSessionBusyGate.ts:8-13 的自证）。复用 cron 的同一实现，不另写一套。
       只有「本次要落到一个**既有**会话」时才需要探测（新建会话不存在忙）——与 cron 的
       targetTaskId 路径同形；绑定会话来自 run 台账（重投同一 eventKey 时才有）。 */
    const boundSessionId =
      snapshot.runs.find((record) => record.runId === eventKey)?.sessionId ?? null;
    let busy = false;
    if (boundSessionId) {
      const agentService = targetServices.getOptional(IZCodeAgentService);
      if (agentService) {
        busy = await createBoundSessionExecutingProbe({
          agentService,
          logWarn: (message, error) => logger.warn(message, error),
        })({
          sessionId: boundSessionId,
          workspacePath: sessionWorkspacePath,
          ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
        });
      }
    }

    /* 队长 run 必须带简报（`planDispatch` 的小队分支总会给）：缺了就等于「队长起来了但不知道该干什么」，
       而空 prompt 的派发**不报错**——正是「跑起来了，但行为与产品语义对不上」那种最难查的形态。 */
    if (kind === "leader" && enqueued.briefing === undefined) {
      return failPermanent(`squad leader run has no briefing (${triggerLabel})`);
    }
    const decision = decideSquadDispatch({
      // 「服务层说可以派发」这一事实的搬运：上面那次 assertDispatchEnabled 已放行。
      // 门禁判据只有服务层一处，本文件（以及 desktop 的任何地方）都不读开关。
      dispatchEnabled: true,
      // 库就绪在上面已判过（phase !== "ready" 已回 transient）；传 true 让纯函数自洽可测。
      databaseReady: true,
      busy,
      kind,
      briefingPrompt: enqueued.briefing ? renderLeaderBriefingPrompt(enqueued.briefing) : "",
      memberPrompt: buildMemberRunPrompt(workItem),
      standalonePrompt: buildStandaloneRunPrompt(workItem),
      worktree,
    });
    if (decision.action === "defer") {
      // 等待型重投：抛出去由下面的 catch 翻成 deferred（照 CronRun 分支 `:2483` 的既有写法），
      // 不进调度器的 transient 重试预算 —— 否则长任务期间的唤醒会被重试上限判死而丢弃。
      throw new BoundSessionBusyError(boundSessionId ?? eventKey);
    }
    if (decision.action === "fail") {
      // 队员缺树：没有工作树就派发 = 队员直接改主工作区（spec §6.1 落空）——响亮失败。
      return failPermanent(`squad member run requires a worktree (${decision.reason})`);
    }
    if (decision.action === "skip") {
      // not_ready / disabled 已在上面拦掉，这里是防御性分支：skip 仍然**不是失败**。
      logger.info(
        `[squad] wake skipped ${triggerLabel} workItem=${msg.workItemId} reason=${decision.reason}`,
      );
      return { ok: true };
    }

    const zcodeTaskService = targetServices.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      /* 任务服务未注册是**确定性**状态（服务注册表在进程生命周期内不会长出这个服务），
         按 transient 退避只会一直空转 —— 与 cron 路径不同：那边是「写配置/会话失败」类的未知错误，
         这里是「环境缺件」。响亮 + permanent，别让这次唤醒在退避里转圈。 */
      logger.error("[squad] ZCode task service is not initialized; squad wake dropped");
      return failPermanent("ZCode task service is not initialized.");
    }
    // 幂等键的稳定一半当 trace：同一 eventKey 的重投落回同一个 trace，不会变成两次「新执行」。
    const traceId = eventKey as TraceId;
    const task = boundSessionId
      ? { taskId: boundSessionId }
      : await zcodeTaskService.createTask({
          workspacePath: sessionWorkspacePath,
          ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
        });
    if (boundSessionId) {
      // 绑定会话在 app 重启 / 切 workspace 后通常不在 active：先冷恢复再发 prompt，
      // 否则 sendPrompt 会立即报 Session is not active，看起来像「派发失败了」。
      await zcodeTaskService.resumeTask({
        taskId: task.taskId,
        workspacePath: sessionWorkspacePath,
        ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
      });
    }
    /* **会话回写台账**（裁定 Important-4）：`openMemberRun` 落台账时还不知道 sessionId（那时会话还没建），
       于是写 `null`；而上面的忙检查（硬约束 1 的强探测）与「重投复用同一会话」都从台账读 sessionId
       ⇒ 不回写就**恒为 null**，强探测与 `deferred` 分支在生产里永不可达（代码对、保护为零）。
       只对**队员** run 回写：队长 run 的台账行已在上面分叉里登记，但本次不补队长的会话绑定
       （那需要另一条写入口；队长 run 无工作树，忙检查/重投复用对它的收益见报告顾虑）。
       失败只 warn、不阻断本次派发：最坏后果是「下次重投另建一个会话」，而不是这次派发失败。 */
    if (kind === "member") {
      try {
        await squadRuntime.bindMemberRunSession(target, {
          runId: eventKey,
          sessionId: task.taskId,
        });
      } catch (error) {
        logger.warn(
          "[squad] member run 会话回写台账失败（下次重投会另建会话；忙检查这一格这次不可达）",
          error,
        );
      }
    }
    // 完成通知要在 sendPrompt **之前**订阅：先跑完再注册 listener 会漏掉终态（best-effort，失败只 warn）。
    watchSquadRunCompletion({
      zcodeTaskService,
      taskId: task.taskId,
      workspacePath: sessionWorkspacePath,
      ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
    });
    /* run 的终态收口（**闭环的最后一环**）：**有台账的那两类（队员与队长）都订阅** —— 它们都是
       **真实会话**，终态落在同一条既有出口上（`onDynamicTaskTerminalOutcome` + `outcome.inputId === traceId`）。
       差别只在「成功入账」那一格：
         · 队员 ⇒ `completeMemberRun`（产出入账 + 工作项推 `in_review`）；
         · 队长 ⇒ `completeLeaderRun`（**只把台账行移到终态**，不碰工作项 —— spec §5.7(2)
           「队长 run 不改父项状态」，套上 `completeMemberRun` 会写坏父项）。
       不订阅队长的后果就是旧缺口重演：成功的队长行长驻 `open` ⇒ §5.7(1)「进行中」**永真**。
       **单独安排的智能体不订阅**：它**没有台账行**（见 `ledgerActionForRunClass` 的理由），
       `completeMemberRun` / `failMemberRun` 都是「按 runId 动台账」的动作 —— 没有行可动，订阅只会
       在终态到达时去碰一行不存在的 run（`requireRun` 响亮抛）。它的会话照发（上面的 sendPrompt
       与 best-effort 完成通知都照旧），只是**没有台账可收口**。 */
    if (ledgerAction !== "none") {
      /* 订阅句柄**必须留一手**（照 cron 侧 `cronRunSubscriptions`）：这里订阅的是「这个 run 的终态」，
         而派发中途抛错时那个回调可能永远不来 ⇒ 句柄无主就残留到进程退出（本文件末尾的 catch 会解绑）。
         同一 (taskId, traceId) 先解绑旧的：重投同一 eventKey 时不要叠两条监听。 */
      const subscriptionKey = cronRunSubscriptionKey(task.taskId, traceId);
      disposeSquadRunSubscription(subscriptionKey);
      runSubscriptionKey = subscriptionKey;
      /** 本次派发的 run 类别标签：只用于日志与失败原因文案。三类各说各的，方便人按类别排查。 */
      const runLabel = kind === "leader" ? "队长" : kind === "member" ? "队员" : "单独安排";
      /* 句柄从**本处**发起订阅的返回值接住（`watch*RunSettlement` 自己不持有它，我们不去改那个文件）：
         接住之后既有成功终态的解绑，也有失败路径的解绑。**两种 run 共用这一个闭包** —— 终态规则
         （认轮 / 解绑 / 失败出口）一模一样，只有「成功入账」按 kind 分叉（见下面的两个 watch* 调用）。 */
      const subscribeTerminal = (listener: (outcome: SquadMemberRunTerminalOutcome) => void) => {
        const disposable = zcodeTaskService.onDynamicTaskTerminalOutcome(task.taskId)((
          outcome,
        ) => {
          // 本次派发的终态一到就解绑（含 failed/stopped —— 那也是一次「有信号」的收官）：
          // 不只在失败路径解绑，正常收官同样不该把监听留到进程退出。
          if (outcome.inputId === traceId) {
            disposeSquadRunSubscription(subscriptionKey);
          }
          /* **失败/中止的 run 必须有出口**（裁定 Important-3）：否则它永远算「活跃」（`listActive`）
             ⇒ 它占着的工作树与分支**永不被回收**（S15 未达）；队长行虽无树，留在活跃集会让 §5.7(1)
             的「进行中」**永真**（重复指派被永久合并）。成功那一支由 `watch*RunSettlement` 走对应入账，
             这里只管「**没有产出**」这一支（`failed` / `stopped`）—— 两种 run 走同一条出口
             （`failMemberRun` 的契约是「这条 run」，不是身份限制）。只改台账状态（`discarded`），
             树/分支交给启动回收器按「不在活跃集」回收（spec §6.6）。失败只 error 留痕：出口没生效时
             那个 run 会一直停在活跃集，必须看得见。 */
          if (outcome.inputId === traceId && outcome.outcome !== "succeeded") {
            void squadRuntime
              .failMemberRun(target, {
                runId: eventKey,
                reason:
                  `${runLabel}会话终态=${outcome.outcome}` +
                  (outcome.error ? `：${outcome.error}` : ""),
              })
              .catch((error: unknown) =>
                logger.error(
                  `[squad] ${runLabel} run 失败出口未生效：${eventKey} 仍停在活跃集`,
                  error,
                ),
              );
          }
          listener(outcome);
        });
        squadRunSubscriptions.set(subscriptionKey, disposable);
        return disposable;
      };
      // 收尾**不过门禁**（服务面明文：收尾在途 run 不属「新派发」），关掉实验照旧收口。
      if (kind === "member") {
        watchMemberRunSettlement({
          runId: eventKey,
          traceId,
          subscribe: subscribeTerminal,
          completeMemberRun: (runId) => squadRuntime.completeMemberRun(target, { runId }),
          logInfo: (message) => logger.info(message),
          logError: (message, error) => logger.error(message, error),
        });
      } else if (kind === "leader") {
        /* 队长 run 的成功入账：`completeLeaderRun` **只把台账行移到终态**（不碰工作项 — §5.7(2)）。
           它与队员共用上面的订阅闭包 ⇒ 队长 run 的终态（成功 / 失败 / 中止）真的被写回。 */
        watchLeaderRunSettlement({
          runId: eventKey,
          traceId,
          subscribe: subscribeTerminal,
          completeLeaderRun: (runId) => squadRuntime.completeLeaderRun(target, { runId }),
          logInfo: (message) => logger.info(message),
          logError: (message, error) => logger.error(message, error),
        });
      }
    }
    await zcodeTaskService.sendPrompt({
      taskId: task.taskId,
      traceId,
      content: decision.prompt,
      clientMode: "desktop-continuous",
    });
    /* 三条路径都落在了各自该落的地方（`ledgerActionForRunClass` 一处查表）：
         · 队员 ⇒ 台账行已写（`openMemberRun`）+ 终态收口接上（`completeMemberRun` 推到 `produced`，
           这正是冻结面对 `completeMemberRun` 写明的调用者「host 派发桥」）；
         · 队长 ⇒ 台账行已写（`recordLeaderRun`）+ 收口接上（`completeLeaderRun` 推到终态 `merged`，不碰工作项）；
         · 单独安排 ⇒ **没有台账行**、也没有收口（无行可收）—— 但会话照发、直接落在目标工作区（§6.1）。
       失败/中止只有前两类走 `failMemberRun` 移出活跃集（第三类没有行可移）。 */
    logger.info(
      `[squad] dispatch completed ${triggerLabel} workItem=${msg.workItemId} kind=${kind}` +
        ` eventKey=${eventKey} task=${task.taskId}`,
    );
    return { ok: true, taskId: task.taskId, sessionId: task.taskId, kind };
  } catch (error) {
    /* 派发中途失败（createTask / resumeTask / sendPrompt 抛）时的归宿：
       回执照旧发给调度器（transient ⇒ 它会重投同一条事实），但**台账侧**要留痕 ——
       刚登记的 run 行会停在 `open`（没有终态可订阅，收口那一步根本没跑到）。
       静默停在 open 会让它永远算「活跃」：队员的工作树与分支不会被回收；队长行虽无树，但留在活跃集
       会让 §5.7(1) 的「进行中」**永真**（重复指派被永远合并）—— 两种都必须留痕，没人知道为什么。
       **单独安排不在这一格里**（`ledgerRowRegistered` 恒为 false）：它没有台账行，无从「停在 open」。 */
    /* **失败 run 的出口**（裁定 Important-3）：只要台账里真有这一行（队员 `openMemberRun` / 队长
       `recordLeaderRun` 都已落行）就把它**移出活跃集**，别让它永远停在 open。
       为什么先读一次快照再决定：行不存在时 `failMemberRun` 会**响亮抛**（未命中不得静默），
       而「这次失败发生在建台账之前」（如门禁 / 规划 / 注册失败）是**正常**的，不该变成误导的 error。
       **为什么覆盖队长行**：队长行的存在意义就是「进行中」的判据，停在 open 会让该判据永真。
       `failMemberRun` 只把**未产出**的 run 置 `discarded`（不碰 git），对队长行同样安全——
       队长行本就无分支可丢；它的措辞里的「队员」按契约是「这条 run」，不是身份限制。
       **等待型（deferred）不在出口范围内**：那是「等一会再投」的重投，不是失败，run 要留下来被复用。 */
    const deferred = error instanceof BoundSessionBusyError;
    if (ledgerRowRegistered && !deferred && squadRuntimeRef) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        const rows = (await squadRuntimeRef.getSnapshot(target)).runs;
        if (rows.some((record: { runId: string }) => record.runId === eventKey)) {
          await squadRuntimeRef.failMemberRun(target, { runId: eventKey, reason });
          logger.error(
            `[squad] run 已按失败收口（离开活跃集；队员的树/分支交给启动回收，队长无树）` +
              ` runId=${eventKey} ${triggerLabel}`,
            error,
          );
        } else if (ledgerRowRegistered) {
          // 理论上不会到这（登记过就一定有台账行）：留一条，免得将来这两处判据漂移时变成静默。
          logger.error(
            `[squad] run 台账行缺失、无法收口 runId=${eventKey} ${triggerLabel}`,
            error,
          );
        }
      } catch (failError) {
        // 出口没生效 = 这个 run 会一直停在活跃集：必须响亮（带原文），不能静默。
        logger.error(
          `[squad] run 失败出口未生效：${eventKey} 仍停在 open（服务面 failMemberRun 失败）`,
          failError,
        );
      }
    } else if (ledgerRowRegistered) {
      logger.error(
        `[squad] run 停在 open：派发中途失败 runId=${eventKey} ${triggerLabel}` +
          (deferred ? "（等待型重投，保留该 run 复用）" : ""),
        error,
      );
    }
    /* **失败路径也要解绑**（照 cron 侧在失败/终态后 dispose 的形态）：这次派发已经失败，
       而它订阅的「这个 run 的终态」可能**永远不来**（run 停在 open，本就无出口）⇒
       订阅留着就残留到进程退出（每次失败的派发多一条）。defer 分支在订阅**之前**就抛，
       故那条路径上 `runSubscriptionKey` 仍是 undefined，下一次重投会照常订阅。 */
    if (runSubscriptionKey !== undefined) {
      disposeSquadRunSubscription(runSubscriptionKey);
      runSubscriptionKey = undefined;
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      failureKind: error instanceof BoundSessionBusyError ? "deferred" : "transient",
    };
  }

}

/**
 * 队长派单（`squad/assign-work-item`）产生的派发请求 —— **与「人手动触发」同一条路径**
 *（spec §5.5：人发起豁免三道闸，故 `trigger: "user"`、不写任何唤醒规则；2026-10-02 第 2 轮裁定）。
 *
 * 由组合根把服务面的派发 hub**订一次**之后转到这里（`createLocalServices` 的 `onSquadDispatchRequested`）：
 * runtime 按目标现构、其事件订阅表在实例内部 ⇒ 常驻侧订不到，故这一格改由 hub 承载（落点 ii）。
 *
 * **结果必须可见**（不得静默吞掉）：成功/跳过/失败都留一条带 `workItemId` 的日志。这条路径**没有**
 * 调度器的重投表可回执，也不自动重试 —— 那条 error 日志就是人（或下一次工具调用）据以动手的依据。
 */
async function dispatchSquadAssignment(request: SquadDispatchRequest): Promise<void> {
  /* `eventKey` 是这次派发的身份（台账 runId / trace）：人发起没有规则 tick，故这里**现造**一个。
     同一 (工作项, 队员) 再派一次会撞工作树分支名而**响亮失败**（响亮 > 静默重复，§5.7.7 属 P2c）。 */
  const eventKey = `assign:${request.workItemId}:${request.agentId}:${randomUUID()}`;
  const report = await runSquadDispatch({
    trigger: "user",
    workItemId: request.workItemId,
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
    eventKey,
  });
  if (report.ok) {
    logger.info(
      `[squad] 指派派发完成 workItem=${request.workItemId} agent=${request.agentId} runId=${eventKey}` +
        (report.taskId !== undefined ? ` task=${report.taskId}` : "") +
        (report.kind !== undefined ? ` kind=${report.kind}` : " (skip)"),
    );
    return;
  }
  logger.error(
    `[squad] 指派派发失败 workItem=${request.workItemId} agent=${request.agentId}` +
      ` runId=${eventKey} failureKind=${report.failureKind ?? "unknown"}`,
    report.error,
  );
}

parentPort.on("message", async (e: Electron.MessageEvent) => {
  const result = parseHostIncomingMessageEvent(e);
  if (!result.success) {
    logger.error("invalid parentPort message:", formatZodError(result.error));
    return;
  }

  const msg = result.data;
  const port = e.ports[0];
  if (msg.type === HostMessageTypes.DatabaseStartupControl) {
    if (msg.control.action === "snapshot") databaseStartup?.coordinator.publish();
    else if (msg.control.action === "retry")
      void databaseStartup?.coordinator.retry(msg.control.attemptId);
    return;
  }

  if (msg.type === HostMessageTypes.CuaPipFocusChanged) {
    const service = activeServices?.getOptional(ICuaPipSessionService);
    if (service) {
      void service.publishFocus(msg.event);
    } else {
      // 取不到服务时过去静默丢弃，focus-changed 于是从链路上凭空消失
      // （dev 实测 0 条，正式包同期 92 条）。补这条才能把「main 没发」与
      // 「host 收到了但服务没注册」分开。
      logger.warn("[cua-pip-session] focus event dropped: service unavailable");
    }
    return;
  }

  if (msg.type === HostMessageTypes.ResourceUsageSnapshotRequest) {
    void hostResourceUsageResponder.handleRequest(msg);
    return;
  }
  if (msg.type === HostMessageTypes.ResourceUsageSnapshotCancel) {
    hostResourceUsageResponder.cancelRequest(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.FeedbackLogArchiveResult) {
    const pending = pendingFeedbackLogArchiveRequests.get(msg.requestId);
    if (!pending) {
      return;
    }
    pendingFeedbackLogArchiveRequests.delete(msg.requestId);
    if (msg.ok && msg.path && typeof msg.size === "number") {
      pending.onProgress?.({ processedBytes: msg.size, totalBytes: msg.size });
      pending.resolve({ path: msg.path, size: msg.size });
      return;
    }
    pending.reject(new Error(msg.error ?? "反馈日志归档创建失败"));
    return;
  }

  if (msg.type === HostMessageTypes.LocalMediaPreviewPathAuthorizeResult) {
    const pending = pendingLocalMediaPreviewPathAuthorizations.get(msg.requestId);
    if (!pending) return;
    pendingLocalMediaPreviewPathAuthorizations.delete(msg.requestId);
    if (msg.ok && msg.path) {
      logger.info("local media preview path authorization OK");
      pending.resolve(msg.path);
    } else {
      pending.reject(new Error(msg.error ?? "本地视频预览路径授权失败"));
    }
    return;
  }

  if (msg.type === HostMessageTypes.CronRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.CronRunResult,
        runId: msg.runId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchCronRun({
          ...msg,
          mode: msg.mode as ZCodeTaskMode | undefined,
        });
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.CronRunResult,
          runId: msg.runId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // 绑定会话正在执行 ⇒ deferred：等待型重投，不消耗调度器的重试预算，
          // 避免长任务期间提醒被 transient 上限（5 次）判死而丢弃。
          failureKind: error instanceof BoundSessionBusyError ? "deferred" : "transient",
        });
      }
    })();
    return;
  }

  if (msg.type === HostMessageTypes.OffPeakRun) {
    if (databaseStartup?.coordinator.snapshot.phase !== "ready") {
      parentPort.postMessage({
        type: HostResponseTypes.OffPeakRunResult,
        offPeakTaskId: msg.offPeakTaskId,
        ok: false,
        error: "Local database startup is not ready",
        failureKind: "transient",
      });
      return;
    }
    void (async () => {
      try {
        const dispatchResult = await dispatchOffPeakRun(msg);
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: true,
          ...dispatchResult,
        });
      } catch (error) {
        parentPort.postMessage({
          type: HostResponseTypes.OffPeakRunResult,
          offPeakTaskId: msg.offPeakTaskId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          // 确定性模型/凭证配置错误重试不会自愈；交给 scheduler 转 failed，
          // 未知及生命周期错误仍按 transient 保持原退避语义。
          failureKind: error instanceof OffPeakPermanentDispatchError ? "permanent" : "transient",
        });
      }
    })();
    return;
  }

  // 唤醒规则到点（spec §5.7.1 / §5.7.6 / §6.1）。消息是**薄**的（只有「哪条规则到点了」）——
  // 规划（解析工作项与小队、决定派给谁、渲染简报、开树）一律在 `runSquadDispatch` 里做：
  // 调度器不读小队定义（那是文件、由服务层拥有），否则同一份规划会有两份实现且漂移时不报错。
  // 结果按既有契约原样回执给调度器（`ruleId` + `eventKey` 定位「已请求未结算」的重投记录）。
  if (msg.type === HostMessageTypes.SquadWake) {
    void (async () => {
      const report = await runSquadDispatch({
        trigger: "rule",
        ruleId: msg.ruleId,
        workItemId: msg.workItemId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
        eventKey: msg.eventKey,
      });
      parentPort.postMessage({
        type: HostResponseTypes.SquadWakeResult,
        ruleId: msg.ruleId,
        runId: msg.eventKey,
        ok: report.ok,
        ...(report.error !== undefined ? { error: report.error } : {}),
        ...(report.failureKind !== undefined ? { failureKind: report.failureKind } : {}),
        ...(report.taskId !== undefined ? { taskId: report.taskId } : {}),
        ...(report.sessionId !== undefined ? { sessionId: report.sessionId } : {}),
      });
    })();
    return;
  }

  if (msg.type === HostMessageTypes.BrowserExecuteResult) {
    // main 的 WebContentsView+CDP 执行完 browser 命令，按 requestId 关联回 bridge 的 pending。
    void browserControlMainBridge.handleResult({
      requestId: msg.requestId,
      result: msg.result,
    });
    return;
  }

  if (msg.type === HostMessageTypes.Dispose) {
    // main 进程通知清理（窗口关闭 / app 退出时）
    // 这里必须等待统一资源清理完成（含异步收尾写回），再让进程退出；main 侧仍有强杀 timer 兜底。
    const result = await disposeHostResources("parent dispose");
    process.exit(result.exitCode);
    return;
  }

  if (msg.type === HostMessageTypes.Broadcast) {
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliver) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      parentPort.postMessage({
        type: HostResponseTypes.SessionMessageDeliverResult,
        result: {
          error: "ZCode task service is not initialized.",
          messageId: msg.request.messageId,
          requestId: msg.request.requestId,
          sessionId: msg.request.fromSessionId,
          status: "failed",
        },
      });
      return;
    }

    void zcodeTaskService
      .deliverSessionMessage(msg.request)
      .then((deliveryResult) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: deliveryResult,
        });
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.SessionMessageDeliverResult,
          result: {
            error: error instanceof Error ? error.message : String(error),
            messageId: msg.request.messageId,
            requestId: msg.request.requestId,
            sessionId: msg.request.fromSessionId,
            status: "failed",
          },
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.SessionMessageDeliveryResult) {
    const zcodeTaskService = activeServices?.getOptional(IZCodeTaskService);
    if (!zcodeTaskService) {
      logger.warn("session message delivery result received before ZCode task service initialized");
      return;
    }
    void zcodeTaskService.sendSessionMessageDeliveryResult(msg.result).catch((error) => {
      logger.warn("failed to forward session message delivery result:", error);
    });
    return;
  }

  if (msg.type === HostMessageTypes.ProviderProvisioningExecute) {
    const session = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (
      !session ||
      !session.workspaceIdentity ||
      buildRemoteEnvironmentKey(session.target) !== msg.environmentKey
    ) {
      parentPort.postMessage({
        type: HostResponseTypes.ProviderProvisioningExecutionResult,
        requestId: msg.requestId,
        environmentKey: msg.environmentKey,
        status: "failed",
        error: "Remote Environment registration 已失效",
      });
      return;
    }
    const scope = {
      kind: "remote",
      remoteSessionId: session.remoteSessionId,
      workspacePath: session.workspacePath ?? "/",
      workspaceIdentity: session.workspaceIdentity,
    } as const;
    void Promise.resolve()
      .then(() =>
        (() => {
          const provisioningService = getRemoteProviderProvisioningExecutor(
            windowRemoteConnectionRegistry.resolveScopedServices(scope),
          );
          if (!provisioningService) {
            throw new Error("Remote Environment 不支持 Provider Provisioning");
          }
          return provisioningService.syncLocalToRemote();
        })(),
      )
      .then((result) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: result.status,
          ...(result.errorMessage ? { error: result.errorMessage } : {}),
        });
      })
      .catch((error: unknown) => {
        parentPort.postMessage({
          type: HostResponseTypes.ProviderProvisioningExecutionResult,
          requestId: msg.requestId,
          environmentKey: msg.environmentKey,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.ConnectRemoteWorkspace) {
    const workspacePath = msg.workspacePath ?? "/";
    const workspaceIdentity =
      msg.workspaceIdentity ?? buildRemoteWorkspaceIdentity(workspacePath, msg.target);
    logger.info(
      `connecting window-scoped remote source, requestId=${msg.requestId}, target=${formatRemoteTargetForLog(msg.target)}`,
    );
    void remoteConnectionProgressContext
      .run(msg.requestId, () =>
        windowRemoteConnectionRegistry.connect({
          requestId: msg.requestId,
          target: msg.target,
          remoteAssets: msg.remoteAssets,
          workspacePath,
          workspaceIdentity,
        }),
      )
      .then(async (descriptor) => {
        const replacedOfflineSessions = windowRemoteConnectionRegistry
          .listSessions()
          .filter(
            (session) =>
              session.remoteSessionId !== descriptor.remoteSessionId &&
              session.state === "disconnected" &&
              session.workspacePath === descriptor.workspacePath &&
              session.workspaceIdentity === descriptor.workspaceIdentity,
          );
        for (const replaced of replacedOfflineSessions) {
          if (replaced.workspacePath && replaced.workspaceIdentity) {
            const previousScope = {
              kind: "remote",
              remoteSessionId: replaced.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            const nextScope = {
              kind: "remote",
              remoteSessionId: descriptor.remoteSessionId,
              workspacePath: replaced.workspacePath,
              workspaceIdentity: replaced.workspaceIdentity,
            } as const;
            try {
              const services = windowRemoteConnectionRegistry.resolveScopedServices(nextScope);
              await windowHostControllerRuntime.replaceDisconnectedSource(previousScope, {
                scope: nextScope,
                taskService: services.get(IZCodeTaskService),
                sourceAvailability: "online",
              });
            } catch (error) {
              // source 已连接但 task-index 暂时不可读时不能回滚 transport，也不能删除上一代
              // 离线可信投影。Controller 会保留 pending replacement，后续 query 成功后原子替换。
              logger.warn("failed to atomically replace disconnected Controller source", error);
            }
          }
          windowHostAttachmentRegistry.detachRemoteSessionAttachments(replaced.remoteSessionId);
          await windowRemoteConnectionRegistry.disposeSession(replaced.remoteSessionId);
          // 重连替换后旧 remoteSessionId 已不再可 attachment；同步清理 Main 的端口请求关联，
          // 但不向 Renderer 伪报一次新的 transport failure。
          parentPort.postMessage({
            type: HostResponseTypes.RemoteWorkspaceClosed,
            remoteSessionId: replaced.remoteSessionId,
            reason: "disposed",
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnected,
          requestId: msg.requestId,
          descriptor,
        });
        logWindowHostTopology("remote-connected");
      })
      .catch((error) => {
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceConnectFailed,
          requestId: msg.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return;
  }

  if (msg.type === HostMessageTypes.CancelRemoteWorkspaceConnect) {
    windowRemoteConnectionRegistry.cancelConnect(msg.requestId);
    return;
  }

  if (msg.type === HostMessageTypes.BindRemoteWorkspaceContext) {
    const previous = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    let workspaceReady: Promise<void>;
    try {
      workspaceReady = windowRemoteConnectionRegistry.bindWorkspaceContext({
        remoteSessionId: msg.remoteSessionId,
        workspacePath: msg.workspacePath,
        workspaceIdentity: msg.workspaceIdentity,
      });
    } catch (error) {
      logger.warn(
        `failed to bind remote workspace context, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
      return;
    }
    const current = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    if (current) {
      // scope generation 换代后，旧 Renderer/手机 attachment 不得继续持有远端 IO facade。
      windowHostAttachmentRegistry.detachStaleRemoteSessionAttachments(
        msg.remoteSessionId,
        current.generation,
      );
    }
    void workspaceReady.catch((error) => {
      logger.warn(
        `failed to prepare bound remote workspace, remoteSessionId=${msg.remoteSessionId}`,
        error,
      );
    });
    if (previous?.workspacePath && previous.workspaceIdentity) {
      windowHostControllerRuntime.removeSource({
        kind: "remote",
        remoteSessionId: msg.remoteSessionId,
        workspacePath: previous.workspacePath,
        workspaceIdentity: previous.workspaceIdentity,
      });
    }
    logger.info(
      `bound remote workspace context, remoteSessionId=${msg.remoteSessionId}, workspacePath=${msg.workspacePath}`,
    );
    return;
  }

  if (msg.type === HostMessageTypes.DisposeRemoteWorkspaceSession) {
    const disposedSession = windowRemoteConnectionRegistry.getSession(msg.remoteSessionId);
    windowHostAttachmentRegistry.detachRemoteSessionAttachments(msg.remoteSessionId);
    void windowRemoteConnectionRegistry
      .disposeSession(msg.remoteSessionId)
      .then(() => {
        if (disposedSession?.workspacePath && disposedSession.workspaceIdentity) {
          windowHostControllerRuntime.removeSource({
            kind: "remote",
            remoteSessionId: msg.remoteSessionId,
            workspacePath: disposedSession.workspacePath,
            workspaceIdentity: disposedSession.workspaceIdentity,
          });
        }
        parentPort.postMessage({
          type: HostResponseTypes.RemoteWorkspaceClosed,
          remoteSessionId: msg.remoteSessionId,
          reason: "disposed",
        });
        logWindowHostTopology("remote-session-disposed");
      })
      .catch((error) => {
        logger.warn(
          `failed to dispose remote logical session, remoteSessionId=${msg.remoteSessionId}`,
          error,
        );
      });
    return;
  }

  if (
    msg.type === HostMessageTypes.BotRemoteWorkspaceReconnectResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceConnectionStatusResult ||
    msg.type === HostMessageTypes.BotRemoteWorkspaceRuntimePort
  ) {
    // Bugfix: Bot bridge 也监听 parentPort，main 回传的 runtime MessagePort 是给 Bot 作为
    // 远端 RPC client 使用的。host 入口必须跳过这些控制消息，避免误把同一个端口注册成 ChannelServer。
    return;
  }

  if (msg.type === HostMessageTypes.AttachServicePort) {
    if (!port) {
      logger.error("attach-service-port message missing MessagePort");
      return;
    }
    if (msg.scope.kind === "local" && databaseStartup?.coordinator.snapshot.phase !== "ready") {
      // 刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者。
      pendingStartupAttachments.set(msg.attachmentId, () => {
        windowHostAttachmentRegistry.attach({ ...msg, port });
      });
      port.once("close", () => pendingStartupAttachments.delete(msg.attachmentId));
      return;
    }
    try {
      if (msg.scope.kind === "remote") {
        // Bind 与 Attach 共用 parentPort，但 WSL 上一代 workspace release 可能仍在途。
        // 持有已转移 port 等待 Host 内 generation barrier，避免新 attachment 踩过旧 runtime 清理。
        await windowRemoteConnectionRegistry.waitForScopedServices(msg.scope);
      }
      windowHostAttachmentRegistry.attach({
        requestId: msg.requestId,
        attachmentId: msg.attachmentId,
        clientMode: msg.clientMode,
        scope: msg.scope,
        port,
      });
      logger.info(
        `attached scoped service port, attachmentId=${msg.attachmentId}, scope=${msg.scope.kind}, clientMode=${msg.clientMode}`,
      );
      logWindowHostTopology("attachment-added");
    } catch (error) {
      // 跨 logical session 或旧 identity 的 port 若继续暴露，会把远端请求路由到错误 source。
      // scope 校验失败必须关闭已转移端口并明确记录，禁止回退 active local services。
      rejectUnavailableAttachedServicePort(port, false);
      logger.warn(`failed to attach scoped service port, attachmentId=${msg.attachmentId}`, error);
    }
    return;
  }

  if (msg.type === HostMessageTypes.DetachServicePort) {
    pendingStartupAttachments.delete(msg.attachmentId);
    windowHostAttachmentRegistry.detach(msg.attachmentId);
    logger.info(`detached service port, attachmentId=${msg.attachmentId}`);
    logWindowHostTopology("attachment-removed");
    return;
  }

  if (!port) {
    return;
  }

  if (msg.type === HostMessageTypes.InitLocal) {
    if (!port) {
      logger.error("init-local message missing MessagePort");
      return;
    }
    if (databaseStartup) {
      port.close();
      databaseStartup.coordinator.publish();
      return;
    }
    let basePortClosed = false;
    port.once("close", () => {
      basePortClosed = true;
    });
    databaseStartup = createHostDatabaseStartup({
      startupId: msg.databaseStartupId,
      cwd: msg.agentSpawnFallbackCwd ?? process.cwd(),
      workingDirectories:
        msg.agentWarmupTargets?.map((target) => target.workspacePath) ??
        (msg.workspacePath ? [msg.workspacePath] : []),
      env: msg.runtimeProcessEnvPatch,
      publish: (state) => {
        parentPort?.postMessage({ type: HostResponseTypes.DatabaseStartupState, state });
        if (state.phase === "ready") {
          for (const attach of pendingStartupAttachments.values()) {
            try {
              attach();
            } catch (error) {
              logger.warn("startup attachment failed", error);
            }
          }
          pendingStartupAttachments.clear();
          /* 启动回收（spec §6.4 / §6.6）：**只在 database startup ready 之后**、且**异步**不阻塞 UI
             （回收要起 git 子进程）。孤儿工作树会占住分支名 ⇒ 清理是重派发的正确性前置。
             候选 workspace 取本次启动的预热名单（main 已按最近使用顺序限为 3 个）：恰好一个才回收，
             否则 `resolveSquadWorkspaceBinding` 列出候选后抛，本处响亮记日志并跳过（多 workspace 属 P2c）。
             `void` 它：回收失败不能阻断启动，但内部**会带原文 warn**，不是静默。 */
          if (!squadStartupRecoveryStarted) {
            squadStartupRecoveryStarted = true;
            const candidates = (
              msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
                ? msg.agentWarmupTargets
                : msg.workspacePath
                  ? [
                      {
                        workspacePath: msg.workspacePath,
                        ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                      },
                    ]
                  : []
            ).map((candidate) => ({
              path: candidate.workspacePath,
              identity: candidate.workspaceIdentity ?? "",
            }));
            /* 次序是**契约**（Important-2）：**重驱先于回收**。重驱会把未收尾的批 finalize（清掉它的
               集成分支与已 `merged` 的队员分支）；而回收把「不在活跃集」的队员分支当孤儿删 ——
               `merged` 恰不在活跃集。若先回收，这一批的队员分支会在重驱之前被删掉，
               重驱随后撞「分支不存在」而失败（§6.6/S15 要救的那批成果就真没了）。 */
            void (async () => {
              await replayUnfinalizedBatchesBestEffort(activeServices, candidates);
              await reapStartupOrphansBestEffort(activeServices, candidates);
            })();
          }
        }
      },
      onFailure: (error) =>
        logger.error(
          `local database startup failed attempt=${databaseStartup?.coordinator.snapshot.attemptId}`,
          error,
        ),
      initializeServices: async () => {
        logger.info("initializing local services");
        activeSessionRealtimePort = createTaskRealtimeBridgeForHostInit(msg, parentPort);
        // 旧 Team 补组织必须与网络代理读取共用同一个 Setting 实例及写队列。
        // 只注入 service 会跳过默认装配分支，导致缺组织的升级用户永远无法恢复连接。
        const { service: settingService, prepareLegacyAccountConnections } =
          createSettingServiceWithMigrations();
        const hostApiNetworkTransport = createHostApiNetworkTransport(async () => {
          const settings = await settingService.get();
          return {
            httpProxy: settings.httpProxy,
            noProxy: settings.httpProxyNoProxy,
            caCertPath: settings.httpProxyCaCertPath,
          };
        });
        const services = await initializeHostApiNetworkTransportOwner({
          transport: hostApiNetworkTransport,
          log: (message, details) => logger.warn(message, details),
          establishOwner: () => {
            const initializedServices = createLocalServices({
              parentPort,
              settingService,
              prepareLegacyAccountConnections,
              hostApiNetworkTransport,
              authorizeLocalMediaPreviewPath,
              runtimeProcessEnvPatch: msg.runtimeProcessEnvPatch,
              agentRuntimeContext: {
                getDeviceMid: () => msg.deviceMid,
                runtimeSurface: "desktop_local_host",
              },
              serviceAuthorityMode: "desktop-local",
              zcodeAgentSpawnFallbackCwd: msg.agentSpawnFallbackCwd,
              zcodeBuiltinProviderConfigFilePath: msg.zcodeBuiltinProviderConfigFilePath,
              processLifecycleReporter: runtimeProcessLifecycleReporter,
              taskRuntimeReporter: runtimeTaskReporter,
              feedback: {
                getDeviceMid: () => msg.deviceMid,
                apiBaseUrl: msg.feedbackApiBase,
                createFullLogArchive: createFullFeedbackLogArchiveViaMain,
              },
              forwardSessionMessageSendRequested: (request) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.SessionMessageSendRequested,
                  request,
                });
              },
              onAutomationManualRunRequested: dispatchManualAutomationRun,
              /* 队长派单（`squad/assign-work-item`）产生的派发请求（2026-10-02 第 2 轮裁定）：
                 服务面的派发 hub 由组合根订一次，转到这里 —— 走**与规则到点同一条**派发路径
                 （`runSquadDispatch`，只是 `trigger: "user"`），不写任何唤醒规则。 */
              onSquadDispatchRequested: dispatchSquadAssignment,
              onOffPeakSchedulerWakeRequested: () => {
                parentPort?.postMessage({ type: HostResponseTypes.OffPeakSchedulerWakeRequest });
              },
              onProviderProvisioningSourceChanged: (trigger) => {
                parentPort?.postMessage({
                  type: HostResponseTypes.ProviderProvisioningSourceChanged,
                  trigger,
                });
              },
              // browser-use：agent 的 interaction/browserExecute 经 zcodeAgentService 转到这个 executor，
              // 再经 parentPort 到 main 的 WebContentsView+CDP 执行。
              browserControlExecutor: browserControlMainBridge,
              // CUA 顶部提示属于物理 Windows 桌面投影；非 Windows 和远端 authority 都不得上报。
              cuaOperationStateReporter:
                process.platform === "win32" ? cuaOperationStateReporter : undefined,
            });
            activeServices = initializedServices;
            activeHostApiNetworkTransport = hostApiNetworkTransport;
            return initializedServices;
          },
        });
        const zcodeTaskService = services.getOptional(IZCodeTaskService);
        if (zcodeTaskService) {
          const reportingZCodeTaskService = createReportingRemoteZCodeTaskService(
            zcodeTaskService,
            {
              reportRunningPromptCount: false,
            },
          );
          services.register(IZCodeTaskService, reportingZCodeTaskService);
        }
        wireLocalResourceTelemetry(services);
        hasDisposedHostResources = false;
        disposeHostResourcesInFlight = null;
        // 把本 host 额外暴露为可远程挂载的常驻主机（ADR 0003）：投射端经 SSH 隧道
        // 挂载后与 B 的桌面 UI **共用这一份运行时**，避免两端会话进度分叉。
        // 只监听回环临时端口；失败仅使远程挂载不可用，不影响本机功能。
        void exposeAsResidentHost({
          services,
          log: (message) => logger.info(`[resident-exposure] ${message}`),
          warn: (message, error) =>
            logger.warn(`[resident-exposure] ${message}`, error instanceof Error ? error : undefined),
        });
        const agentWarmupTargets =
          msg.agentWarmupTargets && msg.agentWarmupTargets.length > 0
            ? msg.agentWarmupTargets
            : msg.workspacePath
              ? [
                  {
                    workspacePath: msg.workspacePath,
                    ...(msg.workspaceIdentity ? { workspaceIdentity: msg.workspaceIdentity } : {}),
                  },
                ]
              : [];
        // Main 已按最近使用顺序把启动预热限制为 3 个；Host 必须显式消费这份
        // 固定名单，不能让后续 task-list observer 再隐式扩大，也不能因单个失败扫描补位。
        agentWarmupTargets.forEach((target, index) => {
          warmUpZCodeAgent(
            services,
            target,
            `local host init (${index + 1}/${agentWarmupTargets.length})`,
          );
        });
        logger.info("exposing services on ChannelServer...");
        if (!basePortClosed)
          windowHostAttachmentRegistry.attach({
            requestId: `init-local-${randomUUID()}`,
            attachmentId: `base-${randomUUID()}`,
            clientMode: "desktop-continuous",
            scope: { kind: "local" },
            port,
          });
        logWindowHostTopology("base-attachment-ready");
        logger.info("local services ready, all channels registered");
      },
    });
    await databaseStartup.coordinator.start();
  }
});

async function setupRemoteConnection(
  target: RemoteTarget,
  remoteAssets: RemoteAssetDirs,
  remoteAssetNetwork: RemoteAssetNetworkPort,
  remoteRuntimeNetwork: RemoteRuntimeNetworkOptions | undefined,
  onDidRemoteClose: (exitCode: number) => void,
  deployLockMode: DeployLockMode = "remote",
  signal?: AbortSignal,
): Promise<HostRemoteConnection> {
  // 延迟加载 remote backend，避免 local 模式下因 ssh2 依赖链进入 asar 后崩溃
  const { createRemoteBackend, connectRemote, connectResidentRemote, pickRemoteRuntimeEnv } =
    await import("@zcode/server/remote");
  const backend = await createRemoteBackend(target);
  // 远程项目升级：优先挂载对端「常驻会话主机」（SSH 隧道 + 协议协商，零部署动作，
  // 对端离线/未部署/协议不兼容时返回 null），失败自动回退 legacy stdio 模式。
  const residentConnection = await connectResidentRemote(backend, {
    signal,
    onDidRemoteClose: ({ code }) => {
      onDidRemoteClose(code);
    },
  });
  if (residentConnection) {
    return { ...residentConnection, backend };
  }
  const connection = await connectRemote(backend, {
    ...remoteAssets,
    remoteAssetNetwork,
    remoteRuntimeNetwork,
    signal,
    // SSH/Docker 远端 server 由 host process 单独启动，不能依赖桌面 main 的环境继承。
    // 这里显式透传编译期版本，避免漏导入后生成裸 ZCODE_VERSION 引用导致 SSH 初始化直接 ReferenceError。
    appVersion: ZCODE_VERSION,
    // 远端 zcode-server/agent 是独立进程，不能继承 host 里的测试/生产 endpoint 选择。
    // 这里只透传 server 侧白名单允许的公开环境变量，避免把 credential/token 带到远端机器。
    remoteRuntimeEnv: pickRemoteRuntimeEnv(process.env),
    assetInstallMode: target.kind === "ssh" ? target.assetInstallMode : undefined,
    // SSH 由窗口级 registry 串行复用，其余 transport 仍保留远端 connector 自身锁。
    deployLockMode,
    onDidRemoteClose: ({ code }) => {
      onDidRemoteClose(code);
    },
  });
  return { ...connection, backend };
}
