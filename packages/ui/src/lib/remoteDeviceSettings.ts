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

export interface ProjectableSettingEntry {
  readonly key: string;
  readonly value: boolean;
}

/** 从完整设置中挑出可投射字段，按键名排序保证 UI 顺序稳定。 */
export function pickProjectableSettings(settings: object): ProjectableSettingEntry[] {
  const entries: ProjectableSettingEntry[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (isProjectableSetting(key, value)) {
      entries.push({ key, value: value as boolean });
    }
  }
  return entries.sort((left, right) => left.key.localeCompare(right.key));
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
