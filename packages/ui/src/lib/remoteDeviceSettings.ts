/**
 * 远程设备设置投射：可投射字段的白名单与读写封装。
 *
 * 设计要点（用户已确认）：
 * - 只暴露**白名单**字段：布尔型、非敏感、对远端设备有意义。
 * - 排除设备本地属性（路径、窗口、缩放、locale 等）与任何凭据/会话线索字段。
 * - 写操作走 `settingService.update`，调用方负责"改前记录 → 改后读回确认"。
 *
 * 为什么排除而非包含：设置项会持续增加，白名单排除法能保证新字段默认不暴露，
 * 避免将来某个含敏感信息的新字段被无意投射出去。
 */
/** 命中任一模式即排除（凭据/设备本地属性/内部标记）。 */
const EXCLUDED_KEY_PATTERNS: readonly RegExp[] = [
  // 凭据与密钥线索
  /token/i,
  /credential/i,
  /secret/i,
  /password/i,
  /apiKey/i,
  // 设备本地属性：投射到另一端无意义或有隐私风险
  /path/i,
  /dir/i,
  /locale/i,
  /window/i,
  /zoom/i,
  /tab/i,
  /recent/i,
  /relay/i,
  /preference.*viewport/i,
  // 内部迁移/初始化标记：不是用户可理解的设置
  /MigrationInitialized/i,
  /Migrated$/i,
  /FirstRunPromptHandled/i,
  /Dismissed$/i,
  /Allowlist/i,
];

/**
 * 判断某个设置字段是否可投射到对端。
 *
 * 只接受布尔值：数值/字符串/对象字段语义依赖各端环境（如 `taskAutoArchiveOlderThanDays`
 * 是策略值、`integratedTerminalShell` 是本机 shell），跨端投射容易造成误解。
 */
export function isProjectableSetting(key: string, value: unknown): boolean {
  if (typeof value !== "boolean") return false;
  return !EXCLUDED_KEY_PATTERNS.some((pattern) => pattern.test(key));
}


/**
 * 字段 → 产品设置页现有 i18n 标签键。
 *
 * 复用产品文案而不是自造名称：用户在本机设置里见过的措辞，在远程设备设置里应当
 * 一模一样；同一个开关在两处叫法不同会让人以为它们是不同东西。
 * 未列出的字段回退显示键名（产品里没有独立设置项的内部开关）。
 */
const SETTING_LABEL_IDS: Readonly<Record<string, { label: string; description?: string }>> = {
  memoryEnabled: {
    label: "settings.memory.workspaceMemory",
    description: "settings.memoryDescription",
  },
  messageStreamShowReasoning: {
    label: "settings.messageStreamShowReasoning",
    description: "settings.messageStreamShowReasoningDescription",
  },
  messageStreamShowTodos: {
    label: "settings.messageStreamShowTodos",
    description: "settings.messageStreamShowTodosDescription",
  },
  keepAwakeWhileRunning: {
    label: "settings.keepAwakeWhileRunning",
    description: "settings.keepAwakeWhileRunningDescription",
  },
  toolGroupingExploreEnabled: {
    label: "settings.toolGroupingExplore",
    description: "settings.toolGroupingExploreDescription",
  },
  toolGroupingTerminalEnabled: {
    label: "settings.toolGroupingTerminal",
    description: "settings.toolGroupingTerminalDescription",
  },
  toolGroupingChangesEnabled: {
    label: "settings.toolGroupingChanges",
    description: "settings.toolGroupingChangesDescription",
  },
  askUserQuestionAutoResolutionEnabled: {
    label: "settings.askUserQuestionAutoResolution",
    description: "settings.askUserQuestionAutoResolutionDescription",
  },
  nativeSearchEnhancementsEnabled: {
    label: "settings.nativeSearchEnhancements",
    description: "settings.nativeSearchEnhancementsDescription",
  },
  taskAutoArchiveEnabled: {
    label: "settings.taskAutoArchive",
    description: "settings.taskAutoArchiveDescription",
  },
  modelIoFullRetentionEnabled: {
    label: "settings.modelIoFullRetention",
    description: "settings.modelIoFullRetentionDescription",
  },
  terminalInheritSystemProfile: {
    label: "settings.terminalProfile",
    description: "settings.terminalProfileDescription",
  },
  desktopChromiumHardwareAccelerationEnabled: {
    label: "settings.desktopChromiumHardwareAcceleration",
  },
  embeddedBrowserAllowInsecureCertificates: {
    label: "settings.embeddedBrowserAllowInsecureCertificates",
  },
  autoDownloadAndInstallUpdates: {
    label: "settings.autoDownloadAndInstallUpdates",
  },
  receivePreviewUpdates: {
    label: "settings.receivePreviewUpdates",
  },
  proactiveSuggestionsEnabled: {
    // 该开关只出现在办公模式的设置区块，文案键挂在 chat 命名空间下。
    label: "chat.officeSuggestions.setting",
    description: "chat.officeSuggestions.settingDescription",
  },
};

export interface ProjectableSettingEntry {
  readonly key: string;
  readonly value: boolean;
  /** 产品现有设置页使用的 i18n 标签键；缺失时 UI 回退到键名。 */
  readonly labelId?: string;
  /** 标签的说明文案键。 */
  readonly descriptionId?: string;
}

/** 从完整设置中挑出可投射字段，按键名排序保证 UI 顺序稳定。 */
export function pickProjectableSettings(settings: object): ProjectableSettingEntry[] {
  const entries: ProjectableSettingEntry[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (!isProjectableSetting(key, value)) continue;
    const labels = SETTING_LABEL_IDS[key];
    entries.push({
      key,
      value: value as boolean,
      ...(labels ? { labelId: labels.label } : {}),
      ...(labels?.description ? { descriptionId: labels.description } : {}),
    });
  }
  // 有产品标签的排前面并按标签键排序（贴近产品设置页顺序），无标签的排后面。
  return entries.sort((left, right) => {
    const leftRank = left.labelId ? 0 : 1;
    const rightRank = right.labelId ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return (left.labelId ?? left.key).localeCompare(right.labelId ?? right.key);
  });
}

/** 人读标签：去掉常见前缀并把驼峰拆成词，供 UI 在缺少 i18n 时兜底展示。 */
export function formatProjectableSettingLabel(key: string): string {
  const spaced = key
    .replace(/^(desktop|embedded|messageStream|toolGrouping|native|askUser)/, (match) => `${match} `)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
