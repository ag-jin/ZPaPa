import { join } from "node:path";
import type { SkillRoot } from "@zcode/contracts";
import { collectDynamicWorkflowDisabledSkillPaths } from "./dynamic-workflow-gate.js";

/**
 * 「ask-matt 开发流程」实验开关对**内置技能包注册面**的判据（卡 #204/A3；#226/F1 起开态全注册）。
 *
 * 背景：#203/A2 把 mattpocock/skills 全库（37 个技能目录）原样带入内置包
 * （apps/zcode-cli/packages/bundled-skills），A2 只带文件、不碰注册面；本模块决定这批
 * 技能哪些可被发现/可被 Skill 工具加载：
 *
 * - 开关关闭（含未设置、未加载：只有显式 true 才算开，与 `askMattFlowEntryVisible` 同判据）：
 *   全库零注册 —— 内置包只剩产品内置技能 dynamic-workflows（它由动态工作流门独立控制）。
 * - 开关打开：**全库 37 件全注册**（#226/F1 起）。#204 的「重叠件 implement/tdd/code-review
 *   恒不注册」已按设计稿 §6 D5 裁决退役——重叠三件改走**命令层换名**（/matt-implement、
 *   /matt-tdd、/matt-code-review），技能名与上游正文不动：命令要能装载目标技能（调起进技能），
 *   用户 agent 军团（`~/.zcode/agents/*.md` 的 `skills: [tdd]` 等按名引用）也需要这些名字在
 *   纯产品环境下可装载。名单与命令表/快照的同源关系由四件套守卫钉死
 *   （askMattFlowCommandParity.test.ts）。
 *
 * 与 dynamic-workflow-gate.ts 同机制：只产出要写入 NodeSkillAdapter `disabledPaths` 的
 * SKILL.md 绝对路径（config.json 的 `skill.<path>.enable=false` 走的也是它），路径不存在时
 * 只是永不命中的 Set 成员，没有副作用。
 *
 * 名单身份：ASK_MATT_FLOW_PACK_SKILL_NAMES 是包内快照（skills/.zcode-skills-snapshot.json）
 * 在注册面的副本；两者漂移会静默漏注册/误注册，由构建级用例守卫（bundledSkillPackForms 同款）。
 * 升级上游快照时两处必须同步改。
 */

/** 内置包内 mattpocock/skills 全库技能目录名（与包内快照逐项一致，见漂移守卫用例）。 */
export const ASK_MATT_FLOW_PACK_SKILL_NAMES = [
  "ask-matt",
  "claude-handoff",
  "code-review",
  "codebase-design",
  "diagnosing-bugs",
  "domain-modeling",
  "git-guardrails-claude-code",
  "grill-me",
  "grill-with-docs",
  "grilling",
  "handoff",
  "implement",
  "implement-spec",
  "improve-codebase-architecture",
  "loop-me",
  "migrate-to-shoehorn",
  "prototype",
  "research",
  "resolving-merge-conflicts",
  "retro",
  "scaffold-exercises",
  "setup-matt-pocock-skills",
  "setup-pre-commit",
  "setup-ts-deep-modules",
  "tdd",
  "teach",
  "to-questionnaire",
  "to-spec",
  "to-tickets",
  "triage",
  "wait-what",
  "wayfinder",
  "wizard",
  "writing-beats",
  "writing-for-agents",
  "writing-fragments",
  "writing-shape",
] as const;

const SKILL_MANIFEST_FILE_NAME = "SKILL.md";

/**
 * ask-matt 开关要从注册面剔除的技能路径：关态 = 全库；开态 = 零剔除（37 件全注册）。
 * `enabled` 只认显式 true（undefined / null / false 一律按关闭），与 A1 的呈现判据同源。
 */
export function collectAskMattFlowDisabledSkillPaths(
  bundledSkillRoots: readonly SkillRoot[],
  enabled: boolean | undefined,
): string[] {
  if (enabled === true) return [];
  return bundledSkillRoots.flatMap((root) =>
    ASK_MATT_FLOW_PACK_SKILL_NAMES.map((name) => join(root.path, name, SKILL_MANIFEST_FILE_NAME)),
  );
}

export interface ResolveBundledSkillDisabledPathsInput {
  bundledSkillRoots: readonly SkillRoot[];
  /** App 同步到进程的运行期偏好；缺省 false（fail-closed）。 */
  askMattFlowEnabled?: boolean;
  /** 动态工作流门：只有显式 false 才剔除 dynamic-workflows 技能（沿用原语义）。 */
  dynamicWorkflowEnabled?: boolean;
  /** config.json 的 `skill.<path>.enable=false` 集合。 */
  configDisabledPaths: readonly string[];
}

/**
 * 内置包注册面的**单点**组装：用户配置禁用 + 动态工作流门 + ask-matt 门。
 * 三个来源各自独立（同一技能可被多条路径命中，集合语义天然幂等）；create-app 的 skillPort
 * 直接消费本函数，避免把三路判据散落在装配点里。
 */
export function resolveBundledSkillDisabledPaths(
  input: ResolveBundledSkillDisabledPathsInput,
): string[] {
  return [
    ...input.configDisabledPaths,
    // 动态工作流关闭时剔除 dynamic-workflows 技能的既有理由：十个工作流工具都不在场，
    // 再让模型读到「怎么写工作流脚本」只会诱导它去调不存在的工具。
    ...(input.dynamicWorkflowEnabled === false
      ? collectDynamicWorkflowDisabledSkillPaths(input.bundledSkillRoots)
      : []),
    ...collectAskMattFlowDisabledSkillPaths(input.bundledSkillRoots, input.askMattFlowEnabled),
  ];
}
