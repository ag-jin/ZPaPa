import { createHash } from "node:crypto";

/* 分支名与目录名共用的 slug。**只有这一处**定义（`planBranches` 的入参就是它产出的两个 slug）：
   两处各算一遍的话，「重启后认出活跃分支」这条会随实现漂移而静默失效。 */

/**
 * 工作项 / 智能体 id → 分支与目录用的 slug（16 位 hex，单一路径段）。
 *
 * 不拿 id 本身当 slug：`assertSafeSlug` 只接受 `^[a-z0-9][a-z0-9-]*$`，而任意 id（含将来可能出现的
 * 中文、下划线、大写、以及 UUID 里的连字符以外的字符）要过那道闸就得**归一化**；归一化会把两个不同的
 * id 映到同一个 slug（`A-B` 与 `a_b` 都变成 `a-b`）——两个工作项于是**共用分支与目录**，
 * 互相覆盖成果且不报错。故直接取 sha256 的前 16 个 hex：合法、确定、唯一。
 *
 * `createHash` 来自 `node:crypto` ⇒ 本文件是 **node 侧**模块，只能从 `@zcode/services/node` 可达，
 * 不得进 `packages/services/src/index.ts`（那个入口被 renderer 直接解析，见 browserSafeRootEntry.test.ts）。
 *
 * 确定性的意义：启动回收要靠它**在重启后算出同一个分支名**才能认出活跃分支
 * （`computeActiveBranches` 比的是台账里的分支名与 git 报出的分支名，两者都从本函数派生）。
 * 代价：分支名不可读（`squad/member/<16hex>/<16hex>`），换取「不可能撞车」。
 */
export function slugForId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}
