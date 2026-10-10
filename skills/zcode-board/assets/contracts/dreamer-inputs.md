# dreamer 输入 · 候选方法日志格式契约（method-candidate.v1）

- 冻结于：T15（2026-10-09）。**只落格式**：不实现写入器、不实现自动捕获、不定义 dreamer 角色（后者属第五期）。
- 定位：第四期已由 T1 冻结第一类输入（`run_event` → `runs.json`，见 `run-event.md` 与 `templates/runs.template.json`）；本文件补第二类输入——第五期 dreamer 的候选方法日志，只落格式，不落实现。
- 上游设计：`/Users/linguojin/Workspace/ZCode/.zcode/board/design.md` §10.5（tool-reuse 事后捕获可机械化的注记，仅作边界参照）、§10.3（共享技能/hook 改动需用户确认的门槛）、§12（缺失容错语义）。
- 对端契约：`run-event.md`（run_event.v1，T1 冻结）。本文件与其**字段零重叠**（第 5 节逐项比对），遵守"单一事件单一家"。
- 相关方：第五期 dreamer（唯一读取方）；写入者本期待定（第 4 节）。

## 0. 定位与不变量

- 本日志记**命令级可复用方法线索**：一条线索回答"这个方法值得复用吗"，**不是**"谁在何时做了什么"。
- 单一事件单一家（两条铁律）：
  - 执行事实（谁 / 何时 / 结果 / 断点 / 现场 / 产物）只在 `run_event` → `runs.json`；
  - 方法线索（可复用方法 / 出处 / 状态）只在本日志。
- 同一事实不得双写。一次执行里出现了好方法 → 是两条彼此独立的陈述：执行事实进 runs，方法线索进本日志，各归各家。
- 不猜内容、不自报机械字段：未列字段不得私加（字段表即全集，防契约漂移）；无法核验的线索不入日志（证据指针必填，第 2 节）。
- 本日志**不进看板**：它不是板的真相源，编译器完全忽略（第 3 节）。

## 1. 载体形态

- JSONL：每行一个 JSON 对象，UTF-8，行尾换行；不允许注释、不允许跨行对象、不允许一行多对象。
- 追加式；读取方（第五期）逐行 `JSON.parse`，单行损坏跳过该行、不因一行丢弃全文件——与 runs 的容错原则同构。
- 对象内字段顺序不承载语义；第 3 节样例按第 2 节表格顺序书写。

## 2. 字段表

| 字段 | 必填 | 类型 | 取值/约束 | 语义 |
| --- | --- | --- | --- | --- |
| `capturedAt` | 必填 | string | ISO 8601 **带时区**：`YYYY-MM-DDTHH:MM:SS±HH:MM` 或 `...Z`；不接受无时区的本地时间写法 | 该线索被记录的时刻。由写入者补齐（机械字段），不由被记录的角色自报（防伪造时钟，同 run 事件原则） |
| `origin` | 必填 | object | `{"type":"agent"\|"hook","name":"<非空字符串>"}` | 线索来源：`agent` 时 name=角色名（建议沿用 run_event 词表，格式只要求非空）；`hook` 时 name=hook 脚本名 |
| `trigger` | 必填 | object | `{"kind":"command"\|"scenario","summary":"<单行 ≤200 字符>"}` | `command`：触发/被复用的命令原文（summary 即命令，一行）；`scenario`：无法还原为单条命令时的场景摘要 |
| `methodSummary` | 必填 | string | 单行、非空、≤200 字符 | 候选方法摘要：可复用方法线索的一句话（不是执行叙述） |
| `evidenceRefs` | 必填 | string[] | 非空数组；每项为**相对项目根**的文件路径（不得绝对路径、不得含 `..`） | 证据指针：该线索出现/被验证过的文件出处（指针不抄内容） |
| `status` | 必填 | string | `candidate` / `promoted` / `discarded`；**本期只产生 `candidate`** | 线索状态；`promoted`/`discarded` 的写入时机与状态推进留第五期（第 4 节） |

字段表即全集：写入者不得添加未列字段（`cards`/`result`/`nextStep`/`worktree` 等一律不属本日志）。

## 3. 样例、存放路径与编译器关系

**样例（逐行可 `JSON.parse`，即本契约的机器可验形态）**：

```jsonl
{"capturedAt":"2026-10-09T22:40:00+08:00","origin":{"type":"agent","name":"implementer"},"trigger":{"kind":"command","summary":"rg --files-with-matches 'updateStatus' ZPaPa/packages"},"methodSummary":"先统计重复实现再决定是否抽公共函数，避免凭印象重构","evidenceRefs":["ZPaPa/packages/desktop/src/updateStatusModel.ts"],"status":"candidate"}
{"capturedAt":"2026-10-09T22:41:12+08:00","origin":{"type":"hook","name":"record-run.mjs"},"trigger":{"kind":"scenario","summary":"同一手工步骤在两个任务卡上被重复执行第二次"},"methodSummary":"把重复出现的手工步骤固化为脚本或模板再复用，而非第三次手工执行","evidenceRefs":[".zcode/board/runs.json"],"status":"candidate"}
```

**存放路径**：`<项目根>/.zcode/board/method-candidates.jsonl`。

**编译器忽略该文件**（逐条写死）：

1. **非 `sources[]` 成员**：`sources[]` 只列 interviews.json / registry.json / runs.json + `specs/<f>/{tasks.md,progress.json}` + 计划目录（设计 §3.3；契约 v2.4/#72 起默认只 `.zcode/plans/`，`docs/plans/`、`docs/design-notes/` 为 opt-in——见 markers.md §9）；本文件永不进 `sources[]`。
2. **非 board 派生输入**：编译器不读、不校验、不写；`board.json` 不含其任何字段；本文件变化不触发重编译（`watch-sources.mjs` 只对 sources 成员路径触发）。
3. **不进看板**：board.json/board.md 与右侧栏看不到候选线索——它是第五期 dreamer 的私粮。

其它：

- **缺失容错**：文件不存在 ≡ 空日志（读取方视为空数组；与 interviews/runs 缺失语义同构，设计 §12）。
- **git**：随 `.zcode/board/` 的忽略策略（T2），默认可入 git 审计；格式不依赖 git。
- 追加式单写者（第 4 节）；本期不建文件、不删文件、不改文件。

## 4. 写入者（本期待定）

- **本期（第四期）不实现任何写入器**：无 hook、无脚本、无角色写入本文件——**格式已冻结，写入者与自动捕获留第五期**。本期任何 agent 与编排者不得直写（文件级单写者原则：写者待定不等于谁都能写）。
- 第五期候选形态（设计 §10.5 注记）：PostToolUse hook 事后捕获"候选方法日志 + 提醒登记"（对应 tool-reuse 第 4 步沉淀）；事前查索只做 best-effort 提醒、不拦截。启用属共享技能/hook 改动，**需用户确认**（设计 §10.3 确认门槛）。
- 写入者落定后的义务：追加式写、逐行合法 JSON、`capturedAt` 由写入者补齐（不自报）。
- `promoted`/`discarded` 的推进语义（写入者/键/时机）留第五期；若需增字段或改语义，走新任务 + 版本号变更（同 run 事件冻结纪律）。

## 5. 与 run 事件的分界

### 5.1 字段逐一比对（零重叠）

下表逐一列出 `run-event.md` 的全部字段（含 runs.json 记录字段），与本契约字段对照。名称集合交集 = ∅（机器自验记录：`evidence/T15-format-check.txt`）。

| run_event / runs.json 字段（`run-event.md` §2/§3 冻结） | 本契约对应物 | 比对结论 |
| --- | --- | --- |
| `role` | `origin.type` + `origin.name` | 名称不同：一个是本次执行角色（词表受限），一个是线索来源（agent/hook） |
| `result` | `status` | 名称不同：一个是执行结果（done/partial/failed/interrupted），一个是线索状态（candidate/promoted/discarded） |
| `cards` | —（无） | 候选日志不引用卡号：线索按方法归档，不按卡归档 |
| `stoppedAt` | —（无） | 断点语义是 run 事件独有 |
| `nextStep` | —（无） | `trigger.summary` 是触发摘要，不是"下一步" |
| `evidence` | `evidenceRefs` | 名称不同、语义不同：run evidence = 本次执行产物/证据路径；本契约 = 线索出处文件路径 |
| `worktree` / `branch` | —（无） | 执行现场是 run 事件独有 |
| `runId` / `sessionId` | —（无） | 机械身份字段是 runs 独有 |
| `at` | `capturedAt` | 名称不同：at = hook 落账时刻；capturedAt = 线索记录时刻（都带时区，但记的是不同事件） |
| `breakpoint` / `breakpoint.next`（runs.json 记录） | —（无） | 断点结构是 runs 独有 |

机器抽取的字段名集合：

- run 侧（`run-event.md` §2 字段表）：`at, branch, cards, evidence, nextStep, result, role, runId, sessionId, stoppedAt, worktree`
- 本契约侧（含嵌套）：`capturedAt, origin, origin.type, origin.name, trigger, trigger.kind, trigger.summary, methodSummary, evidenceRefs, status`
- **交集 = ∅**（单一事件单一家）。

### 5.2 什么事实进哪一家（一行示例对比）

判定口诀：问"这是发生了一次执行，还是发现了一个可复用的方法？"——前者进 runs，后者进本日志；两者同时为真时拆成两条独立陈述，各归各家。

| 事实 | 进哪一家 | 一行样例 |
| --- | --- | --- |
| 执行了：implementer 在卡 #8 做到一半，断点 #8，下一步补单测 | `runs.json`（报告 `run_event` 块 → hook 落账） | `"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8, "nextStep": "补 updater 单测后重新验证" }` |
| 这个方法值得复用：先统计重复实现再决定是否抽公共函数（出处 updateStatusModel.ts） | `.zcode/board/method-candidates.jsonl` | `{"capturedAt":"2026-10-09T22:40:00+08:00","origin":{"type":"agent","name":"implementer"},"trigger":{"kind":"command","summary":"rg --files-with-matches 'updateStatus' ZPaPa/packages"},"methodSummary":"先统计重复实现再决定是否抽公共函数，避免凭印象重构","evidenceRefs":["ZPaPa/packages/desktop/src/updateStatusModel.ts"],"status":"candidate"}` |

### 5.3 反例（判定边界）

| 反例 | 违反 |
| --- | --- |
| 把"implementer 在卡 #8 result=partial"写进候选日志 | 执行事实错家/双写（run 事件独有） |
| `"evidenceRefs": []` | 无证据指针——不可核验的线索不入日志 |
| `"capturedAt": "2026-10-09 22:40:00"` | 无时区，不是 ISO 8601 带时区形态 |
| `"evidenceRefs": ["/Users/x/file.ts"]` | 绝对路径（要求相对项目根） |
| `methodSummary` 超 200 字符或含换行 | 有界摘要约束 |
| 一行内多个对象 / 跨行 JSON | JSONL 载体形态 |
| 增写 `cards`/`result`/`nextStep` 等字段 | 契约漂移（字段表即全集） |

## 6. 版本与冻结

- 本契约自 T15 冻结为 `method-candidate.v1`；冻结范围 = 字段名/类型/取值约束/存放路径/编译器忽略语义。
- 写入者与自动捕获、`promoted`/`discarded` 的推进语义属第五期；任何字段增改走新任务 + 版本号变更（同 run 事件冻结纪律）。
- 与 `board.schema.json` 的关系：本文件不是板输入，schema 不覆盖它；板 schema 的任何字段与本文件无关。
- 自验：`evidence/T15-format-check.txt`（样例逐行 `JSON.parse` + 字段零重叠机器比对）。
