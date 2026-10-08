import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ZCodeConfigOption,
  ZCodeProvider,
  BotConfig,
  BotContextState,
  BotInboundMessage,
  BotOutboundMessage,
  BotProvider,
  BotProviderCallbackResult,
  BotServiceStatus,
  BotWorkspaceRef,
  BotsConfigFile,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type { ZCodeAgentAppRuntimePreferences } from "../zcode-agent/zcodeAgent.js";
/* **仅类型**的跨域引用（`import type` 编译后被擦除，不构成运行时依赖，browserSafeRootEntry 不受影响）：
   渠道摘要的消息键集必须与 Inbox 的 kind / severity 闭集同源 —— 两处各自列一份时，
   新增一个 kind 会表现为「收件箱有条目、渠道推的是空白」，而全链不报错。 */
import type { InboxItemKind, InboxItemSeverity } from "../workitem/inboxItemRepo.js";

export interface BotCreateBindCodeParams {
  botId?: string;
  allowedWorkspaces?: string[];
  ttlMs?: number;
}

export interface BotSaveBotParams {
  bot: BotConfig;
  credentialValue?: string;
  webhookSecretValue?: string;
}

export interface BotTestResult {
  ok: boolean;
  message: string;
  name?: string;
  provider?: BotProvider;
}

export interface BotBindCodeResult {
  code: string;
  expiresAt: number;
}

export interface BotListWorkspaceRefsParams {
  currentWorkspace?: BotWorkspaceRef;
}

export interface BotUserConfigOptionsParams {
  workspacePath: string;
  workspaceIdentity?: string;
  provider: ZCodeProvider;
}

export interface BotAutomationRunWatchParams {
  target: ZCodeAutomationBotDeliveryTarget;
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 渠道只读推送的**目标工作区**（SUB.3b，Q2 裁定：每 workspace 一个通知渠道目标）。
 *
 * 为什么入参是 workspace 而不是 `ZCodeAutomationBotDeliveryTarget`：那个形状的每一格
 * （botId / providerUserId / chatType）只有 bots 域读得到 —— 具体渠道目标由实现按**既有**配置解析
 * （哪个 bot 声明了这个 workspace + 它绑定到了哪个会话），调用方拿不到、也不该拼。
 * 「未配置 ⇒ 零出站」（离线缺省形态）因此落在实现里：没有 bot 声明 ⇒ 没有目标 ⇒ 一条都不发。
 */
export interface BotInboxChannelTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 一条 Inbox 条目在渠道上要呈现的**结构化事实**（渲染归 bots 的消息表：`messages.ts`）。
 *
 * `severity` 由调用方从**唯一来源** `INBOX_SEVERITY_BY_KIND` 带过来（条目落库时的那一格），
 * 而不是在这里按 kind 重查一遍 —— 渠道上显示的「多急」必须与收件箱里的行是同一个结论。
 */
export interface BotInboxChannelSummary {
  kind: InboxItemKind;
  severity: InboxItemSeverity;
  /** 面向人的主体（工作项标题；调用方已按构建件口径回落到 id）。 */
  title: string;
}

/** 跳过（没有出站）的原因闭集：三种可用性 + 一种投递失败，名字与 `watchAutomationRun` 先例对齐。 */
export const BOT_INBOX_CHANNEL_SKIP_REASONS = [
  /** 没有 bot 声明这个 workspace（未配置通知渠道 ⇒ 零出站，**不是**错误）。 */
  "not_configured",
  /** 声明了但被停用。 */
  "bot_disabled",
  /** 声明了但 provider 不能主动投递（target 形状的可推三值：feishu / lark / weixin）。 */
  "provider_mismatch",
  /** 渠道侧投递失败（网络/凭据/远端拒绝）—— best-effort：只 warn，绝不抛。 */
  "send_failed",
] as const;
export type BotInboxChannelSkipReason = (typeof BOT_INBOX_CHANNEL_SKIP_REASONS)[number];

export interface BotInboxChannelPushParams {
  target: BotInboxChannelTarget;
  summary: BotInboxChannelSummary;
}

/** 推送结论：`delivered` 为真时回报落点（bot + provider），供组合根/测试观测「谁收到了」。 */
export type BotInboxChannelPushResult =
  | { delivered: true; botId: string; provider: BotProvider }
  | { delivered: false; reason: BotInboxChannelSkipReason };

export interface BotWeixinRegistrationBeginResult {
  qrCode: string;
  qrUrl: string;
  interval: number;
  expiresAt: number;
}

export interface BotWeixinRegistrationPollParams {
  qrCode: string;
}

export type BotWeixinRegistrationPollResult =
  | {
      status: "pending" | "scanned";
      interval: number;
    }
  | {
      status: "success";
      botToken: string;
      botId?: string;
    }
  | {
      status: "expired" | "error";
      message?: string;
    };

export interface BotFeishuRegistrationBeginParams {
  domain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationBeginResult {
  deviceCode: string;
  qrUrl: string;
  userCode: string;
  interval: number;
  expiresAt: number;
  domain: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export interface BotFeishuRegistrationPollParams {
  deviceCode: string;
  domain?: "feishu" | "lark";
  pollDomain?: "feishu" | "lark";
}

export type BotFeishuRegistrationPollResult =
  | {
      status: "pending";
      interval: number;
      domain: "feishu" | "lark";
      pollDomain?: "feishu" | "lark";
    }
  | {
      status: "success";
      appId: string;
      appSecret: string;
      domain: "feishu" | "lark";
      appName?: string;
      openId?: string;
    }
  | {
      status: "access_denied" | "expired" | "error";
      message?: string;
      domain: "feishu" | "lark";
    };

export interface IBotsService {
  /**
   * 将 App 全局交互偏好同步给 Bot 已持有的远端 runtime；不得为此建立新的远端连接。
   */
  syncAppRuntimePreferences(preferences: ZCodeAgentAppRuntimePreferences): Promise<void>;
  getStatus(): Promise<BotServiceStatus>;
  getConfig(): Promise<BotsConfigFile>;
  listWorkspaceRefs(params?: BotListWorkspaceRefsParams): Promise<BotWorkspaceRef[]>;
  getUserConfigOptions(params: BotUserConfigOptionsParams): Promise<ZCodeConfigOption[]>;
  beginFeishuRegistration(
    params?: BotFeishuRegistrationBeginParams,
  ): Promise<BotFeishuRegistrationBeginResult>;
  pollFeishuRegistration(
    params: BotFeishuRegistrationPollParams,
  ): Promise<BotFeishuRegistrationPollResult>;
  beginWeixinRegistration(): Promise<BotWeixinRegistrationBeginResult>;
  pollWeixinRegistration(
    params: BotWeixinRegistrationPollParams,
  ): Promise<BotWeixinRegistrationPollResult>;
  saveConfig(config: BotsConfigFile): Promise<BotsConfigFile>;
  listBots(): Promise<BotConfig[]>;
  saveBot(params: BotSaveBotParams): Promise<BotConfig>;
  removeBotSecret(botId: string): Promise<BotConfig>;
  deleteBot(botId: string): Promise<void>;
  testBot(botId: string): Promise<BotTestResult>;
  createBindCode(params: BotCreateBindCodeParams): Promise<BotBindCodeResult>;
  getBotStates(): Promise<BotContextState[]>;
  resetBotState(contextKey: string): Promise<void>;
  /** 在 automation prompt 派发前订阅终态，并把结果回推到创建它的 Bot 会话。 */
  watchAutomationRun(params: BotAutomationRunWatchParams): Promise<void>;
  /**
   * **渠道只读推送**（SUB.3b）：把一条 Inbox 摘要（纯文本）推到该 workspace 已配置的通知渠道目标。
   *
   * 「只读」是结构性的：这个方法只**发**一条文本 —— 消息上没有 selection / elicitation
   * （没有任何可点的操作），实现链上也不 import 入站面（命令解析 / callback / 派发）。
   * 因此渠道侧零操作入口，也就产生不了任何派发（spec §2.2 的「渠道只到对话」）。
   *
   * best-effort：没有目标 / bot 停用 / provider 不能主动投递 ⇒ warn-once 跳过；
   * 渠道侧 send 失败 ⇒ warn-once，**绝不抛**（Inbox 行本身是 durable 事实，推送只是它的副本）。
   */
  pushInboxChannelSummary(params: BotInboxChannelPushParams): Promise<BotInboxChannelPushResult>;
  handleInboundMessage(message: BotInboundMessage): Promise<BotOutboundMessage[]>;
  handleProviderCallback(provider: BotProvider, payload: unknown): Promise<BotOutboundMessage[]>;
  handleProviderCallbackResponse(
    provider: BotProvider,
    payload: unknown,
  ): Promise<BotProviderCallbackResult>;
}

export const IBotsService = createServiceDescriptor<IBotsService>(ServiceChannels.Bots);
