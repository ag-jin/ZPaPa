/**
 * board.json 的低层读取原语（#136/C3-1 从 `boardViewModel` 拆出：文件逼近仓库 `max-lines`
 * 上限，把「JSON 值 → 收敛形态」这组无业务判据的读者单点收拢；映射语义与拆前逐字一致）。
 *
 * 只做形态收敛：类型守卫、去空白、正整数、字符串数组、run 对象三件套。业务判据（版本门禁、
 * 特性/任务映射、四段派生装配）仍在 `boardViewModel` / `boardDerivedIndex`。
 */
import type { BoardActiveRun, BoardLastRun } from "./boardViewModel.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 计数读取（`attentionSummary` 四项与 `progress` 两项共用）：只认**正整数**，其余一律 0。
 * 名字与行为对齐（评审 S1）：不是「非负」——`0` 与缺省同为 0；小数/非数不 trunc
 * （2.5 若被截成 2，界面上会多出一个「看起来像真的」的计数）。
 */
export function readPositiveCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** 字符串数组（evidence / assignees）：非字符串项丢弃，空串丢弃（不渲染空路径）。 */
export function readTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const text = readText(entry);
    return text === null ? [] : [text];
  });
}

export function readLastRun(value: unknown): BoardLastRun | null {
  if (!isRecord(value)) return null;
  const at = readText(value.at);
  const role = readText(value.role);
  const result = readText(value.result);
  if (!at && !role && !result) return null;
  return {
    at: at ?? "",
    role: role ?? "",
    result: result ?? "",
    stoppedAt: readPositiveInteger(value.stoppedAt),
    next: readText(value.next),
  };
}

export function readActiveRun(value: unknown): BoardActiveRun | null {
  if (!isRecord(value)) return null;
  const role = readText(value.role);
  if (!role) return null;
  return { role, at: readText(value.at) };
}
