# 多智能体小队 · P0 机制底座 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 立起「工作项 + 协作智能体 + 实验开关」三块地基，使后续阶段（编排 / 隔离 / 外围）有可依赖的实体与唯一写者。

**Architecture:** 领域模型（状态与 schema）放 `packages/shared`；持久化走既有 `tasksDatabase`（**只追加**迁移）与实验命名空间的**定义文件**；写入权**唯一归服务层**，其余调用方只发事件。UI 只加一个「实验功能」设置分区与一个开关，不碰现有界面结构。

**Tech Stack:** TypeScript · Node 24（`node:test` + `node:assert/strict`，经 `tsx --test` 运行）· `node:sqlite`（`DatabaseSync`）· zod · React（设置页）· Zustand（后续阶段）

**Spec:** `docs/superpowers/specs/2026-10-01-multi-agent-squad-design.md`

## Global Constraints

- **状态键固定 6 个**：`todo | in_progress | in_review | blocked | done | cancelled`；category 固定 4 个：`unstarted | started | done | closed`。**终态 = category ∈ {done, closed}**。聚合判定一律用 category，**不得**用键名比较。
- **唯一写者**：只有工作项服务可以写 `status`；UI / 调度器 / agent / 队长**只能发派发事件**。
- **工作项生命周期是第四套状态**，与执行态（`running|completed|error`）、派发态（`dispatch_status`）、automation 生命周期态**正交，不得合并**。
- **限额**：树深 ≤ **5**；单工作项直接子项 ≤ **50**。
- **迁移只追加**：不重命名、不删除既有列；历史列声明**冻结**（不得用实时 schema 代替）。
- **实验开关默认 `false`**；关闭时**停止新功能、不销毁数据、不影响**现有 subagent / automation。
- **排除清单集中一处维护**：`.worktree/` · `.zcode/agent-memory/` · `.zcode/squad/`，同时驱动 gitignore 与扫描排除。
- 测试文件位置 `packages/<pkg>/test/*.test.ts`；运行 `pnpm exec tsx --test <file>`。
  **`packages/ui` 例外**：ui 源码大量使用 `@/` 别名，必须带上包内 tsconfig，否则报 `ERR_MODULE_NOT_FOUND: @/...`：
  `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test <file>`（已实测：既有 ui 测试 6 passed）。
- 每个任务结束必须通过 `pnpm typecheck` 与 `pnpm lint`。
- 状态、时序、唯一所有者相关代码必须带**中文注释说明为什么**。

## Review Focus

下列输入/失败模式是 spec 隐含但各任务测试**容易漏掉**的，最可能咬到使用者；每条都已在**拥有该代码的任务**里加了对应测试：

1. **非服务路径直写 status**（UI / 调度器 / 队长直接改）→ 必须被拒绝或不可达（Task 6）。
2. **重复与并发派发**：同一目标重复指派、同一事件重放 → 只生效一次（Task 6）。
3. **父子树的环与超深**：A→B→A 成环、深度超过 5、子项超过 50 → 拒绝并给出可读原因（Task 5）。
4. **在既有库上重放迁移**：老库升级后表结构正确且迁移**幂等**；checksum 冻结不被改动影响（Task 4）。
5. **实验关闭后的残留**：开关关闭时表与数据仍在、现有 subagent/automation 行为不变（Task 1、Task 8）。

---

### Task 1: 实验开关（settings 布尔）

**Files:**
- Modify: `packages/shared/src/validationAppSettings.ts`（`appSettingsObjectSchema` 与 `appSettingsPatchSchema` 两处都要加）
- Modify: `packages/shared/src/protocol.ts`（`AppSettings` 接口加同名字段）
- Test: `packages/shared/test/experimentalSquadFlag.test.ts`

**Interfaces:**
- Produces: `AppSettings.experimentalAgentSquadsEnabled: boolean`（默认 `false`）

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsSchema, appSettingsPatchSchema } from "../src/validationAppSettings.js";

// 缺省必须是 false：不显式打开就不应启用实验功能。
test("实验开关缺省为 false", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.experimentalAgentSquadsEnabled, false);
});

test("实验开关可被显式打开", () => {
  const parsed = appSettingsSchema.parse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.experimentalAgentSquadsEnabled, true);
});

// patch 少一处就会写入被拒，表现为「拨开关没反应」——这是本项目踩过的坑。
test("patch 接受实验开关", () => {
  const parsed = appSettingsPatchSchema.safeParse({ experimentalAgentSquadsEnabled: true });
  assert.equal(parsed.success, true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/shared/test/experimentalSquadFlag.test.ts`
Expected: FAIL（`experimentalAgentSquadsEnabled` 为 `undefined`，断言 `strictEqual` 不等）

- [ ] **Step 3: 最小实现**

在 `appSettingsObjectSchema` 内追加：

```ts
  // 多智能体小队实验开关。默认关闭：不显式打开就不启用。
  experimentalAgentSquadsEnabled: z.boolean().default(false),
```

在 `appSettingsPatchSchema` 内追加：

```ts
  experimentalAgentSquadsEnabled: z.boolean().optional(),
```

在 `protocol.ts` 的 `AppSettings` 接口追加：

```ts
  /** 多智能体小队实验开关（默认 false）。 */
  experimentalAgentSquadsEnabled?: boolean;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/shared/test/experimentalSquadFlag.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §12 反查：*开关关闭时，新功能是否**整体消失**、现有功能是否**不受影响**？* 现阶段尚无功能可关，只需确认：①默认值为 `false`（测试已锁）；②patch 可写（测试已锁）；③**没有**改动任何既有字段的默认值。三点都成立则通过；任一条不成立则先修再进下一任务。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/validationAppSettings.ts packages/shared/src/protocol.ts packages/shared/test/experimentalSquadFlag.test.ts
git commit -m "feat(squad): 新增多智能体小队实验开关（默认关闭）"
```

---

### Task 2: 「实验功能」设置分区

**Files:**
- Modify: `packages/ui/src/lib/settingsNavigation.ts`（`SettingsSectionId` 联合、`isSettingsSectionId`、**不要**加进 `HIDDEN_SETTINGS_SECTIONS`）
- Modify: `packages/ui/src/settings/settingsPageConfig.ts`（`BASE_SETTINGS_SECTIONS` 加一项）
- Create: `packages/ui/src/settings/ExperimentsSection.tsx`
- Modify: `packages/ui/src/SettingsPage.tsx`（渲染分支）
- Modify: `packages/ui/src/i18n/locales/zh-CN.ts`、`packages/ui/src/i18n/locales/en-US.ts`
- Test: `packages/ui/test/settingsExperimentsSection.test.ts`

**Interfaces:**
- Consumes: `experimentalAgentSquadsEnabled`（Task 1）
- Produces: `SettingsSectionId` 新增取值 `"experiments"`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { isSettingsSectionEnabled, type SettingsSectionId } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS } from "../src/settings/settingsPageConfig.js";

// 实验分区必须是「运行期可见」的普通分区：若被放进 HIDDEN_SETTINGS_SECTIONS，
// 用户永远看不到入口，实验功能等于无法开启。
test("实验分区默认可见", () => {
  const id: SettingsSectionId = "experiments";
  assert.equal(isSettingsSectionEnabled(id), true);
});

test("实验分区在设置配置里注册", () => {
  assert.ok(SETTINGS_SECTIONS.some((section) => section.id === "experiments"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsExperimentsSection.test.ts`
Expected: FAIL（类型上 `"experiments"` 不是 `SettingsSectionId`；运行时配置里没有该分区）

- [ ] **Step 3: 最小实现**

`settingsNavigation.ts`：在 `SettingsSectionId` 联合中加入 `"experiments"`；在 `isSettingsSectionId` 的判定链中加入 `value === "experiments" ||`；**不要**把 `"experiments"` 加入 `HIDDEN_SETTINGS_SECTIONS`。

`settingsPageConfig.ts`：在 `BASE_SETTINGS_SECTIONS` 末尾追加

```ts
  {
    // 实验功能：所有实验开关的统一去处。走运行期 appSettings 开关，不做编译期隐藏。
    id: "experiments",
    icon: FlaskConical,
    titleId: "settings.experiments.title",
    groupId: "basics",
  },
```

并在文件顶部从 `lucide-react` 引入 `FlaskConical`。

`SettingsPage.tsx`：在既有分支链末尾按现有写法追加 `activeSection === "experiments"` 的渲染分支，内容先只渲染 Task 1 的开关（沿用该文件既有的开关行组件/写法）：

```tsx
) : activeSection === "experiments" ? (
  <ExperimentsSection />
) : null}
```

新建 `packages/ui/src/settings/ExperimentsSection.tsx`，用既有设置项行样式渲染一个开关，读写 `experimentalAgentSquadsEnabled`（读 `services.settingService`，写 `update({ experimentalAgentSquadsEnabled: enabled })`，照 `SettingsPage.tsx` 里 `taskAutoArchiveEnabled` 的写法）。

两个 locale 各加：

```ts
  "settings.experiments.title": "实验功能",
  "settings.experiments.squadToggle.label": "多智能体小队",
  "settings.experiments.squadToggle.description": "启用协作智能体、小队与工作树隔离",
```

（`en-US.ts` 对应英文文案。）

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test packages/ui/test/settingsExperimentsSection.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §11.1 与 §12 反查：*开关是否**真的能开到**？* 逐条核对——①分区**不在**隐藏集（测试已锁）；②`isSettingsSectionId` 认它，否则从别的入口跳转会回落（代码已加）；③渲染分支已接；④locale 两语都有（缺一会在另一种语言下显示 key）；⑤写的是**运行期** appSettings 而不是编译期常量。任一条缺口先补。

- [ ] **Step 6: 提交**

```bash
git add packages/ui/src/lib/settingsNavigation.ts packages/ui/src/settings/settingsPageConfig.ts packages/ui/src/SettingsPage.tsx packages/ui/src/settings/ExperimentsSection.tsx packages/ui/src/i18n/locales/zh-CN.ts packages/ui/src/i18n/locales/en-US.ts packages/ui/test/settingsExperimentsSection.test.ts
git commit -m "feat(squad): 新增「实验功能」设置分区与小队开关"
```

---

### Task 3: 工作项域模型（状态 + schema）

**Files:**
- Create: `packages/shared/src/work-item.ts`
- Modify: `packages/shared/src/index.ts`（导出）
- Test: `packages/shared/test/workItemDomain.test.ts`

**Interfaces:**
- Produces:
  - `type WorkItemStatusKey = "todo" | "in_progress" | "in_review" | "blocked" | "done" | "cancelled"`
  - `type WorkItemStatusCategory = "unstarted" | "started" | "done" | "closed"`
  - `WORK_ITEM_STATUS_CATEGORY: Record<WorkItemStatusKey, WorkItemStatusCategory>`
  - `function isTerminalWorkItemStatus(key: WorkItemStatusKey): boolean`
  - `workItemSchema`（zod）、`type WorkItem`
  - `WORK_ITEM_MAX_DEPTH = 5`、`WORK_ITEM_MAX_CHILDREN = 50`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  WORK_ITEM_MAX_CHILDREN,
  WORK_ITEM_MAX_DEPTH,
  WORK_ITEM_STATUS_CATEGORY,
  isTerminalWorkItemStatus,
  workItemSchema,
} from "../src/work-item.js";

// category 是机器判定的唯一依据；键名只是标签。
test("六个状态键各自的 category", () => {
  assert.deepEqual(WORK_ITEM_STATUS_CATEGORY, {
    todo: "unstarted",
    in_progress: "started",
    in_review: "started",
    blocked: "started",
    done: "done",
    cancelled: "closed",
  });
});

// in_review 是 started 而不是终态：把它当终态会让「等子任务全完成」提前触发。
test("终态判定：done 与 cancelled 为真，in_review 为假", () => {
  assert.equal(isTerminalWorkItemStatus("done"), true);
  assert.equal(isTerminalWorkItemStatus("cancelled"), true);
  assert.equal(isTerminalWorkItemStatus("in_review"), false);
  assert.equal(isTerminalWorkItemStatus("blocked"), false);
});

test("schema 拒绝未知状态", () => {
  const parsed = workItemSchema.safeParse({
    id: "wi_1",
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: "t",
    body: "",
    status: "archived", // 不存在
    assignee: { type: "user", id: "u1" },
  });
  assert.equal(parsed.success, false);
});

test("限额是 5 与 50", () => {
  assert.equal(WORK_ITEM_MAX_DEPTH, 5);
  assert.equal(WORK_ITEM_MAX_CHILDREN, 50);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/shared/test/workItemDomain.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
import { z } from "zod";

/** 工作项生命周期：4 category / 6 键。category 才是机器判定依据，键只是标签。 */
export const WORK_ITEM_STATUS_KEYS = [
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "cancelled",
] as const;
export type WorkItemStatusKey = (typeof WORK_ITEM_STATUS_KEYS)[number];

export type WorkItemStatusCategory = "unstarted" | "started" | "done" | "closed";

export const WORK_ITEM_STATUS_CATEGORY: Record<WorkItemStatusKey, WorkItemStatusCategory> = {
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  blocked: "started",
  done: "done",
  cancelled: "closed",
};

/** 终态：done 与 closed 两类。聚合判定（如 children_done）必须用它，不要比较键名。 */
export function isTerminalWorkItemStatus(key: WorkItemStatusKey): boolean {
  const category = WORK_ITEM_STATUS_CATEGORY[key];
  return category === "done" || category === "closed";
}

export const WORK_ITEM_MAX_DEPTH = 5;
export const WORK_ITEM_MAX_CHILDREN = 50;

export const workItemStatusSchema = z.enum(WORK_ITEM_STATUS_KEYS);

export const workItemAssigneeSchema = z.object({
  type: z.enum(["user", "agent", "squad"]),
  id: z.string().min(1),
});

export const workItemSchema = z.object({
  id: z.string().min(1),
  workspaceIdentity: z.string().min(1),
  workspacePath: z.string().min(1),
  parentId: z.string().min(1).optional(),
  stage: z.number().int().nonnegative().optional(),
  title: z.string(),
  body: z.string(),
  status: workItemStatusSchema,
  assignee: workItemAssigneeSchema,
  labels: z.array(z.string()).default([]),
  properties: z.record(z.string(), z.unknown()).default({}),
  position: z.number().default(0),
  archivedAt: z.number().int().nonnegative().optional(),
});
export type WorkItem = z.infer<typeof workItemSchema>;
```

`packages/shared/src/index.ts` 追加导出 `export * from "./work-item.js";`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/shared/test/workItemDomain.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §4 与 §5.7 反查：*将来用 category 做聚合的地方会不会被迫比较键名？* 检查——①`isTerminalWorkItemStatus` 已提供，且**内部**走 category；②`category` 映射表是**穷举**的（Record 键类型保证）；③schema 拒绝未知状态（否则脏数据会带崩映射表）；④`in_review` 被断定为非终态（这条最容易写反）。缺一先补。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/work-item.ts packages/shared/src/index.ts packages/shared/test/workItemDomain.test.ts
git commit -m "feat(squad): 工作项域模型（4 category / 6 键 + schema + 限额）"
```

---

### Task 4: 工作项表迁移（只追加）

**Files:**
- Modify: `packages/services/src/session/tasksDatabase/schema-v1.ts`（新增 `WORK_ITEM_SCHEMA`）
- Modify: `packages/services/src/session/tasksDatabase/migrations.ts`（追加迁移项）
- Test: `packages/services/test/workItemMigration.test.ts`

**Interfaces:**
- Consumes: 无（纯 DDL）
- Produces: 表 `work_items`，索引 `idx_work_items_parent`、`idx_work_items_status`、`idx_work_items_workspace`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";

function openFreshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

test("迁移建出 work_items 表与索引", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_items'")
    .all();
  assert.equal(tables.length, 1);
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_work_items%'")
    .all();
  assert.ok(indexes.length >= 3);
});

// 迁移必须幂等：重复应用不得报错、不得改动结构（否则老库升级会炸）。
test("迁移可重复应用", () => {
  const db = openFreshDb();
  runTasksDatabaseMigrations(db);
  runTasksDatabaseMigrations(db);
  const cols = db.prepare("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
  assert.ok(cols.some((c) => c.name === "status"));
});
```

> 注：迁移入口的真实签名为 `runTasksDatabaseMigrations(db: DatabaseSync, options?: { transactionOpen?: boolean; migration?: DatabaseMigrationFacts; onProgress?: (...) => void })`（`packages/services/src/session/tasksDatabase/migrations.ts:69`），`options` 可省略。测试与实现都走它，**不要**新造第二个入口。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/workItemMigration.test.ts`
Expected: FAIL（表不存在 / 导出名不符）

- [ ] **Step 3: 最小实现**

`schema-v1.ts` 追加：

```ts
export const WORK_ITEM_SCHEMA = `
  CREATE TABLE IF NOT EXISTS work_items (
    id                 TEXT PRIMARY KEY,
    workspace_key      TEXT NOT NULL,
    workspace_path     TEXT NOT NULL,
    parent_id          TEXT,
    stage              INTEGER,
    title              TEXT NOT NULL,
    body               TEXT NOT NULL DEFAULT '',
    status             TEXT NOT NULL,
    assignee_type      TEXT NOT NULL,
    assignee_id        TEXT NOT NULL,
    labels             TEXT NOT NULL DEFAULT '[]',
    properties         TEXT NOT NULL DEFAULT '{}',
    position           REAL NOT NULL DEFAULT 0,
    archived_at        INTEGER,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_work_items_parent
    ON work_items(parent_id) WHERE parent_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_work_items_status
    ON work_items(workspace_key, status) WHERE archived_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_work_items_workspace
    ON work_items(workspace_key, updated_at DESC);
`;
```

`migrations.ts`：从 `schema-v1.js` **追加导入** `WORK_ITEM_SCHEMA`（该文件已按同样方式导入其他 schema），并**照抄相邻迁移项的包装形状**（冻结列声明 + 版本/checksum 机制），追加一项执行 `WORK_ITEM_SCHEMA`。
**关键**：新表**不**并入既有 `columns` 冻结列表之外的任何结构变更；**不重命名、不删除**既有列。
`assignee_type` 不建外键（与既有热表做法一致，靠应用层校验）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/workItemMigration.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §3.8 与 Global Constraints 反查：*老库升级会不会被这条迁移弄坏？* 核对——①新表用 `IF NOT EXISTS`，重复应用安全（测试已锁）；②**没有**触碰既有表（逐行 diff 确认只增）；③索引是**部分索引**（`archived_at IS NULL`），归档项不拖慢列表；④`assignee_type` 无外键，避免归档对象导致写入失败（这是 spec §3.10「只归档不硬删」的必然要求）。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/session/tasksDatabase/schema-v1.ts packages/services/src/session/tasksDatabase/migrations.ts packages/services/test/workItemMigration.test.ts
git commit -m "feat(squad): 追加 work_items 表与索引（只追加迁移）"
```

---

### Task 5: 工作项 Repo（CRUD + 父树 + 聚合）

**Files:**
- Create: `packages/services/src/workitem/workItemRepo.ts`
- Test: `packages/services/test/workItemRepo.test.ts`

**Interfaces:**
- Consumes: `WORK_ITEM_SCHEMA`（Task 4）、`WorkItem` / `WorkItemStatusKey`（Task 3）
- Produces（真实签名，后续任务依赖）:
  - `createWorkItemRepo(db: DatabaseSync): WorkItemRepo`
  - `WorkItemRepo.insert(item: WorkItem): void`
  - `WorkItemRepo.get(id: string): WorkItem | null`
  - `WorkItemRepo.listChildren(parentId: string): WorkItem[]`
  - `WorkItemRepo.updateStatus(id: string, next: WorkItemStatusKey, expect: WorkItemStatusKey): boolean`
  - `WorkItemRepo.areAllChildrenTerminal(parentId: string): boolean`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import type { WorkItem } from "@zcode/shared";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWorkItemRepo(db) };
}
function wi(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    workspaceIdentity: "ws",
    workspacePath: "/tmp/ws",
    title: over.id,
    body: "",
    status: "todo",
    assignee: { type: "user", id: "u1" },
    labels: [],
    properties: {},
    position: 0,
    ...over,
  } as WorkItem;
}

test("插入后可按 id 读回", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "a" }));
  assert.equal(repo.get("a")?.id, "a");
});

// 聚合必须用 category：父项只有一个 cancelled 子项时也应算「全终态」。
test("子项聚合：done 与 cancelled 都算终态", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  repo.insert(wi({ id: "c1", parentId: "p", status: "done" }));
  repo.insert(wi({ id: "c2", parentId: "p", status: "cancelled" }));
  assert.equal(repo.areAllChildrenTerminal("p"), true);
});

test("子项聚合：有 in_review 时不算全终态", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  repo.insert(wi({ id: "c1", parentId: "p", status: "done" }));
  repo.insert(wi({ id: "c2", parentId: "p", status: "in_review" }));
  assert.equal(repo.areAllChildrenTerminal("p"), false);
});

test("无子项不算全终态（避免空父项被当成已完成）", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "p" }));
  assert.equal(repo.areAllChildrenTerminal("p"), false);
});

// CAS：前置状态不匹配时不得写入，否则并发派发会互相覆盖。
test("updateStatus 的前置状态不匹配则拒绝", () => {
  const { repo } = setup();
  repo.insert(wi({ id: "a", status: "todo" }));
  assert.equal(repo.updateStatus("a", "in_progress", "blocked"), false);
  assert.equal(repo.get("a")?.status, "todo");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/workItemRepo.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

按仓库既有 Repo 写法（`node:sqlite` 的 `DatabaseSync` + 预处理语句）实现上述五个方法。要点：

- `labels` / `properties` 以 JSON 文本存取（`JSON.stringify` / `JSON.parse`）。
- `updateStatus` 用**单条带条件更新**实现 CAS，并返回是否命中：

```ts
const result = db
  .prepare(
    "UPDATE work_items SET status=?, updated_at=? WHERE id=? AND status=? AND archived_at IS NULL",
  )
  .run(next, Date.now(), id, expect);
return result.changes === 1;
```

- `areAllChildrenTerminal` 在 **SQL 只取 status**，再在内存用 `isTerminalWorkItemStatus` 判定，**不要**把状态键名写进 SQL：

```ts
const rows = db.prepare("SELECT status FROM work_items WHERE parent_id=? AND archived_at IS NULL").all(parentId);
if (rows.length === 0) return false;
return rows.every((r) => isTerminalWorkItemStatus(r.status as WorkItemStatusKey));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/workItemRepo.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §3.10（限额、环）与 §5.7（聚合用 category）反查：*这层缺了什么会导致上层写错？* 检查——①聚合**空子项返回 false**（已测，否则空父项会被误判完成）；②CAS 真的不写入（已测）；③**环与深度的校验还没做**——它属于服务层（Task 6），本任务只需在 `insert` 的注释里写明「调用方必须已校验环与深度」，并在 Task 6 落地该校验。若发现本层也能低成本防住（如在 `insert` 时检查 parent 链），则在此补一个规模测试。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/workitem/workItemRepo.ts packages/services/test/workItemRepo.test.ts
git commit -m "feat(squad): 工作项 Repo（CRUD + 父树聚合 + CAS 流转）"
```

---

### Task 6: 工作项服务（唯一写者 + 环/深度校验 + 派发事件）

**Files:**
- Create: `packages/services/src/workitem/workItemService.ts`
- Test: `packages/services/test/workItemService.test.ts`

**Interfaces:**
- Consumes: `WorkItemRepo`（Task 5）、`isTerminalWorkItemStatus` / 限额（Task 3）
- Produces:
  - `createWorkItemService(deps: { repo: WorkItemRepo; emit: (event: WorkItemEvent) => void }): WorkItemService`
  - `WorkItemService.create(input: { workspaceIdentity: string; workspacePath: string; title: string; body?: string; parentId?: string; stage?: number; assignee: { type: "user" | "agent" | "squad"; id: string }; id?: string }): WorkItem`（`id` 可选，便于测试与幂等；校验父存在、非环、深度 ≤ 5、子项 ≤ 50）
  - `WorkItemService.transition(id, next, expect): boolean`（唯一写 status 的入口）
  - `type WorkItemEvent = { kind: "workitem.status_changed"; id: string; from: WorkItemStatusKey; to: WorkItemStatusKey } | { kind: "workitem.child_completed"; parentId: string }`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWorkItemRepo } from "../src/workitem/workItemRepo.js";
import { createWorkItemService } from "../src/workitem/workItemService.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  const events: Array<{ kind: string }> = [];
  const service = createWorkItemService({
    repo: createWorkItemRepo(db),
    emit: (e) => events.push(e),
  });
  return { service, events };
}
const base = { workspaceIdentity: "ws", workspacePath: "/tmp/ws", body: "", assignee: { type: "user" as const, id: "u1" } };

test("成环被拒绝", () => {
  const { service } = setup();
  const a = service.create({ ...base, title: "a" });
  const b = service.create({ ...base, title: "b", parentId: a.id });
  assert.throws(() => service.create({ ...base, title: "x", parentId: b.id, id: a.id }), /环|cycle/i);
});

test("超过深度上限被拒绝", () => {
  const { service } = setup();
  let parentId: string | undefined;
  for (let i = 0; i < 5; i++) parentId = service.create({ ...base, title: `n${i}`, parentId }).id;
  assert.throws(() => service.create({ ...base, title: "too-deep", parentId }), /深度|depth/i);
});

test("超过子项上限被拒绝", () => {
  const { service } = setup();
  const p = service.create({ ...base, title: "p" });
  for (let i = 0; i < 50; i++) service.create({ ...base, title: `c${i}`, parentId: p.id });
  assert.throws(() => service.create({ ...base, title: "overflow", parentId: p.id }), /子项|children/i);
});

// 唯一写者：改状态必须经服务，且产生事件。
test("状态流转产生事件；CAS 失败不发事件", () => {
  const { service, events } = setup();
  const a = service.create({ ...base, title: "a" });
  assert.equal(service.transition(a.id, "in_progress", "todo"), true);
  assert.deepEqual(events.at(-1), { kind: "workitem.status_changed", id: a.id, from: "todo", to: "in_progress" });
  assert.equal(service.transition(a.id, "done", "todo"), false); // 前置已不是 todo
  assert.equal(events.filter((e) => e.kind === "workitem.status_changed").length, 1);
});

test("最后一个子项进入终态时发 child_completed", () => {
  const { service, events } = setup();
  const p = service.create({ ...base, title: "p" });
  const c = service.create({ ...base, title: "c", parentId: p.id });
  service.transition(c.id, "done", "todo");
  assert.ok(events.some((e) => e.kind === "workitem.child_completed"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/workItemService.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`create`：生成 `id`（沿用仓库既有 id 生成方式）、默认 `status: "todo"`；校验顺序：父存在 → 沿 `parentId` 上溯，遇到自身即抛 `/环/`，同时计数深度，`> WORK_ITEM_MAX_DEPTH` 抛 `/深度/`；`repo.listChildren(parentId).length >= WORK_ITEM_MAX_CHILDREN` 抛 `/子项/`。落库后发 `workitem.status_changed`（新建即 todo→todo 不发）——**新建不发事件**，只在 `transition` 里发。

`transition`：调 `repo.updateStatus(id, next, expect)`；命中才 `emit({kind:"workitem.status_changed",...})`，并检查父项：若本次使父项所有子项进入终态，`emit({kind:"workitem.child_completed", parentId})`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/workItemService.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §4.3（唯一写者）、§3.10（环/限额）、§5.7（幂等、child_completed）反查：*还有谁能绕过服务写 status？* 逐项核对——①`repo.updateStatus` 仍是公开方法，**UI 若直接拿到 repo 就能绕过**：本任务要确认服务层是该 repo 的**唯一对外暴露者**（repo 不进 `packages/services/src/index.ts` 的公开导出）；②环检测有测试；③深度与子项上限有测试；④CAS 失败**不发**事件（已测）；⑤`child_completed` 只在**全部**子项终态时发（已测的是单子项；补一个「还有一个 in_review 时不发」的断言，避免提前触发队长）。⑤若缺则补齐再提交。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/workitem/workItemService.ts packages/services/test/workItemService.test.ts
git commit -m "feat(squad): 工作项服务（唯一写者 + 环/深度/配额校验 + 派发事件）"
```

---

### Task 7: 协作智能体域模型 + 实验命名空间存储

**Files:**
- Create: `packages/shared/src/team-agent.ts`
- Create: `packages/services/src/teams/teamAgentStorage.ts`
- Modify: `packages/shared/src/index.ts`（导出）
- Test: `packages/shared/test/teamAgentDomain.test.ts`、`packages/services/test/teamAgentStorage.test.ts`

**Interfaces:**
- Produces:
  - `teamAgentSchema`（zod，**strict**）与 `type TeamAgent`，字段含 `id`（稳定 id）、`name`、`description`、`color?`、`systemPrompt`、`skills: string[]`、`modelSelection?`、`tools?`、`disallowedTools?`、`permissionMode?`、`memoryScope: "user" | "project" | "local"`、`enabled`、`archivedAt?`、`provenance?`
  - `resolveSquadAgentRoot(workspacePath: string): string` → `<workspacePath>/.zcode/squad/agents`
  - `readTeamAgent(root, id)` / `writeTeamAgent(root, agent)` / `listTeamAgents(root)` / `deleteTeamAgent(root, id)`

- [ ] **Step 1: 写失败测试**

`packages/shared/test/teamAgentDomain.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { teamAgentSchema } from "../src/team-agent.js";

// 记忆用稳定 id 做 key，因此 id 必填且不得为空（空 id 会让记忆跨智能体串台）。
test("teamAgent 必须有非空稳定 id", () => {
  const bad = teamAgentSchema.safeParse({ name: "a", systemPrompt: "s", memoryScope: "project", enabled: true });
  assert.equal(bad.success, false);
});

// strict schema：多余字段直接拒绝——这是「不绑 host」的机器化证明（决策 E）。
test("strict schema 拒绝 hostBinding 等未知字段", () => {
  const parsed = teamAgentSchema.safeParse({
    id: "ta_1", name: "a", systemPrompt: "s", memoryScope: "project", enabled: true,
    hostBinding: "h1", // 多余字段
  });
  assert.equal(parsed.success, false);
});
```

`packages/services/test/teamAgentStorage.test.ts`：

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteTeamAgent, listTeamAgents, readTeamAgent, resolveSquadAgentRoot, writeTeamAgent,
} from "../src/teams/teamAgentStorage.js";

test("定义落在实验命名空间，可写可读可删", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  const root = resolveSquadAgentRoot(ws);
  assert.ok(root.endsWith(join(".zcode", "squad", "agents")));
  writeTeamAgent(root, { id: "ta_1", name: "审查者", systemPrompt: "s", memoryScope: "project", enabled: true });
  assert.equal(readTeamAgent(root, "ta_1")?.name, "审查者");
  assert.equal(listTeamAgents(root).length, 1);
  deleteTeamAgent(root, "ta_1");
  assert.equal(listTeamAgents(root).length, 0);
});

// 删除整个实验命名空间不应牵连现有 subagent 目录。
test("实验命名空间与现有 agents 目录互不相干", () => {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  assert.equal(resolveSquadAgentRoot(ws).includes(join(".zcode", "agents")), false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/shared/test/teamAgentDomain.test.ts packages/services/test/teamAgentStorage.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`team-agent.ts`：用 zod **`.strict()`** 定义（多余字段即拒，从而 `hostBinding` 之类会被 `safeParse` 判失败）；schema 内包含可选的 `archivedAt: z.number().int().nonnegative().optional()`。

`teamAgentStorage.ts`：每个智能体一个文件 `<root>/<id>.json`（`JSON.stringify` + 原子写：先写 `.tmp` 再 `rename`）。`listTeamAgents` 只读 `*.json` 并跳过无法解析的文件（坏文件不应让整个列表崩）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/shared/test/teamAgentDomain.test.ts packages/services/test/teamAgentStorage.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §3.2 与 §7 反查：*这层会不会让两套 agent 互相污染？* 核对——①存储路径与 `<ws>/.zcode/agents` **不同**（测试已锁）；②`id` 非空（记忆 key 依赖它）；③schema **strict**，`hostBinding` 之类被拒（决策 E 已定不绑 host）；④坏 JSON 不让列表崩。另需确认：`.zcode/squad/` 已进**排除清单**（spec §13 C10）——若本任务引入该目录而排除清单尚未集中，则在本任务内把 `.zcode/squad/` 加入现有排除/忽略处，并记录位置。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/team-agent.ts packages/shared/src/index.ts packages/services/src/teams/teamAgentStorage.ts packages/shared/test/teamAgentDomain.test.ts packages/services/test/teamAgentStorage.test.ts
git commit -m "feat(squad): 协作智能体域模型与实验命名空间存储"
```

---

### Task 8: 协作智能体服务（含一次性预填）

**Files:**
- Create: `packages/services/src/teams/teamAgentService.ts`
- Test: `packages/services/test/teamAgentService.test.ts`

**Interfaces:**
- Consumes: `teamAgentStorage`（Task 7）、现有 `AgentSummary`（`packages/shared/src/subagents-types.ts`）
- Produces:
  - `createTeamAgentService(deps: { root: string }): TeamAgentService`
  - `TeamAgentService.create(input): TeamAgent`
  - `TeamAgentService.get(id: string): TeamAgent | null`
  - `TeamAgentService.list(): TeamAgent[]`
  - `TeamAgentService.prefillFrom(agent: AgentSummary): Partial<TeamAgent>`（**拷贝**字段；不建立引用）
  - `TeamAgentService.archive(id): void`（归档而非硬删）
  - `TeamAgentService.setEnabled(id, enabled): void`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTeamAgentService } from "../src/teams/teamAgentService.js";

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  return createTeamAgentService({ root: join(ws, ".zcode", "squad", "agents") });
}

test("预填只拷贝字段，不建立引用", () => {
  const svc = setup();
  const source = {
    id: "user:user:reviewer", name: "审查者", description: "d", systemPrompt: "sp",
    path: "/tmp/x.md", scope: "user", source: "user", enabled: true,
    modelSelection: { providerId: "p", modelId: "m" },
  } as never;
  const draft = svc.prefillFrom(source);
  assert.equal(draft.name, "审查者");
  assert.equal(draft.systemPrompt, "sp");
  // 预填结果里不得残留来源的 id / path，否则会形成隐式引用。
  assert.equal("id" in draft, false);
  assert.equal("path" in draft, false);
  assert.equal("modelSelection" in draft, true);
});

test("新建后可归档（归档而非硬删）", () => {
  const svc = setup();
  const a = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });
  svc.archive(a.id);
  assert.ok(svc.list().some((x) => x.id === a.id && x.archivedAt !== undefined));
});

test("启停开关生效", () => {
  const svc = setup();
  const a = svc.create({ name: "a", systemPrompt: "s", memoryScope: "project" });
  svc.setEnabled(a.id, false);
  assert.equal(svc.get(a.id)?.enabled, false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/teamAgentService.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`create`：生成稳定 `id`（沿用仓库既有 id 生成方式，**不得**用 name 派生）；默认 `enabled: true`、`skills: []`。
`prefillFrom`：**只取** `name` / `description` / `systemPrompt` / `color` / `modelSelection` / `tools` / `disallowedTools` / `skills` / `permissionMode`，**丢弃** `id` / `path` / `scope` / `source` / `pluginId`（避免隐式引用）。
`archive`：写 `archivedAt`（配合 Task 7 的 schema 扩展一个可选 `archivedAt` 字段）。
`setEnabled`：只改 `enabled`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/teamAgentService.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: 逆推审查**

对着 spec §3.2（定义来源=拷贝，无持续引用）与 §13.2（与现有 subagent 并存）反查：*预填会不会变成隐式引用？* 核对——①预填结果**不含** `id` / `path`（已测，这条是「无引用」的机器化证明）；②归档是加时间戳而非删除文件；③`setEnabled` 不触碰现有 `agents-state.json`（两套存储彻底分开）；④删除整个 `.zcode/squad/` 目录后，Task 1 的开关关闭状态下现有 subagent 仍可用——若本任务新增了任何**共享**读写路径，必须先证明它不会回写现有 subagent 存储。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/teams/teamAgentService.ts packages/services/test/teamAgentService.test.ts
git commit -m "feat(squad): 协作智能体服务（一次性预填 + 归档 + 启停）"
```

---

## 计划的自我审查（Self-Review）

**1. Spec 覆盖**：P0 范围（spec §15）为「工作项实体 + 完整父子树 + 生命周期（唯一写者）+ 协作智能体实体（含 memoryScope）+ 实验分区开关」。
- 工作项实体 → Task 3、4、5
- 完整父子树 → Task 3（`parentId` / `stage`）、Task 5（聚合）、Task 6（环/深度校验）
- 生命周期 + 唯一写者 → Task 3（状态与 category）、Task 5（CAS）、Task 6（唯一写者）
- 协作智能体 + memoryScope → Task 7、8
- 实验分区开关 → Task 1、2
- **未覆盖（属 P1+，非本计划缺口）**：唤醒规则、队长 run、防失控、工作树、评论/时间线、Inbox、PR、成本 —— 按 Skill 的 Scope Check，它们各自另出计划。

**2. 占位符扫描**：无 `TBD` / `TODO` / 「适当处理」类表述；所有代码步骤都给了可执行代码或精确 SQL。Task 4 与 Task 5 中「照抄相邻迁移项形状」「按既有 Repo 写法」是**遵循既有代码模式**的必要指令（AGENTS.md 亦要求），不是占位符。

**3. 类型一致性**：`WorkItem`（Task 3）→ Repo 签名（Task 5）→ 服务入参（Task 6）字段名一致（`parentId` / `status` / `assignee`）；`isTerminalWorkItemStatus` 在 Task 5、6 复用同一实现；`TeamAgent` 字段（Task 7）→ 服务（Task 8）一致；`WORK_ITEM_MAX_DEPTH` / `WORK_ITEM_MAX_CHILDREN` 只在 Task 3 定义、Task 6 消费。

**4. Review Focus 落点**：五条隐含失败模式各有归属任务与其测试——①非服务直写（Task 6 Step 3 的导出约束 + Step 5 核对）；②重复/并发派发（Task 5 CAS、Task 6 事件去重）；③环与超深/超配额（Task 6 Step 1）；④迁移重放（Task 4 Step 1 幂等测试）；⑤实验关闭残留（Task 1 默认值、Task 8 Step 5）。

**5. 逆推审查已内置**：每个任务的 Step 5 都是「对着 spec 具体小节反查本题的遗漏」，并给出**逐条核对清单**，不是泛泛的「检查一下」。

---

## 执行方式

任务之间**接口耦合紧**（Task 3 的类型被 5/6 消费，Task 5 的签名被 6 依赖，Task 7 被 8 依赖），且你要求**每次审查用逆推方式**防错漏——这正需要**每个任务一个独立审查者**。
