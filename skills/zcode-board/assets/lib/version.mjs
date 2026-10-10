#!/usr/bin/env node
/**
 * zcode-board 版本单一事实源（#67，P2 分发前置件）
 *
 * 三类版本及其事实源（`--version` / `--manifest` / 测试断言均由此读取，不手写第二份）：
 *   - 包版本   SKILL_VERSION 常量（本文件）——技能包语义化版本，generatedBy / manifest / SKILL.md 头部派生自它；
 *   - 契约版本 readContractVersion()——assets/contracts/markers.md 最新变更段头（`vX.Y 变更段` / `vX.Y 补篇段`）；
 *   - schema 版本 readSchemaVersion()——assets/board.schema.json 根级 `x-schemaVersion`。
 *
 * 映射（#67 卡文裁决；#72、#80 更新）：包 0.5.x = 契约 v2.5 + schema v2.4 + 编译器 0.2 能力集。
 *   （0.2 是编译器历史版本号；包版本自 0.3.0 起按语义化维护，策略成文见 SKILL.md「版本策略」节。
 *   0.3.1 = 修订级：#69 入口守卫 realpath 归一 + #71 嵌套工作树声明形态归一，不动契约/schema 版本。
 *   0.4.0 = 次版本级：#72 扫描面配置化（默认收窄为 .zcode/plans，docs 计划目录 opt-in）——默认值破坏性
 *   变更 → 契约升 v2.4（markers.md v2.4 变更段 + §9 扫描面配置），board.json 字段不变、schema 仍 v2.3。
 *   0.5.0 = 次版本级：#80（A1 批收口）——契约顺延 v2.4 → v2.5（A1 批 epic 层规格 §10 + 位置分层 §11
 *   并入契约主体；v2.4 已被 #72 扫描面配置占用），schema 顺延 v2.3 → v2.4（epics[] 与
 *   features[].epic/phase 定义转正、草案标注解除）；本批能力新增且契约向后兼容：epic 层规格、位置分层，
 *   叠加同夜批次包侧能力（第五不变量 #97、源变更检测 #101/#102、工作树归一化 #151 等）——旧产物
 *   仍可被新版本读取。版本位三处同源：本常量（包 0.5.0）↔ markers.md v2.5 变更段头（契约 v2.5）↔
 *   board.schema.json x-schemaVersion/x-contractVersion（2.4 / 2.5）；SKILL.md 映射行由批收口单飞写入。）
 *
 * 无第三方依赖：仅 node 内置模块。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SKILL_NAME = "zcode-board";
/** 技能包版本（语义化，唯一事实源；bump 规则见 SKILL.md「版本策略」节）。 */
export const SKILL_VERSION = "0.5.0";
/** 编译产物 board.json 的 generatedBy 形态：`zcode-board/<包版本>`。 */
export const GENERATED_BY = `${SKILL_NAME}/${SKILL_VERSION}`;

/** 技能根目录（SKILL.md 所在目录；assets/lib/version.mjs → ../../）。 */
export const SKILL_ROOT_DIR = fileURLToPath(new URL("../..", import.meta.url));
/** SKILL.md 绝对路径（头部版本行由测试断言与本常量同值，防手写漂移）。 */
export const SKILL_MD_PATH = fileURLToPath(new URL("../../SKILL.md", import.meta.url));
export const SCHEMA_PATH = fileURLToPath(new URL("../board.schema.json", import.meta.url));
export const MARKERS_PATH = fileURLToPath(new URL("../contracts/markers.md", import.meta.url));

/** 契约版本：markers.md 全部变更段头（含补篇段）中的最高 `vX.Y`。缺失 → 显式抛错，不静默。 */
export function readContractVersion() {
  const text = readFileSync(MARKERS_PATH, "utf8");
  let best = null;
  for (const line of text.split("\n")) {
    const m = line.match(/v([0-9]+)\.([0-9]+)\s*(?:变更段|补篇段)/);
    if (!m) continue;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    if (best === null || major > best[0] || (major === best[0] && minor > best[1])) best = [major, minor];
  }
  if (best === null) {
    throw new Error(`markers.md 未找到变更段头（期望 \`vX.Y 变更段\` 或 \`vX.Y 补篇段\` 形态）：${MARKERS_PATH}`);
  }
  return `${best[0]}.${best[1]}`;
}

/** schema 版本：board.schema.json 根级 `x-schemaVersion`。缺失/非法 → 显式抛错，不静默。 */
export function readSchemaVersion() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  const v = schema["x-schemaVersion"];
  if (typeof v !== "string" || !/^[0-9]+\.[0-9]+$/.test(v)) {
    throw new Error(`board.schema.json 缺少/非法根级 x-schemaVersion（期望 "X.Y" 字符串）：${SCHEMA_PATH}`);
  }
  return v;
}

/** 三版本一次性读取（--version / manifest 共用）。 */
export function readVersionInfo() {
  return {
    name: SKILL_NAME,
    packageVersion: SKILL_VERSION,
    contractVersion: readContractVersion(),
    schemaVersion: readSchemaVersion(),
  };
}

/** `--version` 单行输出形态：`zcode-board <包版本> · 契约 v<X.Y> · schema v<X.Y>`。 */
export function formatVersionLine(info = readVersionInfo()) {
  return `${SKILL_NAME} ${info.packageVersion} · 契约 v${info.contractVersion} · schema v${info.schemaVersion}`;
}
