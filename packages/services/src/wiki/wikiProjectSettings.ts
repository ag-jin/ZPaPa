import type {
  ModelSelection,
  WikiAutoUpdateFrequency,
  WikiProjectSettings,
  WikiSettings,
} from "@zcode/shared";
import {
  WIKI_DEFAULT_FREQUENCY,
  WIKI_DEFAULT_HOUR,
  WIKI_DEFAULT_MINUTE,
  clampClock,
} from "./wikiSchedule.js";

/** workspace 身份键：与 paths.ts / task-realtime-core 的约定一致。 */
export function resolveWikiWorkspaceKey(
  workspacePath: string,
  workspaceIdentity?: string,
): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 解析后的完整项目配置；字段全部落地，调用方不再处理 undefined。 */
export interface ResolvedWikiProjectSettings {
  autoUpdateEnabled: boolean;
  autoUpdateFrequency: WikiAutoUpdateFrequency;
  autoUpdateHour: number;
  autoUpdateMinute: number;
  autoUpdateAnchorAt: number | null;
  autoUpdateModelSelection: ModelSelection | undefined;
  autoUpdateReasoningLevel: string | undefined;
  lastAutoUpdateAt: number | null;
  modelSelection: ModelSelection | undefined;
  reasoningLevel: string | undefined;
  generateDiagrams: boolean;
  language: string;
  maxOutputTokens: number | null;
}

const DEFAULT_LANGUAGE = "zh-CN";

/**
 * 读取某个项目的配置。
 *
 * 优先级：项目自己的配置 > 旧的全局配置（迁移期）> 内置默认值。
 *
 * 旧的全局配置只在**该项目尚无任何配置**时生效：一旦用户在任何项目上
 * 改过设置，就写进 projects 表，该项目从此走自己的值。
 * 这样老用户的既有配置不会在升级后凭空消失，也不会被复制到所有项目上。
 */
export function resolveWikiProjectSettings(
  settings: WikiSettings | undefined,
  workspaceKey: string,
): ResolvedWikiProjectSettings {
  const project = settings?.projects?.[workspaceKey];
  const legacyFrequency = settings?.autoUpdateFrequency;

  const frequency = project?.autoUpdateFrequency ?? legacyFrequency ?? WIKI_DEFAULT_FREQUENCY;
  const { hour, minute } = clampClock(
    project?.autoUpdateHour ?? settings?.autoUpdateHour ?? WIKI_DEFAULT_HOUR,
    project?.autoUpdateMinute ?? settings?.autoUpdateMinute ?? WIKI_DEFAULT_MINUTE,
  );

  return {
    autoUpdateEnabled: project?.autoUpdateEnabled === true,
    autoUpdateFrequency: frequency,
    autoUpdateHour: hour,
    autoUpdateMinute: minute,
    autoUpdateAnchorAt:
      typeof project?.autoUpdateAnchorAt === "number" && Number.isFinite(project.autoUpdateAnchorAt)
        ? project.autoUpdateAnchorAt
        : null,
    autoUpdateModelSelection: project?.autoUpdateModelSelection,
    autoUpdateReasoningLevel: project?.autoUpdateReasoningLevel,
    lastAutoUpdateAt:
      typeof project?.lastAutoUpdateAt === "number" && Number.isFinite(project.lastAutoUpdateAt)
        ? project.lastAutoUpdateAt
        : null,
    modelSelection: project?.modelSelection,
    reasoningLevel: project?.reasoningLevel,
    generateDiagrams: project?.generateDiagrams !== false,
    language: project?.language ?? settings?.defaultLanguage ?? DEFAULT_LANGUAGE,
    maxOutputTokens:
      typeof project?.maxOutputTokens === "number" && project.maxOutputTokens > 0
        ? project.maxOutputTokens
        : null,
  };
}

/**
 * 把一次修改写进某个项目的配置。
 *
 * 返回新的 WikiSettings（不改原对象）：settings 是共享状态，
 * 原地改动会让 React 的引用比较失效。
 */
export function patchWikiProjectSettings(
  settings: WikiSettings | undefined,
  workspaceKey: string,
  patch: Partial<WikiProjectSettings>,
): WikiSettings {
  const projects = { ...settings?.projects };
  const current = projects[workspaceKey] ?? {};
  const next: WikiProjectSettings = { ...current, ...patch };

  // 值为 undefined 表示「回到默认」，不能写成显式的 undefined 键 ——
  // JSON 序列化会丢掉它，但内存里留着会让「该项目是否被配置过」的判断失真。
  for (const key of Object.keys(next) as Array<keyof WikiProjectSettings>) {
    if (next[key] === undefined) delete next[key];
  }

  if (Object.keys(next).length === 0) delete projects[workspaceKey];
  else projects[workspaceKey] = next;

  return { ...settings, projects };
}

/**
 * 判断某个项目是否已有自己的配置。
 *
 * UI 用它区分「这个项目配过」和「还在吃默认值」—— 两者行为可能一样，
 * 但用户对「我改过没有」的认知不同，界面需要能如实反映。
 */
export function hasWikiProjectSettings(
  settings: WikiSettings | undefined,
  workspaceKey: string,
): boolean {
  return Boolean(settings?.projects?.[workspaceKey]);
}

/**
 * 列出所有配过定时更新的项目（供调度器遍历）。
 *
 * 只返回开启了的项目：调度器不该为关闭的项目反复算排期。
 */
export function listWikiAutoUpdateProjects(
  settings: WikiSettings | undefined,
): Array<{ workspaceKey: string; settings: ResolvedWikiProjectSettings }> {
  const projects = settings?.projects ?? {};
  const out: Array<{ workspaceKey: string; settings: ResolvedWikiProjectSettings }> = [];
  for (const workspaceKey of Object.keys(projects)) {
    const resolved = resolveWikiProjectSettings(settings, workspaceKey);
    if (resolved.autoUpdateEnabled) out.push({ workspaceKey, settings: resolved });
  }
  return out;
}
