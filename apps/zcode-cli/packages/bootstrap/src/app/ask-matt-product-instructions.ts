/**
 * 「ask-matt 开发流程」产品 agent 提示资产（卡 #212/A11）：Karpathy 四条行为纪律。
 *
 * 交付面：产品内置 agent 的会话系统提示面携带四条——随开关 gate（ask-matt 流程开时注入；
 * 关不注入）。判据与 A1/A3/A4 同源：只有显式 true 才算开（undefined / null / false 一律
 * 关闭，fail-closed）。接线在 create-app：`runtimeConfig.askMattFlowEnabled`（由
 * server-operations 从进程缓存 context.appRuntimePreferences 写出的**同一布尔**）→
 * `resolveAskMattProductInstructions` → `runtimeConfig.productInstructions` → core context
 * builder 的 system 段（source=product_instructions）。关/未设置时不产出任何文本，零注入。
 *
 * 同源对齐义务（防双源漂移）：文本与技能仓 `assets/templates/card/constraint-block.md`
 * §行为纪律（constraint-block/3，#211/A10 用户裁定 itw-20261011-1894）逐条对齐；语义上游是
 * `~/.zcode/skills/karpathy-guidelines/SKILL.md`（MIT）。此处刻意去掉看板编排专属交叉引用
 * （派发形态/拆卡粒度/评审条目映射），只保留产品 agent 适用的四条执行口径 + 取舍引言。
 * 上游模板改动四条口径时，本常量必须同步（版本：ask-matt-karpathy/1）。
 */
export const ASK_MATT_PRODUCT_INSTRUCTIONS = [
  "# 行为纪律（Karpathy 四条）",
  "",
  "以下纪律偏向谨慎而非速度；琐碎任务自行裁量。",
  "",
  "- **Think Before Coding（先想后写）**：动手前显式列出假设与多种解读，不猜不藏；有更简方案就说、有歧义就停下问。",
  "- **Simplicity First（简单优先）**：最小改动解决问题，不写投机特性/单用抽象/未请求的配置；不为不可能的场景写错误处理。",
  "- **Surgical Changes（外科手术式改动）**：只碰必须碰的，不顺手改邻近代码/注释/格式、不重构没有坏的东西；只清理自己改动产生的孤儿，无关死代码提到而不删除；每行改动可追溯到请求。",
  "- **Goal-Driven Execution（目标驱动执行）**：先立可验证判据（失败测试 → 最小实现；先复现 → 再修）；多步任务列「步骤 → 验证」计划，判据先于实现。",
].join("\n");

/**
 * 开关 → 产品提示资产：显式 true 返回四条全文，其余（false / undefined / 未加载缓存）返回
 * undefined = 零注入。与 `collectAskMattFlowDisabledSkillPaths` 共用同一 fail-closed 口径。
 */
export function resolveAskMattProductInstructions(
  enabled: boolean | undefined,
): string | undefined {
  return enabled === true ? ASK_MATT_PRODUCT_INSTRUCTIONS : undefined;
}
