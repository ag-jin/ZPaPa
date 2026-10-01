# 多智能体小队 · P1 编排 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「安排计划 + 指定队长」能**一轮轮自动推进**：小队实体、唤醒规则（event/条件/at/every/cron）、防失控、队长角色 run。

**Architecture:** 沿用 P0 的分层与纪律——域模型在 `packages/shared`（strict zod + 纯函数），持久化走既有 `tasksDatabase` 只追加迁移与实验命名空间文件，**工作项状态仍只有 `workItemService` 能写**；本阶段新增的一切都只发**派发事件**。防失控与派发决策写成**纯函数**，以便穷举验证。

**Tech Stack:** TypeScript · Node 24（`node:test` + `node:assert/strict`，`pnpm exec tsx --test`）· `node:sqlite`（`DatabaseSync`）· zod 4

**Spec:** `docs/superpowers/specs/2026-10-01-multi-agent-squad-design.md`（§5 触发与编排、§5.4 队长指令、§5.5 防失控、§5.7 时序与幂等）

**前置**：**P0 已实现**（分支 `feat/multi-agent-squad`）。P1 分支**堆叠在 P0 之上**：`feat/multi-agent-squad-p1`。

## Global Constraints

- **唯一写者**：只有 `workItemService.transition` 能写工作项 `status`；P1 新增的小队 / 唤醒规则 / 队长派发**一律只发事件**，不得直写状态。
- **状态键固定 6 个**：`todo | in_progress | in_review | blocked | done | cancelled`；category 固定 4 个；**终态 = category ∈ {done, closed}**；聚合判定**一律用 category**。
- **唤醒规则 kind 固定 4 种**：`event | at | every | cron`；**mode 固定 2 种**：`once | continuous`；**condition 固定 4 种**：`issue_field | children_done | pull_request | other_issue`。
- **防失控阈值**：`maxFires` 默认 **20**（1–1000）；`rate` = 一小时内 run **≥ 12** 暂停；`loop` = run 链中同一规则出现 **≥ 2** 次暂停。
- **防失控只约束非人发起**：用户手动「现在就跑」**豁免** maxFires/rate/loop。
- **`@` ≠ 指派**：触发一次运行，不改负责人与状态。
- **队长指令 8 槽位**：目标 · 拆解规则 · 派单规则 · 独立性要求 · 验收标准 · **收手条件（必填）** · 汇报格式 · **轮次上限（必填）**。
- **三重隔离**（决策 C3）：小队相关存储放实验命名空间 `<ws>/.zcode/squad/`，不得触碰现有 subagent 存储。
- **迁移只追加**；历史列声明**冻结**；新迁移必须显式加 `else if`（runner 末尾 `else` 会跑 GLM SQL）。
- 测试位置 `packages/<pkg>/test/*.test.ts`；命令：`pnpm exec tsx --test <file>`（**ui 包例外**：`pnpm exec tsx --tsconfig packages/ui/tsconfig.json --test <file>`）。
- 每个任务结束必须通过 `pnpm typecheck` 与 `pnpm lint`。
- 注释用中文说明**为什么**。

## Review Focus

spec 隐含但各任务测试**容易漏掉**的输入/失败模式（每条都在拥有该代码的任务里加了对应测试）：

1. **重复触发与重放**：同一 `(workItemId, ruleId, revision, eventKey)` 重复到达 → 只生效一次（Task 5）。
2. **规则编辑的 fencing**：编辑后过期 revision 的派发必须作废，不产生重复 run（Task 4、Task 5）。
3. **防失控只豁免人发起**：同一条件用「人」与「规则」两条路径各走一次，结果必须不同（Task 5）。
4. **指派三态 × 触发源三态的完整矩阵**：user/agent/squad × 用户/队长/规则，九格都不得静默走错分支（Task 6）。
5. **kind × mode 的互斥**：`at` 带 `continuous`、`event` 带 cron 字段、`condition` 挂在非 event 上，都必须被拒（Task 3）。

---

## 每个任务的审查步骤统一为两段（用户要求）

**① 逆推**：对着 spec 的**具体小节**逐条反查遗漏。
**② 穷举**：先**列出本任务的枚举空间全集**，再**逐项**核对有处理/有覆盖；对「不适用」的项写明理由。只有逆推、没有穷举清单的审查报告视为**未完成**。

---

### Task 1: Squad 域模型（含队长指令 8 槽位）

**Files:**
- Create: `packages/shared/src/squad.ts`
- Modify: `packages/shared/src/index.ts`（追加导出）
- Test: `packages/shared/test/squadDomain.test.ts`

**Interfaces:**
- Produces:
  - `SQUAD_INSTRUCTION_SLOTS = ["goal","breakdown","dispatch","independence","acceptance","stopCondition","reporting","maxRounds"] as const`
  - `type SquadInstructionSlot = (typeof SQUAD_INSTRUCTION_SLOTS)[number]`
  - `SQUAD_REQUIRED_INSTRUCTION_SLOTS = ["stopCondition","maxRounds"] as const`
  - `squadSchema`（**strict**）、`type Squad`（`instructions` 用 **`z.partialRecord(z.enum(SQUAD_INSTRUCTION_SLOTS), z.string())`**：键限定在 8 槽位内、**允许缺键**——zod 4 的 `z.record(z.enum)` 是穷尽语义会要求 8 键全给，与「缺槽位由 `validateSquad` 拦」的设计冲突）
  - `validateSquad(squad): { ok: true } | { ok: false; problems: string[] }`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  SQUAD_INSTRUCTION_SLOTS, SQUAD_REQUIRED_INSTRUCTION_SLOTS,
  squadSchema, validateSquad,
} from "../src/squad.js";

const base = {
  id: "sq_1", name: "网关组", leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { goal: "上线限流" }, enabled: true,
};

test("8 个槽位是固定全集", () => {
  assert.deepEqual(SQUAD_INSTRUCTION_SLOTS, [
    "goal","breakdown","dispatch","independence","acceptance","stopCondition","reporting","maxRounds",
  ]);
});

// 收手条件与轮次上限是必填槽位：缺了队长就没有终止条件，会一直派或早早停。
test("缺少必填槽位时 validateSquad 报错", () => {
  const squad = squadSchema.parse(base);
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("stopCondition")));
  assert.ok(!result.ok && result.problems.some((p) => p.includes("maxRounds")));
});

test("补齐必填槽位后校验通过", () => {
  const squad = squadSchema.parse({
    ...base,
    instructions: { stopCondition: "子项全 done 且审查通过即收工", maxRounds: "5" },
  });
  assert.deepEqual(validateSquad(squad), { ok: true });
});

// leader 必须同时是 members 之一：否则「队长协调」没有承载者。
test("leader 不在 members 里则报错", () => {
  const squad = squadSchema.parse({ ...base, members: [{ agentId: "ta_a" }] });
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("leaderAgentId")));
});

test("members 内同一 agentId 重复则报错", () => {
  const squad = squadSchema.parse({
    ...base,
    members: [{ agentId: "ta_a" }, { agentId: "ta_a" }],
  });
  const result = validateSquad(squad);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.problems.some((p) => p.includes("重复")));
});

test("strict：未知字段被拒（如 hostBinding）", () => {
  assert.equal(squadSchema.safeParse({ ...base, hostBinding: "h1" }).success, false);
});

test("继承既有字段可选性：description 可选、archivedAt 可选", () => {
  const parsed = squadSchema.parse(base);
  assert.equal(parsed.description, undefined);
  assert.equal(parsed.archivedAt, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/shared/test/squadDomain.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

按 P0 的 `packages/shared/src/work-item.ts` 风格写：`squadSchema` 用 `.strict()`；`instructions` 用 **`z.partialRecord(z.enum(SQUAD_INSTRUCTION_SLOTS), z.string())`**（键限定在 8 槽位内、**允许缺键**——zod 4 的 `z.record(z.enum)` 是穷尽语义，会要求 8 键全给）；`members` 用 `z.array(z.object({ agentId: z.string().min(1), role: z.string().optional() })).min(1)`——**不设名册上限**（spec 只限「并行队员 ≤ 6」，那是并发约束、由派发侧管，不是名册规模，见 spec §3.10）。

`validateSquad` 返回 `problems: string[]`（中文、可读），逐条：
1. `leaderAgentId` 必须出现在 `members` 的 `agentId` 中；
2. `members` 的 `agentId` 不得重复（报「重复」）；
3. `SQUAD_REQUIRED_INSTRUCTION_SLOTS` 每一项必须在 `instructions` 里有**非空**值。

`packages/shared/src/index.ts` 追加 `export * from "./squad.js";`

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/shared/test/squadDomain.test.ts`
Expected: PASS（8 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（对着 spec §3.3、§5.4 反查）：
- spec §3.3 的字段逐项对照：`id/name/description/leaderAgentId/members/instructions/enabled/archivedAt` 是否齐？
- spec §5.4 的 **8 个槽位**是否就是 `SQUAD_INSTRUCTION_SLOTS` 的全集？**「收手条件」「轮次上限」是否确为必填**？
- spec 说「leader 自动作为成员」——本任务是否保证了这一点（校验而非静默补）？

**② 穷举**（先列全集再逐项核对）：
| 枚举空间 | 全集 | 是否都有处理/覆盖 |
|---|---|---|
| 指令槽位 | 8 个（§5.4 表） | |
| 必填槽位 | 2 个 | |
| 槽位取值 | 空串 / 只有空白 / 非空 | |
| 成员关系 | leader 在 members / 不在 / 重复 / 单个 / 12 个 / 13 个 | |
| 可选字段 | `description` / `archivedAt` / `role` 缺省 | |
| schema 严格性 | 未知字段（`hostBinding` 等） | |

逐项写「有测试 / 由 schema 保证 / 不适用+理由」。**任一项空缺先补测试或写明理由，再提交。**

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/squad.ts packages/shared/src/index.ts packages/shared/test/squadDomain.test.ts
git commit -m "feat(squad): Squad 域模型（队长指令 8 槽位 + 成员校验）"
```

---

### Task 2: Squad 存储 + 服务

**Files:**
- Create: `packages/services/src/teams/squadStorage.ts`、`packages/services/src/teams/squadService.ts`
- Test: `packages/services/test/squadService.test.ts`

**Interfaces:**
- Consumes: `squadSchema` / `validateSquad` / `Squad`（Task 1）；P0 的 `teamAgentStorage` 风格（原子写 + 容错 list）
- Produces:
  - `resolveSquadDefinitionRoot(workspacePath: string): string` → `<ws>/.zcode/squad/squads`
  - `createSquadService({ root, teamAgentRoot }): SquadService`
  - `SquadService.create(input): Squad`（生成稳定 id；**把 leader 并入 members 并写 `role: "leader"`**；不通过 `validateSquad` 则抛错）
  - `SquadService.get(id)` / `list()`（含已归档）
  - `SquadService.update(id, patch): Squad`
  - `SquadService.archive(id): Squad`（写 `archivedAt`，不删文件）

**范围裁定（写明，不偷偷省）**：spec §5.5/§3.10 的「归档小队 → 工作项指派与排班**转交队长**」需要「按 assignee 查工作项」的能力，属 P2。**本任务只做归档本身**，并把转交留作显式的 `TODO(P2)` 注释 + 写进 ledger。**代价**：P2 之前归档小队会留下指向已归档小队的指派。

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSquadService } from "../src/teams/squadService.js";

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "ws-"));
  return createSquadService({
    root: join(ws, ".zcode", "squad", "squads"),
    teamAgentRoot: join(ws, ".zcode", "squad", "agents"),
  });
}

test("create 把 leader 并入 members 并标 role=leader", () => {
  const svc = setup();
  const s = svc.create({ name: "网关组", leaderAgentId: "ta_lead", members: ["ta_a"] });
  assert.deepEqual(
    s.members.map((m) => [m.agentId, m.role]),
    [["ta_lead", "leader"], ["ta_a", undefined]],
  );
});

// 缺必填槽位不得被静默接受：队长没有终止条件就会一直派。
test("create 缺收手条件/轮次上限则抛错", () => {
  const svc = setup();
  assert.throws(
    () => svc.create({ name: "x", leaderAgentId: "ta_lead", members: [] }),
    /stopCondition|maxRounds/,
  );
});

test("归档写 archivedAt 而非删除，且 list 仍含它", () => {
  const svc = setup();
  const s = svc.create({
    name: "网关组", leaderAgentId: "ta_lead", members: [],
    instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" },
  });
  svc.archive(s.id);
  assert.ok(svc.get(s.id)?.archivedAt !== undefined);
  assert.ok(svc.list().some((x) => x.id === s.id));
});

test("update 不改变 id", () => {
  const svc = setup();
  const s = svc.create({
    name: "a", leaderAgentId: "ta_lead", members: [],
    instructions: { stopCondition: "s", maxRounds: "1" },
  });
  const updated = svc.update(s.id, { name: "b" });
  assert.equal(updated.id, s.id);
  assert.equal(updated.name, "b");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/squadService.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`squadStorage.ts`：照抄 `teamAgentStorage.ts` 的形状（`.tmp` + `openSync("wx")` + `fsync` + `rename`、`readdirSync().sort()`、逐文件 try/catch 跳过坏文件）。**id 必须校验为单一路径段**（`basename(id) === id`）——P0 的 `teamAgentStorage` 留下了 `..` 逃逸隐患（终审列为「传 id 前必修」），**这里必须一开始就做对**。

`squadService.ts`：`create` 生成 id（`randomUUID`，不用 name 派生）；把 `leaderAgentId` 前置进 `members` 并写 `role: "leader"`；`instructions` 缺必填槽位时抛可读错误（直接调 Task 1 的 `validateSquad`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/squadService.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.3、§3.10、§13 C3）：
- 「leader 自动作为成员」是否真的落地（不是只靠校验）？
- 归档语义：是否**只写时间戳不删文件**、`list()` 是否含归档？
- 是否**只**写 `<ws>/.zcode/squad/`，没碰 `<ws>/.zcode/agents` 或 `agents-state.json`？
- 路径逃逸：`create` 传入的 id / 文件名是否被约束为单一路径段？
- 「归档转交队长」的**范围裁定**是否被显式记录（注释 + 报告），而不是无声省略？

**② 穷举**：
| 枚举空间 | 全集 | 处理/覆盖 |
|---|---|---|
| CRUD | create / get / list / update / archive | |
| 缺失对象 | get 未知 id / update 未知 id / archive 未知 id | |
| 重复归档 | archive 已归档（应幂等，保留原时间戳） | |
| 损坏文件 | list 遇到不可解析的 json | |
| 目录不存在 | 首次 create 前 list | |
| 路径逃逸 | id 含 `/`、`..`、空串 | |
| 隔离 | 删除 `<ws>/.zcode/squad/` 后现有 `<ws>/.zcode/agents` 文件仍在 | |

逐项给结论；空缺先补。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/teams/squadStorage.ts packages/services/src/teams/squadService.ts packages/services/test/squadService.test.ts
git commit -m "feat(squad): 小队存储与服务（leader 并入成员 + 归档 + 路径段约束）"
```

---

### Task 3: 唤醒规则域模型（含 kind × mode 互斥）

**Files:**
- Create: `packages/shared/src/wake-rule.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/wakeRuleDomain.test.ts`

**Interfaces:**
- Produces:
  - `WAKE_RULE_KINDS = ["event","at","every","cron"] as const`、`WAKE_RULE_MODES = ["once","continuous"] as const`
  - `WAKE_CONDITION_TYPES = ["issue_field","children_done","pull_request","other_issue"] as const`
  - `WAKE_DEFAULT_MAX_FIRES = 20`、`WAKE_HOURLY_RUN_LIMIT = 12`、`WAKE_LOOP_REPEAT_LIMIT = 2`
  - `wakeRuleSchema`、`type WakeRule`
  - `validateWakeRule(rule): { ok: true } | { ok: false; problems: string[] }`（**互斥约束全在这里**）

- [ ] **Step 1: 写失败测试**（只列关键几条；照此补齐互斥矩阵）

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  WAKE_DEFAULT_MAX_FIRES, WAKE_HOURLY_RUN_LIMIT, WAKE_LOOP_REPEAT_LIMIT,
  wakeRuleSchema, validateWakeRule,
} from "../src/wake-rule.js";

const ok = (over = {}) => wakeRuleSchema.parse({ id: "w1", workItemId: "wi_1", kind: "event", mode: "once", ...over });
const problems = (over = {}) => {
  const r = validateWakeRule(ok(over));
  return r.ok ? [] : r.problems;
};

test("阈值常量与 spec §5.5 一致", () => {
  assert.equal(WAKE_DEFAULT_MAX_FIRES, 20);
  assert.equal(WAKE_HOURLY_RUN_LIMIT, 12);
  assert.equal(WAKE_LOOP_REPEAT_LIMIT, 2);
});

// kind 自带的 mode 约束：at 只能 once；every/cron 只能 continuous。
test("at + continuous 被拒", () => {
  assert.ok(problems({ kind: "at", mode: "continuous", at: 1 }).length > 0);
});
test("every + once 被拒", () => {
  assert.ok(problems({ kind: "every", mode: "once", intervalSeconds: 60 }).length > 0);
});

// event 不得携带任何调度字段。
test("event 带 intervalSeconds 被拒", () => {
  assert.ok(problems({ kind: "event", intervalSeconds: 60 }).length > 0);
});
test("event 带 cronExpression 被拒", () => {
  assert.ok(problems({ kind: "event", cronExpression: "* * * * *" }).length > 0);
});

// condition 只允许挂在 event 上。
test("every 带 condition 被拒", () => {
  assert.ok(problems({ kind: "every", mode: "continuous", intervalSeconds: 60, condition: { type: "children_done" } }).length > 0);
});

// maxFires 只在 continuous 上有效，且 1..1000。
test("once 带 maxFires 被拒", () => {
  assert.ok(problems({ maxFires: 5 }).length > 0);
});
test("continuous 的 maxFires 越界被拒", () => {
  assert.ok(problems({ kind: "every", mode: "continuous", intervalSeconds: 60, maxFires: 0 }).length > 0);
  assert.ok(problems({ kind: "every", mode: "continuous", intervalSeconds: 60, maxFires: 1001 }).length > 0);
});

// onTimeout=wake 仅限 event。
test("at 带 onTimeout=wake 被拒", () => {
  assert.ok(problems({ kind: "at", mode: "once", at: 1, onTimeout: "wake" }).length > 0);
});

test("合法规则零问题", () => {
  assert.deepEqual(problems(), []);
  assert.deepEqual(problems({ kind: "cron", mode: "continuous", cronExpression: "0 9 * * *" }), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/shared/test/wakeRuleDomain.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`wakeRuleSchema`（strict）字段：`id`、`workItemId`、`kind`、`mode`、可选 `at`(number)、`intervalSeconds`(>0)、`cronExpression`(non-empty)、`timezone`、`condition`（`{ type }` + 可选参数）、`eventTypes`、`filters`、`nextFireAt`、`maxFires`、`fireCount`(default 0)、`pausedReason`、`expiresAt`、`onTimeout`、`revision`(default 0)、`enabled`(default true)。

`validateWakeRule` 逐条实现互斥（每条给可读中文问题）：
1. `kind === "at"` 时 `mode` 必须 `once`；`kind ∈ {every, cron}` 时 `mode` 必须 `continuous`；
2. `kind === "event"` 时**不得**出现 `at`/`intervalSeconds`/`cronExpression`；
3. `kind !== "event"` 时**不得**出现 `condition`；
4. `maxFires` 只在 `mode === "continuous"` 时允许，且 `1..1000`；
5. `onTimeout === "wake"` 只在 `kind === "event"` 时允许；
6. `at`/`every`/`cron` 必须各自带上对应字段（缺 `at` / `intervalSeconds` / `cronExpression` 都报错）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/shared/test/wakeRuleDomain.test.ts`
Expected: PASS（9 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.5、§5.1、§5.5）：
- §3.5 的字段是否齐（含 `filters`、`expiresAt`、`onTimeout`、`revision`、`pausedReason`）？
- §5.5 的三个阈值是否与常量一致？
- 计划 Global Constraints 列的**四条 kind/mode/condition 约束**是否全部落地？

**② 穷举**——**kind × mode 全矩阵 4×2 = 8 格**必须逐格给结论：
| | once | continuous |
|---|---|---|
| event | | |
| at | | |
| every | | |
| cron | | |

再穷举：`condition` 4 种类型 × {event, 非 event}；`eventTypes`/`filters` × {event, 非 event}；`maxFires` × {未给, 0, 1, 1000, 1001}；`onTimeout` × {end, wake} × {event, 非 event}；`expiresAt` × {无, 过去, 未来}。逐格「有测试 / 由 schema 保证 / 不适用+理由」。

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/wake-rule.ts packages/shared/src/index.ts packages/shared/test/wakeRuleDomain.test.ts
git commit -m "feat(squad): 唤醒规则域模型（kind×mode 互斥 + 防失控阈值常量）"
```

---

### Task 4: 唤醒规则表 + Repo（含 revision fencing）

**Files:**
- Modify: `packages/services/src/session/tasksDatabase/schema-v1.ts`、`migrations.ts`
- Create: `packages/services/src/workitem/wakeRuleRepo.ts`
- Test: `packages/services/test/wakeRuleRepo.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `WakeRule`
- Produces（真实签名）:
  - `createWakeRuleRepo(db: DatabaseSync): WakeRuleRepo`
  - `insert(rule: WakeRule): void`
  - `get(id: string): WakeRule | null`
  - `listReady(now: number, limit: number): WakeRule[]`（`enabled` 且 `next_fire_at <= now`）
  - `casAdvance(id, expectRevision, nextFireAt | null, fireCount, pausedReason?): boolean`（单条条件 UPDATE，**带 `revision = expectRevision`**；命中即 `revision + 1`）
  - `listByWorkItem(workItemId: string): WakeRule[]`

- [ ] **Step 1: 写失败测试**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import { createWakeRuleRepo } from "../src/workitem/wakeRuleRepo.js";

function setup() {
  const db = new DatabaseSync(":memory:");
  runTasksDatabaseMigrations(db);
  return { db, repo: createWakeRuleRepo(db) };
}
const rule = (over = {}) => ({
  id: "w1", workItemId: "wi_1", kind: "every", mode: "continuous",
  intervalSeconds: 60, fireCount: 0, revision: 0, enabled: true, ...over,
} as never);

test("迁移建出 wake_rules 表", () => {
  const { db } = setup();
  assert.equal(
    db.prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name='wake_rules'").get().c,
    1,
  );
});

test("listReady 只取到期且 enabled 的规则", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w_due", nextFireAt: 100 }));
  repo.insert(rule({ id: "w_future", nextFireAt: 999 }));
  repo.insert(rule({ id: "w_off", nextFireAt: 50, enabled: false }));
  assert.deepEqual(repo.listReady(200, 10).map((r) => r.id), ["w_due"]);
});

// revision fencing：过期 revision 的推进必须失败，防止编辑后旧派发覆盖新状态。
test("casAdvance 的 revision 不匹配则拒绝", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  assert.equal(repo.casAdvance("w1", 7, 200, 1), false);
  assert.equal(repo.get("w1")?.revision, 0);
});

test("casAdvance 命中则推进并 +1 revision", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  assert.equal(repo.casAdvance("w1", 0, 200, 1), true);
  const after = repo.get("w1")!;
  assert.equal(after.revision, 1);
  assert.equal(after.fireCount, 1);
  assert.equal(after.nextFireAt, 200);
});

test("casAdvance 可写入暂停原因", () => {
  const { repo } = setup();
  repo.insert(rule({ id: "w1" }));
  repo.casAdvance("w1", 0, null, 1, "max_fires");
  assert.equal(repo.get("w1")?.pausedReason, "max_fires");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/wakeRuleRepo.test.ts`
Expected: FAIL（表不存在 / 模块不存在）

- [ ] **Step 3: 最小实现**

`schema-v1.ts` 追加 `WAKE_RULE_SCHEMA`（`CREATE TABLE IF NOT EXISTS wake_rules(...)` + 两个**部分索引**：`idx_wake_rules_ready ON wake_rules(next_fire_at) WHERE enabled=1 AND next_fire_at IS NOT NULL`、`idx_wake_rules_work_item ON wake_rules(work_item_id)`）。

`migrations.ts`：追加导入 + **新迁移项 `0005_wake_rules`**，**务必同时加 `else if (migration.id === "0005_wake_rules")` 分支**（runner 末尾 `else` 会跑 GLM SQL）。

`wakeRuleRepo.ts`：`casAdvance` 用**单条**条件 UPDATE：

```ts
const r = db.prepare(
  `UPDATE wake_rules SET next_fire_at=?, fire_count=?, paused_reason=?, revision=revision+1, updated_at=?
   WHERE id=? AND revision=?`,
).run(nextFireAt, fireCount, pausedReason ?? null, Date.now(), id, expectRevision);
return r.changes === 1;
```

JSON 字段（`condition`/`filters`/`eventTypes`）以文本存取。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/wakeRuleRepo.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.5、§5.7、§3.8）：
- §3.8 的「迁移只追加、历史声明冻结」是否守住（diff 必须 0 删除）？
- §5.7「每次流转携带期望前置状态（CAS）」是否落到 `revision` 上？
- 新迁移是否**显式加了 `else if`**（P0 的教训）？

**② 穷举**：
| 枚举空间 | 全集 | 处理/覆盖 |
|---|---|---|
| 接口方法 | insert / get / listReady / casAdvance / listByWorkItem | |
| `listReady` 过滤 | enabled×到点 / enabled×未到 / disabled×到点 / disabled×未到 | |
| `nextFireAt` 取值 | NULL / 过去 / 未来 | |
| `casAdvance` | revision 命中 / 不命中 / id 不存在 / `nextFireAt=NULL` / 带 pausedReason | |
| 表列 | 与 `WakeRule` 类型逐字段对齐（缺一列即静默丢数据） | |
| 索引 | 两个部分索引确实建出 | |
| 迁移幂等 | 同一库跑两次 | |

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/session/tasksDatabase/schema-v1.ts packages/services/src/session/tasksDatabase/migrations.ts packages/services/src/workitem/wakeRuleRepo.ts packages/services/test/wakeRuleRepo.test.ts
git commit -m "feat(squad): 唤醒规则表与 Repo（部分索引 + revision fencing）"
```

---

### Task 5: 防失控 + 派发决策（纯函数）

**Files:**
- Create: `packages/services/src/workitem/wakeGuard.ts`
- Test: `packages/services/test/wakeGuard.test.ts`

**Interfaces:**
- Consumes: Task 3 的阈值常量与 `WakeRule`
- Produces:
  - `type WakeDecision = { action: "fire" } | { action: "skip"; reason: "merged" | "acknowledged" } | { action: "pause"; reason: "max_fires" | "rate" | "loop" }`
  - `decideWake(input: { rule: WakeRule; manual: boolean; recentFireCount: number; chainRepeatCount: number; hasPendingSameEvent: boolean; allInputsFromSelf: boolean }): WakeDecision`

- [ ] **Step 1: 写失败测试**（含**人/规则双路径**对照）

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { decideWake } from "../src/workitem/wakeGuard.js";

const base = {
  rule: { id: "w1", workItemId: "wi", kind: "event", mode: "continuous", maxFires: 20, fireCount: 0 } as never,
  manual: false, recentFireCount: 0, chainRepeatCount: 1,
  hasPendingSameEvent: false, allInputsFromSelf: false,
};

test("正常情况放行", () => {
  assert.deepEqual(decideWake(base), { action: "fire" });
});

test("达到 maxFires 暂停", () => {
  assert.deepEqual(
    decideWake({ ...base, rule: { ...base.rule, fireCount: 20 } as never }),
    { action: "pause", reason: "max_fires" },
  );
});

test("一小时内达到 rate 上限暂停", () => {
  assert.deepEqual(decideWake({ ...base, recentFireCount: 12 }), { action: "pause", reason: "rate" });
});

test("run 链中同规则出现 2 次即 loop 暂停", () => {
  assert.deepEqual(decideWake({ ...base, chainRepeatCount: 2 }), { action: "pause", reason: "loop" });
});

test("同事件已有待处理则合并（skip）", () => {
  assert.deepEqual(decideWake({ ...base, hasPendingSameEvent: true }), { action: "skip", reason: "merged" });
});

test("输入全来自自身则只承认不启动", () => {
  assert.deepEqual(decideWake({ ...base, allInputsFromSelf: true }), { action: "skip", reason: "acknowledged" });
});

// 人手动「现在就跑」豁免三条防失控——否则人会被自己设的闸拦住。
test("manual=true 豁免 maxFires/rate/loop", () => {
  const manual = { ...base, manual: true };
  assert.deepEqual(decideWake({ ...manual, rule: { ...base.rule, fireCount: 9999 } as never }), { action: "fire" });
  assert.deepEqual(decideWake({ ...manual, recentFireCount: 999 }), { action: "fire" });
  assert.deepEqual(decideWake({ ...manual, chainRepeatCount: 9 }), { action: "fire" });
});

// 但豁免不改变「合并」与「自我承认」：那是语义去重，不是限流闸。
test("manual=true 不豁免 merged / acknowledged", () => {
  assert.deepEqual(decideWake({ ...base, manual: true, hasPendingSameEvent: true }), { action: "skip", reason: "merged" });
  assert.deepEqual(decideWake({ ...base, manual: true, allInputsFromSelf: true }), { action: "skip", reason: "acknowledged" });
});

// 优先级：pause 判定先于 skip（闸先于去重），max_fires 先于 rate 先于 loop。
test("pause 优先于 skip", () => {
  assert.deepEqual(
    decideWake({ ...base, recentFireCount: 12, hasPendingSameEvent: true }),
    { action: "pause", reason: "rate" },
  );
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/wakeGuard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

纯函数，判定顺序（**顺序本身是契约，注释写明为什么**）：
1. `!manual` 时先判闸：`fireCount >= (maxFires ?? WAKE_DEFAULT_MAX_FIRES)` → `max_fires`；再 `recentFireCount >= WAKE_HOURLY_RUN_LIMIT` → `rate`；再 `chainRepeatCount >= WAKE_LOOP_REPEAT_LIMIT` → `loop`；
2. 再判去重（**manual 也适用**）：`allInputsFromSelf` → `acknowledged`；`hasPendingSameEvent` → `merged`；
3. 否则 `fire`。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/wakeGuard.test.ts`
Expected: PASS（9 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §5.5、§5.2）：
- §5.5 的五条规则（max_fires/rate/loop/merge/自我承认）是否**逐条**有实现与测试？
- §5.2「防失控只约束非人发起；用户手动豁免」是否落地？豁免范围是否**恰好**是那三条（不多不少）？
- 阈值是否取自 Task 3 的常量（而非就地硬编码）？

**② 穷举**——**2 路径 × 5 规则** 的矩阵必须逐格有结论：
| | max_fires | rate | loop | merged | acknowledged |
|---|---|---|---|---|---|
| manual=false | | | | | |
| manual=true | | | | | |

再穷举：`maxFires` × {未设(用默认 20), 0, 19, 20, 21}；`recentFireCount` × {11, 12}；`chainRepeatCount` × {1, 2}；多条件同时命中时的**优先级**（pause > skip、max_fires > rate > loop）。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/workitem/wakeGuard.ts packages/services/test/wakeGuard.test.ts
git commit -m "feat(squad): 防失控与派发决策（人发起豁免 + 闸先于去重）"
```

---

### Task 6: 队长角色 run 的派发（指派三态 × 触发源三态）

**Files:**
- Create: `packages/services/src/workitem/leaderDispatch.ts`
- Test: `packages/services/test/leaderDispatch.test.ts`

**Interfaces:**
- Consumes: P0 的 `WorkItem` / `isTerminalWorkItemStatus`；Task 1 的 `Squad`
- Produces:
  - `type DispatchEvent = { kind: "run.enqueued"; workItemId: string; agentId: string; isLeaderTask: boolean; squadId?: string; briefing?: SquadBriefing } | { kind: "inbox.notified"; workItemId: string; reason: string } | { kind: "wake.rule_fired"; workItemId: string; ruleId: string }`
  - `type SquadBriefing = { squadId: string; leaderAgentId: string; roster: { agentId: string; role?: string }[]; instructions: Record<string, string> }`
  - `planDispatch(input: { workItem: WorkItem; squad: Squad | null; trigger: "user" | "leader" | "rule" }): DispatchEvent[]`

- [ ] **Step 1: 写失败测试**（只列关键几条；九格矩阵按此补齐）

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch } from "../src/workitem/leaderDispatch.js";

const wi = (assignee: { type: string; id: string }) => ({
  id: "wi_1", workspaceIdentity: "ws", workspacePath: "/tmp/ws", title: "t", body: "",
  status: "todo", assignee, labels: [], properties: {}, position: 0,
} as never);
const squad = {
  id: "sq_1", name: "网关组", leaderAgentId: "ta_lead",
  members: [{ agentId: "ta_lead", role: "leader" }, { agentId: "ta_a" }],
  instructions: { stopCondition: "全部 done 即收工", maxRounds: "5" }, enabled: true,
} as never;

// 指派给小队 → 解析出队长，产出带 isLeaderTask + squadId + 简报的一次运行。
test("指派 squad：产出队长角色 run（带标记与花名册简报）", () => {
  const events = planDispatch({ workItem: wi({ type: "squad", id: "sq_1" }), squad, trigger: "user" });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_lead");
  assert.equal(run.isLeaderTask, true);
  assert.equal(run.squadId, "sq_1");
  assert.equal(run.briefing?.roster.length, 2);
  assert.equal(run.briefing?.instructions.stopCondition, "全部 done 即收工");
});

test("指派单个 agent：产出普通 run（isLeaderTask=false、无 squadId）", () => {
  const events = planDispatch({ workItem: wi({ type: "agent", id: "ta_x" }), squad: null, trigger: "user" });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued");
  assert.equal(run.agentId, "ta_x");
  assert.equal(run.isLeaderTask, false);
  assert.equal(run.squadId, undefined);
});

// 指派给人：不排队，只发 Inbox 通知。
test("指派给人的工作项：只发 inbox 通知，不发 run", () => {
  const events = planDispatch({ workItem: wi({ type: "user", id: "u1" }), squad: null, trigger: "user" });
  assert.equal(events.some((e) => e.kind === "run.enqueued"), false);
  assert.ok(events.some((e) => e.kind === "inbox.notified"));
});

// 指派给 squad 但小队已归档：不得发起 run（对应 spec §3.10/第 7 项 skip 语义）。
test("squad 已归档：不发起 run", () => {
  const events = planDispatch({
    workItem: wi({ type: "squad", id: "sq_1" }),
    squad: { ...squad, archivedAt: 1 } as never,
    trigger: "rule",
  });
  assert.equal(events.some((e) => e.kind === "run.enqueued"), false);
});

// 规则触发也要走同一处解析：不得出现「规则路径绕过队长解析」的第二条路。
test("rule 触发 squad：同样产出队长角色 run", () => {
  const events = planDispatch({ workItem: wi({ type: "squad", id: "sq_1" }), squad, trigger: "rule" });
  const run = events.find((e) => e.kind === "run.enqueued");
  assert.ok(run && run.kind === "run.enqueued" && run.isLeaderTask === true);
});

// 触发源只在事件上留痕，不改变解析：规则触发要额外带 wake.rule_fired。
test("rule 触发附加 wake.rule_fired，user 触发不附加", () => {
  const withRule = planDispatch({ workItem: wi({ type: "agent", id: "ta_x" }), squad: null, trigger: "rule" });
  assert.ok(withRule.some((e) => e.kind === "wake.rule_fired"));
  const withUser = planDispatch({ workItem: wi({ type: "agent", id: "ta_x" }), squad: null, trigger: "user" });
  assert.equal(withUser.some((e) => e.kind === "wake.rule_fired"), false);
});

// squad 缺失（已被删除或引用失效）时不得静默当作普通 agent 发起运行。
test("assignee=squad 但 squad 为 null：不发 run，只通知", () => {
  const events = planDispatch({ workItem: wi({ type: "squad", id: "sq_1" }), squad: null, trigger: "rule" });
  assert.equal(events.some((e) => e.kind === "run.enqueued"), false);
  assert.ok(events.some((e) => e.kind === "inbox.notified"));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm exec tsx --test packages/services/test/leaderDispatch.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

`planDispatch` 单一入口，按 `workItem.assignee.type` 分三支：
- `agent` → `run.enqueued`（`isLeaderTask: false`，无 `squadId`/`briefing`）
- `squad` → 需要 `squad`：若 `squad == null` 或已归档 → 只发 `inbox.notified`（reason 说明原因），**不发 run**；否则解析 `squad.leaderAgentId` → `run.enqueued`（`isLeaderTask: true`、`squadId`、`briefing`）
- `user` → 只发 `inbox.notified`

**触发源（`trigger`）只影响事件里是否附带 `wake.rule_fired`，不得改变上述解析**——三条路径共用同一处队长解析。

`briefing.roster` 取自 `squad.members`，`briefing.instructions` 取自 `squad.instructions`（8 槽位原样带上）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm exec tsx --test packages/services/test/leaderDispatch.test.ts`
Expected: PASS（5 passed）

- [ ] **Step 5: 审查（逆推 + 穷举）**

**① 逆推**（spec §3.3、§5.1、§5.7.2、§16 S10）：
- §3.3「指派给 squad 时解析出 leader，并注入队长简报（花名册 + 操作协议 + instructions）」是否逐项落地？
- §5.7.2「队长只产出派发事件与子工作项，**不改父项状态**」——本任务是否**完全没有**状态写入？
- §5.1 的三路触发是否都汇到**同一处**解析（没有第二条队长解析路径）？
- 归档对象是否走 **skip 而非失败**（§3.10/第 7 项）？

**② 穷举**——**指派三态 × 触发源三态 = 9 格**矩阵逐格给结论：
| | user | leader | rule |
|---|---|---|---|
| assignee=user | | | |
| assignee=agent | | | |
| assignee=squad | | | |

再穷举：`squad` 为 `null` / 已归档 / 正常；`squad.members` 1 个 / 12 个；`instructions` 缺槽位（应已被 Task 1/2 拦住——确认此处不会绕过）；`workItem.status` 为终态时是否仍派发（spec 未禁，写明结论）。

- [ ] **Step 6: 提交**

```bash
git add packages/services/src/workitem/leaderDispatch.ts packages/services/test/leaderDispatch.test.ts
git commit -m "feat(squad): 队长角色 run 的派发（三态×三源单一解析 + 简报注入）"
```

---

## 计划的自我审查（Self-Review）

**1. Spec 覆盖**（spec §15 P1 = 唤醒规则 + 防失控 + 队长角色 run + 队长指令模板）：
- 队长指令模板 → Task 1（8 槽位 + 2 必填）
- Squad 实体（队长 run 的前置） → Task 1、2
- 唤醒规则（event/条件/at/every/cron + 互斥） → Task 3、4
- 防失控三件套 + merge + 自我承认短路 → Task 5
- 队长角色 run → Task 6
- **未覆盖（属 P2+）**：工作树建/合/抛与孤儿清理、评论/活动时间线、Inbox 完整语义、元数据、交付物、PR 集成、成本记账、AI 建 agent 向导、`SquadService.archive` 的**指派转交**（Task 2 已显式裁定留给 P2）。

**2. 占位符扫描**：无 `TBD`/`TODO`/「适当处理」类表述；每个代码步骤给了可执行代码或精确 SQL/契约。「按 P0 的 X 风格写」「照抄 teamAgentStorage 的形态」是**遵循既有代码模式**（AGENTS.md 要求），不是占位符。

**3. 类型一致性**：`Squad`（T1）→ `squadService`（T2）→ `planDispatch` 的 `briefing`（T6）字段一致；`WakeRule`（T3）→ `wakeRuleRepo`（T4）→ `decideWake`（T5）一致；阈值只在 T3 定义、T5 消费；`isTerminalWorkItemStatus` 全阶段复用 P0 的实现。

**4. Review Focus 落点**：五条隐含失败模式各有归属任务与其测试——重复触发/重放（T5 merged）、revision fencing（T4 casAdvance + T5）、人/规则双路径对照（T5）、九格矩阵（T6）、kind×mode 互斥（T3）。

**5. 审查两法已内置**：每个任务 Step 5 都拆成 **① 逆推**（对着 spec 具体小节逐条反查）与 **② 穷举**（先列枚举全集矩阵、再逐项给结论），并明确「只有逆推视为未完成审查」。
