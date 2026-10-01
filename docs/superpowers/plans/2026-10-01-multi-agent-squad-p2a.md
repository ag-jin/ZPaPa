# 多智能体小队 · P2a 工作树隔离与合并 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让队员能**各在独立工作树里干活**、由队长**串行合并**、合并后**抛弃工作树**，且崩溃遗留的孤儿能被回收。

**Architecture:** 纯库级实现（`packages/services/src/worktree/`），不接线到调度器——因此可在无消费者的情况下完整测试。工作树落在**项目根 `<repoRoot>/.worktree/`**，分支从同一 base 派生且**每队员独立**；合并走**集成分支**、**串行**、冲突**不抛而返回结果**（由上层置 `blocked`）。所有 git 操作经一个小而明确的执行封装，便于注入与断言。

**Tech Stack:** TypeScript · Node 24（`node:test` + `node:assert/strict`，`pnpm exec tsx --test`）· `node:child_process` 调 git · 真实临时 git 仓库做集成测试

**Spec:** `docs/superpowers/specs/2026-10-01-multi-agent-squad-design.md`（§6.1–6.4 工作树与合并、§3.10 限额、§13 C10 排除清单、§17 留白台账）

**前置**：P1 已实现（分支 `feat/multi-agent-squad-p1`，PR #2）。**P2a 分支堆叠在 P1 之上**：`feat/multi-agent-squad-p2a`。

## Global Constraints

- **工作树目录固定**：`<repoRoot>/.worktree/`。**必须同时**进 `.gitignore` 与扫描排除（spec §13 C10）——否则 git status 脏、搜索会遍历 N 份仓库副本。
- **每队员一个独立分支**：git **不允许两个 worktree 检出同一分支**（`branch-in-other-worktree`）。分支名 `squad/<workItemSlug>/<agentSlug>`，全部从**同一 base** 派生。
- **合并目标 = 集成分支** `squad/<workItemSlug>`；整批通过后再合回主分支（spec §6.3）。
- **合并串行**（一次一个）；**冲突不抛**，返回结构化结果（由上层置工作项 `blocked` + 通知）。
- **worktree 活到「被合并」为止**：审查被拒时**必须存活**，不得提前删（spec §6.2）。
- **清理是正确性前置**：孤儿 worktree 会**占住分支**，下次同分支再建会失败 → 必须有回收。
- **id 必须校验为单一路径段**（`basename(id) === id`）——P1 的 `teamAgentStorage.definitionPath` 在此留下 `..` 逃逸隐患，spec §17 登记为「任何调用方开始传 id 之前必修」，**P2a 必须一并闭合**。
- 测试位置 `packages/<pkg>/test/*.test.ts`；命令 `pnpm exec tsx --test <file>`（**ui 例外**：带 `--tsconfig packages/ui/tsconfig.json`）。
- 每个任务结束必须通过 `pnpm typecheck` 与 `pnpm lint`。
- 注释用中文说明**为什么**。

## Review Focus

spec 隐含但各任务测试**容易漏掉**的输入/失败模式（每条都在拥有该代码的任务里加了测试）：

1. **同分支双挂**：两个 worktree 要求同一分支 → 第二个必须**可读地失败**，且失败后**不留半个目录**（Task 2）。
2. **合并冲突**：冲突时**不抛**、返回结果、**不得**把集成分支留成半合并状态（Task 3）。
3. **孤儿占分支**：杀掉进程留下 worktree → 回收后**同一分支可重新建**（Task 4）——这是「清理是正确性前置」的机器化证明。
4. **审查被拒存活**：未合并的 worktree **不得**被回收（Task 4）。
5. **路径逃逸**：id 含 `..` / `/` / 空串 → 拒绝（Task 5）。

---

### Task 1: git 执行封装 + worktree 管理器

**Files:**
- Create: `packages/services/src/worktree/gitRunner.ts`、`packages/services/src/worktree/worktreeManager.ts`
- Create: `packages/services/test/helpers/gitFixture.ts`（**共享测试夹具**：`makeRepo()` 造临时 git 仓库、`realGit(root)` 返回真实的 `GitRunner`。Task 3、4 复用，避免各写一份）
- Test: `packages/services/test/worktreeManager.test.ts`

**Interfaces:**
- Produces:
  - `type GitRunResult = { code: number; stdout: string; stderr: string }`
  - `type GitRunner = (args: string[], opts: { cwd: string }) => Promise<GitRunResult>`
  - `createWorktreeManager(deps: { git: GitRunner; repoRoot: string }): WorktreeManager`
  - `WorktreeManager.add(input: { branch: string; base: string; dirName: string }): Promise<{ path: string }>`
  - `WorktreeManager.remove(dirName: string): Promise<void>`（`git worktree remove` + 删分支由 Task 3 负责）
  - `WorktreeManager.list(): Promise<Array<{ path: string; branch: string | null }>>`
  - `WorktreeManager.prune(): Promise<void>`
  - `resolveWorktreeRoot(repoRoot: string): string` → `<repoRoot>/.worktree`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createWorktreeManager, resolveWorktreeRoot } from "../src/worktree/worktreeManager.js";

const run = promisify(execFile);
async function makeRepo(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "repo-"));
  const git = async (args: string[]) => (await run("git", args, { cwd: root })).stdout;
  await run("git", ["init", "-q", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.email", "t@t"], { cwd: root });
  await run("git", ["config", "user.name", "t"], { cwd: root });
  writeFileSync(join(root, "a.txt"), "1\n");
  await run("git", ["add", "-A"], { cwd: root });
  await run("git", ["commit", "-qm", "init"], { cwd: root });
  return root;
}
const realGit = (root: string) => async (args: string[]) => {
  try {
    const { stdout, stderr } = await run("git", args, { cwd: root });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

// 工作树必须落在 <repoRoot>/.worktree 下：它是集中排除清单里的一项，位置写死才便于一处维护。
test("resolveWorktreeRoot 落在仓库根的 .worktree", () => {
  assert.ok(resolveWorktreeRoot("/tmp/x").endsWith(join(".worktree")));
});

test("add 建出工作树并可被 list 看见", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  const list = await m.list();
  assert.equal(list.length, 1);
  assert.ok(list[0].path.includes(join(".worktree", "wi1-a")));
  assert.equal(list[0].branch, "squad/wi1/a");
});

test("remove 后 list 为空", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/wi1/a", base: "main", dirName: "wi1-a" });
  await m.remove("wi1-a");
  assert.equal((await m.list()).length, 0);
});

// git 失败必须把 stderr 带出来：上层要据此区分「同分支双挂」这类可读原因。
test("git 失败时返回码与 stderr 都被保留", async () => {
  const root = await makeRepo();
  const git = async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" });
  const m = createWorktreeManager({ git, repoRoot: root });
  await assert.rejects(m.add({ branch: "b", base: "main", dirName: "d" }), /not a git repository/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/worktreeManager.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`gitRunner.ts`：`createGitRunner()` 用 `node:child_process` 的 `execFile("git", args, { cwd })`，**不抛**、统一返回 `{code, stdout, stderr}`；仅当 `code !== 0` 时由调用方决定是否抛。

`worktreeManager.ts`：
- `add`：`git worktree add -b <branch> <path> <base>`；`code !== 0` 时**抛带 stderr 的错误**（让上层能读到 `branch-in-other-worktree` 这类原因）。
- `list`：`git worktree list --porcelain`，解析 `worktree <path>` / `branch refs/heads/<name>`。
- `remove`：`git worktree remove --force <path>`（force 是因为队员可能留了未提交改动，而这是**抛弃语义**）。
- `prune`：`git worktree prune`。
- 目录固定 `resolveWorktreeRoot(repoRoot)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/worktreeManager.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §6.1–6.4、§13 C10）：
- 目录是否固定在 `<repoRoot>/.worktree/`？
- `list` 解析的分支名是否与 `add` 写入的一致？
- 失败时**是否把 stderr 带出**（上层需要据此分因）？

**② 穷举**（先列全集再逐格给结论）：
| 枚举空间 | 全集 | 处理/覆盖 |
|---|---|---|
| 操作 | add / remove / list / prune | |
| `add` 输入 | 合法 / 分支已存在 / base 不存在 / dirName 已存在 / dirName 含 `/` 或 `..` | |
| `remove` 输入 | 存在 / 不存在 / 有未提交改动 | |
| `list` 输出 | 主工作树是否被算入（**必须排除**，否则「队员数」统计会多 1） | |
| git 返回 | code 0 / 非 0（stderr 保留） | |

逐格给「有测试 / 由代码保证 / 不适用+理由」。**空缺先补。**

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/worktree/gitRunner.ts packages/services/src/worktree/worktreeManager.ts packages/services/test/worktreeManager.test.ts
git commit -m "feat(worktree): git 执行封装与工作树管理器（add/remove/list/prune）"
```

---

### Task 2: 分支命名与派生（禁止同分支双挂）

**Files:**
- Create: `packages/services/src/worktree/branchNaming.ts`
- Test: `packages/services/test/branchNaming.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorktreeManager`
- Produces:
  - `type BranchPlan = { integration: string; member: string }`
  - `planBranches(input: { workItemSlug: string; agentSlug: string }): BranchPlan`
    - **命名必须 D/F 安全**（P2a T3 实测发现）：git 分支是文件系统 ref，**`squad/<wi>` 与 `squad/<wi>/<agent>` 不可能共存**（D/F 冲突，`cannot lock ref`）。故**从第二段起就分叉**：集成分支 `squad/integration/<wi>`、队员分支 `squad/member/<wi>/<agent>`。**任何用路径层级命名的 ref 都受此约束。**
  - `INTEGRATION_NAMESPACE = "squad/integration/"` 与 `MEMBER_NAMESPACE = "squad/member/"` —— **两个命名空间常量**（T2 修复轮的落地形态）。**构造性守卫**：两常量互为**非前缀**（`integration` vs `member`），故任一构件都不可能成为另一构件的 `x/` 祖先 ⇒ D/F 冲突**构造排除**，无需事后调 git 探测。守卫由**两条测试**承担（36 组 slug 全排列互不为前缀 + 敏感值反例 `wi:"member"`），外加一条**真实 git 共存用例**（同仓库同时建两分支并各自 `worktree add`）。
    - 计划原先列出的 `assertNamespaceDisjoint(): void` **不再产出**：「名字不相交」是**常量取值即定**的静态事实，另立一个运行时函数只是把同一件事再说一遍，还给调用方留一个「以为它真会检查点什么」的空壳。守卫改由测试表达。
  - `createBranchAllocator(deps: { manager: WorktreeManager }): { allocate(plan: BranchPlan, base: string): Promise<{ memberPath: string }> }`
  - `assertSafeSlug(slug: string): void`（拒空、`/`、`..`、非 `[a-z0-9-]`）

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeSlug, planBranches } from "../src/worktree/branchNaming.js";

test("分支命名：集成分支 + 队员分支（D/F 安全：第二段即分叉）", () => {
  assert.deepEqual(planBranches({ workItemSlug: "wi-42", agentSlug: "ta-x" }), {
    integration: "squad/integration/wi-42",
    member: "squad/member/wi-42/ta-x",
  });
});

// 守卫：两个命名空间必须在 squad/ 之后的第一段就分叉，否则会出现「一个是另一个的前缀」
// 从而 D/F 冲突——git 里 squad/x 与 squad/x/y 不可共存（实测 cannot lock ref）。
test("集成分支与队员分支不构成前缀关系（任意 slug 都不会撞）", () => {
  for (const wi of ["a", "member", "integration", "x-y"]) {
    const p = planBranches({ workItemSlug: wi, agentSlug: "a" });
    assert.equal(p.integration.startsWith(`${p.member}/`), false);
    assert.equal(p.member.startsWith(`${p.integration}/`), false);
  }
});

// 关键反例：若把集成分支写成 squad/<wi>，当 wi 恰为 "member" 时会与队员分支 squad/member/... 撞。
test("slug 取 member/integration 这类敏感值时仍不冲突", () => {
  const p = planBranches({ workItemSlug: "member", agentSlug: "integration" });
  assert.equal(p.integration, "squad/integration/member");
  assert.equal(p.member, "squad/member/member/integration");
});

// slug 直接进分支名与目录名，必须限制在安全字符集内，否则可构造出路径逃逸或非法 ref。
test("assertSafeSlug 拒空/斜杠/点点/大写/空格", () => {
  for (const bad of ["", "a/b", "..", "A", "a b", "a_b"]) {
    assert.throws(() => assertSafeSlug(bad), /slug/);
  }
});

test("assertSafeSlug 接受合法 slug", () => {
  for (const ok of ["a", "wi-42", "ta-x-1", "a1"]) assert.doesNotThrow(() => assertSafeSlug(ok));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/branchNaming.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`planBranches` 拼接两个 slug；`assertSafeSlug` 用 `/^[a-z0-9][a-z0-9-]*$/` 校验（并显式拒绝 `..`）。

`createBranchAllocator.allocate`：先 `assertSafeSlug` 两个 slug → `manager.add({ branch: plan.member, base, dirName: <workItemSlug>-<agentSlug> })`。**同分支双挂由 git 拒绝**，此处把 stderr 包成可读错误（含「同分支已被另一工作树占用」的提示）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/branchNaming.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §6.4）：
- 「每队员独立分支」是否真的保证（两个队员调用同一 `plan` 会不会撞）？
- slug 是否真的能挡住路径逃逸与非法 ref？

**② 穷举**：
| 枚举空间 | 全集 | 处理/覆盖 |
|---|---|---|
| slug 字符 | 空 / 合法 / 大写 / 空格 / `_` / `/` / `..` / 超长 | |
| 两名队员同 base 并行 | 分支不同 → 都成功；分支相同 → **第二个可读失败** | |
| base 不存在 | 失败且 stderr 保留 | |

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/worktree/branchNaming.ts packages/services/test/branchNaming.test.ts
git commit -m "feat(worktree): 分支命名与派生（每队员独立分支 + slug 安全校验）"
```

---

### Task 3: 串行合并到集成分支

**Files:**
- Create: `packages/services/src/worktree/integrationMerge.ts`
- Test: `packages/services/test/integrationMerge.test.ts`

**Interfaces:**
- Produces:
  - `type MergeOutcome = { ok: true; branch: string } | { ok: false; reason: "conflict" | "branch_missing"; detail: string }`
  - `createIntegrationMerger(deps: { git: GitRunner; repoRoot: string; base: string }): { ensureIntegration(branch: string): Promise<void>; mergeMember(input: { integration: string; member: string }): Promise<MergeOutcome>; finalize(input: { integration: string; target: string }): Promise<MergeOutcome>; discardMember(input: { branch: string; dirName: string }): Promise<void> }`
  - **`discardMember` = 抛弃语义的落点**（spec §6.3「合并后分支删（队员分支与集成分支都删）」）：先 `git worktree remove --force`，**再 `git branch -D <member>`**。顺序不可颠倒——工作树还挂着时删分支会失败。
  - **为什么必须有人删分支**（Task 2 实测发现的真空）：`git worktree add` **失败时会先建出分支再失败**，留下无工作树的分支残枝；而 Task 1 的 `remove()` 只删工作树。**若无人删分支，该队员会永久卡在「分支已存在」**——这正是「清理是正确性前置」的反面。测试必须锁死：`discardMember` 之后，**同一分支可重新 `add` 成功**。
  - **`base` 由工厂 deps 显式给出**（集成分支从它派生），不靠「调用方在别处给」——否则「集成分支不存在时怎么办」没有答案。
  - `ensureIntegration(branch)`：集成分支不存在则从 `base` 创建；已存在则幂等返回。`mergeMember` 前必须先调它（或由内部隐式调用，二选一并写清楚）。

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
// （沿用 Task 1 的 makeRepo / realGit 夹具，或抽到 test/helpers/gitFixture.ts 共用）
import { createIntegrationMerger } from "../src/worktree/integrationMerge.js";

test("无冲突时合入集成分支", async () => {
  const root = await makeRepo();
  // 建集成分支 + 一个改了不同文件的队员分支
  const merger = createIntegrationMerger({ git: realGit(root), repoRoot: root });
  const out = await merger.mergeMember({ integration: "squad/wi1", member: "squad/wi1/a" });
  assert.equal(out.ok, true);
});

// 冲突必须返回结构化结果而不是抛：上层要据此把工作项置 blocked 并发通知。
test("冲突时返回 { ok:false, reason:'conflict' } 且不抛", async () => {
  const root = await makeRepo();
  const merger = createIntegrationMerger({ git: realGit(root), repoRoot: root });
  const out = await merger.mergeMember({ integration: "squad/wi1", member: "squad/wi1/conflict" });
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.reason, "conflict");
});

// 冲突后集成分支必须回到合并前状态（不得留成半合并）：否则后续队员会被连坐。
test("冲突后集成分支不留半合并状态", async () => {
  const root = await makeRepo();
  const merger = createIntegrationMerger({ git: realGit(root), repoRoot: root });
  await merger.mergeMember({ integration: "squad/wi1", member: "squad/wi1/conflict" });
  const status = await realGit(root)(["status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "");
});
```

（夹具需在测试内真实构造：集成分支 `squad/wi1` 从 `main` 出，两个队员分支分别改**同一文件的同一行**以造冲突、改**不同文件**以造成功。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/integrationMerge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`mergeMember`：
1. 校验 `integration` 与 `member` 都存在（否则 `{ok:false, reason:"branch_missing"}`）——**集成分支缺失时先调 `ensureIntegration`**（或直接返回 `branch_missing`，二选一，写清并在测试里固定）；
2. 在**仓库主工作树**上 `git checkout <integration>`；
3. `git merge --no-ff <member>`；`code !== 0` → **`git merge --abort`** 回滚，返回 `{ok:false, reason:"conflict", detail: stderr}`；
4. 成功 → `{ok:true}`。

`finalize`：把集成分支合回 `target`，同样冲突 → `abort` 并返回 `conflict`。

**串行性**由调用方保证（本模块不做锁）——但**必须在注释里写明**：同一集成分支的并发 merge 会互相踩，接线时须串行调用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/integrationMerge.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §6.3）：
- 合并目标是**集成分支**吗？整批通过后才合主分支（`finalize` 与 `mergeMember` 是否分开）？
- 冲突时**是否 abort**（spec 要求不留半合并状态）？
- 「串行」这条约束**有没有在注释里写明**（本模块不做锁，靠调用方）？

**② 穷举**：
| 枚举空间 | 全集 | 处理/覆盖 |
|---|---|---|
| 结局 | 成功 / 冲突 / 分支不存在 | |
| 冲突后状态 | 工作区干净 / 仍在 merge 中（**必须干净**） | |
| `finalize` | 成功 / 冲突 / target 不存在 | |
| 连续合多个队员 | a 成功 → b 成功 / a 成功 → b 冲突（**a 的成果是否保留**） | |

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/worktree/integrationMerge.ts packages/services/test/integrationMerge.test.ts
git commit -m "feat(worktree): 串行合并到集成分支（冲突不抛 + abort 回滚）"
```

---

### Task 4: 孤儿回收（清理是重派发的正确性前置）

**Files:**
- Create: `packages/services/src/worktree/orphanReaper.ts`
- Test: `packages/services/test/orphanReaper.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `WorktreeManager`；Task 2 的 `MEMBER_NAMESPACE`；Task 3 的 `resolveWorktreeRoot` 与 `deleteBranch`
- Produces:
  - `type ReapInput = { activeBranches: readonly string[] }`
  - `type ReapOutcome = { reclaimed: string[]; kept: string[]; foreign: string[] }`
    - `foreign` = 「存在于本仓库、但**不属于本流程**」的工作树（例如用户自己 `git worktree add` 的）。**按设计不动它们**，但**必须报出来**——把「静默跳过」变成「可见跳过」。（实现若取了同义的别的字段名，以代码为准并在报告中说明。）
  - `createOrphanReaper(deps: { manager: WorktreeManager; repoRoot: string; deleteBranch: (branch: string) => Promise<void>; listBranches: (prefix: string) => Promise<string[]> }): { reap(input: ReapInput): Promise<ReapOutcome> }`
  - **`reap` 必须连分支一起回收**（不只是工作树）：回收后**该分支必须能重新 `add` 成功**。否则「清理是正确性前置」只做了一半——孤儿分支同样会占住分支名，让重派发撞上「分支已存在」。
  - **归属按「根」判，不按路径形状猜**：只认 `<repoRoot>/.worktree/<dirName>`（用 `resolveWorktreeRoot(repoRoot)`，**不得再写第二处 `.worktree` 字面量**）。**遇到不属于本流程的工作树 → 不抛、不碰、进 `foreign`**。
    - **为什么不抛**（2026-10-01 裁定）：抛错会让「用户仓库里存在他自己的 worktree」变成**启动回收的永久故障**——孤儿永远清不掉，反而让重派发撞 `branch already exists`。而这本是一个完全正当、与我们无关的情况。spec §6.6 把回收列为**启动时**必须完成的恢复步骤，这条路径不能因无关原因长期失败。
  - **分支残枝必须进视野**（2026-10-01 裁定）：`worktree add` **先建分支、后因目标目录非空失败**（Task 1/3 实测），留下**有分支、无工作树**的孤儿——它不在 `worktree list` 里，`prune()` 也不删分支。这是本模块存在的**主要理由**（doc 注释第一句「清理是重派发的正确性前置」就是冲它说的）。⇒ **在工作树那一遍之后**，枚举 `squad/member/**` 分支，删掉**既不在 `activeBranches` 里、也未被任何存活工作树检出**的那些。
    - 顺序不可颠倒：先摘树（第一遍），再判「未被检出」（第二遍）。
    - **绝不触碰 `squad/integration/**`**：集成分支承载整批未合并成果，删它就是丢活；它由 Task 3 的 `discardIntegration` 在**整批合回主分支之后**删。此边界须有测试钉住。
  - `deleteBranch` 由 deps 注入（与 `discardMember` 共用同一实现，避免两处各写一遍 `git branch -D`）。

- [ ] **Step 1: 写失败测试**

> 下列样例为**意图示意**；`deps` 以 Interfaces 为准（`repoRoot` / `deleteBranch` / `listBranches` 均为必填，`deleteBranch` 需**绑定**成单参）。分支名用 Task 2 的 D/F 安全命名（`squad/member/<wi>/<agent>`）。

```ts
test("回收不在活跃集合里的工作树", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/member/wi1/a", base: "main", dirName: "wi1-a" });
  await m.add({ branch: "squad/member/wi1/b", base: "main", dirName: "wi1-b" });
  const reaper = createOrphanReaper({ manager: m, repoRoot: root, deleteBranch, listBranches });
  const out = await reaper.reap({ activeBranches: ["squad/member/wi1/a"] });
  assert.deepEqual(out.reclaimed, ["wi1-b"]);
  assert.deepEqual(out.kept, ["wi1-a"]);
});

// 这条是「清理是正确性前置」的机器化证明：回收后同一分支必须能重新建。
test("回收后同一分支可重新建工作树", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/member/wi1/a", base: "main", dirName: "wi1-a" });
  await createOrphanReaper({ manager: m, repoRoot: root, deleteBranch, listBranches })
    .reap({ activeBranches: [] });
  await assert.doesNotReject(m.add({ branch: "squad/member/wi1/a", base: "main", dirName: "wi1-a" }));
  assert.equal((await m.list()).length, 1);
});

// 只回收工作树而留下分支残枝，会让重派发撞上「分支已存在」——所以 reap 必须连分支一起收。
test("回收后孤儿分支确实不存在了", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/member/wi1/orphan", base: "main", dirName: "wi1-orphan" });
  await createOrphanReaper({ manager: m, repoRoot: root, deleteBranch, listBranches })
    .reap({ activeBranches: [] });
  const branches = await realGit(root)(["branch", "--list", "squad/member/wi1/orphan"]);
  assert.equal(branches.stdout.trim(), "");
});

// 未合并（仍在活跃集合里）的工作树绝不能被回收：否则队员的活白干。
test("活跃分支对应的工作树被保留", async () => {
  const root = await makeRepo();
  const m = createWorktreeManager({ git: realGit(root), repoRoot: root });
  await m.add({ branch: "squad/member/wi1/review", base: "main", dirName: "wi1-review" });
  const out = await createOrphanReaper({ manager: m, repoRoot: root, deleteBranch, listBranches })
    .reap({ activeBranches: ["squad/member/wi1/review"] });
  assert.deepEqual(out.kept, ["wi1-review"]);
});

// 【必须补】分支残枝：有分支、无工作树（真实成因：git worktree add 先建分支后失败）。
test("分支残枝（有分支、无工作树）也被回收", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await git(["branch", "squad/member/wi1/residue", "main"]); // 只建分支，不挂树
  const reaper = createOrphanReaper({ manager: createWorktreeManager({ git, repoRoot: root }), repoRoot: root, deleteBranch, listBranches });
  await reaper.reap({ activeBranches: [] });
  assert.equal((await git(["branch", "--list", "squad/member/wi1/residue"])).stdout.trim(), "");
});

// 【必须补】集成分支不在 reap 视野内：它承载整批未合并成果，删它就是丢活。
test("集成分支不被回收（归 discardIntegration 管）", async () => {
  const root = await makeRepo();
  const git = realGit(root);
  await git(["branch", "squad/integration/wi1", "main"]);
  await createOrphanReaper({ manager: createWorktreeManager({ git, repoRoot: root }), repoRoot: root, deleteBranch: (b) => deleteBranch(git, root, b), listBranches: (p) => listBranches(git, p) })
    .reap({ activeBranches: [] });
  assert.equal((await git(["branch", "--list", "squad/integration/wi1"])).stdout.trim(), "squad/integration/wi1");
});

// 【必须补】外来工作树：不抛、不碰、进 foreign。
test("非本流程的工作树不被回收，但被报为 foreign", async () => {
  // 夹具：在仓库根下建一个用户自己的工作树（不在 .worktree/ 里），断言 reap 不抛、
  // 该工作树与其分支原封不动、且出现在 out.foreign 中。
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 最小实现**：`reap` 取 `manager.list()`，对不在 `activeBranches` 的项 `remove` 并记入 `reclaimed`，其余 `kept`；末尾调 `manager.prune()`。**注意排除主工作树**（Task 1 的 `list` 已排除）。
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §6.4）：回收是否真的让同分支可重挂？未合并的是否真的保留？启动时机（spec §3.10「startup 回收」）是否在文档里写明？
**② 穷举**：`activeBranches` × {空, 含全部, 含部分, 含不存在的分支}；目录里有非 worktree 的散落文件（`remove` 是否会影响它）。

- [ ] **Step 6: 提交**

```bash
git commit -m "feat(worktree): 孤儿回收（活跃集合外的回收 + 同分支可重挂）"
```

---

### Task 5: 排除清单集中维护 + 关闭 P1 的路径逃逸隐患

**Files:**
- Modify: 仓库根 `.gitignore`（加 `/.worktree/`）
- Modify: 扫描排除处（与 `.zcode/` 同处，spec §13 C10 要求**集中一处维护**）
- Modify: `packages/services/src/teams/teamAgentStorage.ts`（`definitionPath` 加单路径段校验）
- Test: `packages/services/test/teamAgentStorage.test.ts`（补 `..` / `/` / 空串用例）

**Interfaces:**
- Consumes: Task 1 的 `resolveWorktreeRoot`

- [ ] **Step 1: 写失败测试**

```ts
// 关闭 spec §17 登记的隐患：id 直接进文件路径，未校验则可逃出实验命名空间。
test("writeTeamAgent 拒绝路径逃逸的 id", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  for (const bad of ["../evil", "a/b", "", ".."]) {
    assert.throws(() => writeTeamAgent(root, { id: bad, name: "x", systemPrompt: "s", memoryScope: "project", enabled: true }), /id/);
  }
});

test("deleteTeamAgent 拒绝路径逃逸的 id", () => {
  const root = mkdtempSync(join(tmpdir(), "ws-"));
  assert.throws(() => deleteTeamAgent(root, "../evil"), /id/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Expected: FAIL（当前 `../evil` 会被接受 → 测试红）

- [ ] **Step 3: 最小实现**

在 `definitionPath`（**唯一收口**）加 `basename(id) === id && id !== "." && id !== ".." && id !== ""` 的断言并抛错——**读写两侧都经过它，故一处即够**（这是 P1 Task 2 在 `squadStorage` 里已用过的手法，此处补齐 `teamAgentStorage`）。

`.gitignore` 加 `/.worktree/`；扫描排除处加 `.worktree/`（与 `.zcode/` 放同一处，注释写明「新增产物目录在此登记」）。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §13 C10、§17）：
- 排除清单是否**集中一处**（还是散在两处）？
- P1 登记的 `definitionPath` 隐患是否**真的闭合**（读写两侧都过闸）？
- `.worktree/` 是否**同时**进了 gitignore 与扫描排除？

**② 穷举**：id × {合法, `..`, `a/b`, 空串, `"."`, 绝对路径}；`deleteTeamAgent` 与 `writeTeamAgent` 是否都覆盖；排除清单是否覆盖 `.zcode/squad/`、`.worktree/`、`.wiki/`。

- [ ] **Step 6: 提交**

```bash
git commit -m "feat(worktree): 排除清单集中登记 + 关闭 teamAgentStorage 的路径逃逸隐患"
```

---

## 计划的自我审查（Self-Review）

**1. Spec 覆盖**（spec §15 P2 的「工作树隔离与合并」部分）：
- 工作树建/合/抛 → Task 1、2、3
- 集成分支 → Task 3
- 孤儿清理 → Task 4
- 排除清单（C10）→ Task 5
- 关闭 P1 登记的前置隐患 → Task 5
- **未覆盖（属 P2b/P2c）**：接线到调度器、智能体目录/独立会话 UI、评论/活动时间线、共享沟通会话、`filters → eventKey` 的幂等键定义。

**2. 占位符扫描**：无 `TBD`/`TODO`；每个代码步骤给了可执行代码或精确 git 命令。「沿用 Task 1 的夹具」是**共享测试夹具**（应在 Task 3 时抽到 `packages/services/test/helpers/gitFixture.ts`），不是占位符。

**3. 类型一致性**：`GitRunner`（T1）→ `WorktreeManager`（T1）→ 被 T2/T3/T4 消费；`MergeOutcome` 的 `reason` 字面量与 Review Focus 的用词一致；`resolveWorktreeRoot` 只定义一次。

**4. Review Focus 落点**：五条隐含失败模式各有归属任务与其测试——同分支双挂（T2）、冲突不回滚（T3）、孤儿占分支（T4）、未合并被回收（T4）、路径逃逸（T5）。

**5. 审查两法已内置**：每个任务 Step 5 拆成 **① 逆推**（对 spec 具体小节逐条反查）+ **② 穷举**（先列全集矩阵再逐格给结论）；**只有逆推视为未完成审查**。
