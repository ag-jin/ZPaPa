# run_event 报告块 · 契约（run-event.v1）

- 冻结于：T1 契约包 v2（2026-10-09）。任何字段增改走新任务 + 版本号变更。
- **v2.1 变更段（T21，2026-10-09）**：§2/§3 增可选字段 `pr`（`{number, url}`；integrator 报告携带、record-run 转抄入 runs 记录——写入通道定案成文）；附"未知键不转抄"兼容说明（与 `assets/lib/runs.mjs` 的转抄白名单边界）。其余冻结不变，契约版本随之升为 v2.1。
- **v2.1 勘误段（#42，2026-10-10）——"恰一卡自动推导 worktree/branch"条款作废**：§2 缺省语义、§3 落账映射、§4 字段对齐三处的「缺省时按卡号推导 `task-<no>`（仅当 `cards` 恰含一个卡号）」一律作废，改为**仅当块内显式声明 `worktree`/`branch` 时转抄；缺省一律 `null` + diagnostics「未声明工作树」**（不推导、不造执行现场）。原因（实战）：单卡 run 未声明现场时被推导出 `task-<no>` 幽灵工作树（管理型 run —— 复核/评审/整合类 —— 尤甚），attention 侧据此误报 `unmerged-worktree` 缺口（实测板报 7 而真实工作树仅 1）。配套收紧（读侧，非本契约字段语义）：attention 的 `unmerged-worktree` 触发改为「worktree 字段命中**且**目录经 fs 互证真实存在」，字段命中而目录不存在 → 只落提示级 diagnostics，不计缺口（见 `lib/derive.mjs`、`SKILL.md` §2/§3.4）。`runs.json` 字段形态与 schema 均不变（`worktree` 仍为 `.zcode/worktrees/task-<no>` 或 `null`），故版本号不升。
- **#71 修订级成文（2026-10-10，不改版本号）——`worktree` 声明接受两形态**：按"声明自由、互证严格"，报告/记录里的 `worktree` 可为 ① `.zcode/worktrees/task-<no>`（相对板根冻结短形态）；② `<子目录>/.zcode/worktrees/task-<no>`（相对板根的嵌套项目根相对路径——板根与一层子项目根并存时的常态，如 `ZPaPa/.zcode/worktrees/task-64`）。末段固定 `task-<no>`；其余形态拒收 + diagnostics（不猜路径）。fs 互证与缺口判据不变（目录经精确/后缀匹配互证，见 §2 字段表与 `lib/derive.mjs`）；上条"字段形态不变"句的 `worktree` 形态口径随之修订为此两形态，其余不变。
- 上游设计：`/Users/linguojin/Workspace/ZCode/.zcode/board/design.md` §5.2、§5.3、§7.3、§7.5、§12（含场景 28）。
- 相关方：子智能体报告（内容作者）→ PostToolUse(派发工具) hook `record-run.mjs`（机械转抄）→ `runs.json`（唯一写入者 hook/应用）。本文件只写约定，**不修改** `/Users/linguojin/.zcode/agents/integrator.md`。

## 0. 定位与不变量

- `run_event` 是**报告里的一个标准块**：子智能体一律只读板、不写任何板文件；报告即落账载体。
- **内容作者 = 执行角色，写入者 = hook**；`runId`/`sessionId`/`at` 等机械字段**不由报告自报**（防伪造时钟）。
- runs 只记**最小事实集**（机械事件 + 断点语义），不记叙事流水——"怎么做的、遇到什么坑"的家在 `progress.json` activity 与会话历史（单一事件单一家）。
- 未知信息留空不猜；缺省字段按第 3 节缺省语义处理，**不造字段值**。

## 1. 载体形态

- 报告中的 JSON 代码块，含顶层键 `run_event`：

```json
"run_event": {
  "role": "implementer",
  "result": "partial",
  "cards": [8],
  "stoppedAt": 8,
  "evidence": ["specs/preview-channel/updater.ts"],
  "nextStep": "补 updater 单测后重新验证"
}
```

- `run_event` 的值可为**对象**（单块）或**对象数组**（多块）。解析器取报告中出现的每一处 `run_event` 键。
- **一个块 = 一次落账 = 一条 run 记录**；块内 `cards[]` 是本次事件的卡集合。推荐一卡一派发（integrator 亦按"one card at a time"约定），需要时按卡分别给块。
- 块必须能被 JSON 解析；解析失败按第 5 节容错处理（跳过 + diagnostics，不阻塞）。

## 2. 字段表

| 字段 | 必填 | 类型 | 取值/约束 | 缺省语义 |
| --- | --- | --- | --- | --- |
| `role` | 必填 | string | `implementer` / `debugger` / `refactoring-optimizer` / `code-reviewer` / `test-verifier` / `integrator`（与角色矩阵 §1.3 一致） | — |
| `result` | 必填 | string | `done` / `partial` / `failed`。**报告只能给这三值**；`interrupted` 由 Stop hook/应用在会话非正常终止时机械补记，不由报告自报 | — |
| `cards` | 可选 | integer[] | 稳定号正整数数组；不得写层级标签（`1.2`/`ID-1.2` 形态拒收） | 缺省 ≡ `[]`：无卡关联事件，不挂任何卡 |
| `stoppedAt` | 可选 | integer | 稳定号正整数（建议与 `cards` 一致）；层级标签形态拒收 | 缺省 ≡ `null`（不造、不猜卡号） |
| `evidence` | 可选 | string[] | 相对项目根路径；worktree 内路径以 worktree 为前缀 | 缺省 ≡ `[]` |
| `nextStep` | 可选 | string | 单行、≤200 字符 | 缺省 ≡ `null` |
| `worktree` / `branch` | 可选 | string | 执行现场（`task-<no>` 命名，§6.1；#71 起接受两形态：`.zcode/worktrees/task-<no>` 或 `<子目录>/.zcode/worktrees/task-<no>`——见文件头 #71 修订级成文）；轻量执行可缺省 | **仅显式声明时转抄**；缺省一律 `null` + diagnostics「未声明工作树」（v2.1 勘误 #42：不按卡号推导） |
| `pr` | 可选 | object | `{number: 正整数, url: http(s) 链接}`；integrator 在**远程门禁模式**合并完成时携带（设计 §7.3；本地模式恒缺省） | 缺省 ≡ 不落该字段（板侧 `pr` 为 `null`，不造远程号）；形态非法 → 该值不落 + diagnostics（不猜） |
| 未知键 | — | — | 解析器**忽略、不转抄**（保持单一事件单一家，防止契约漂移） | — |
| `runId` / `sessionId` / `at` | **不得自报** | — | 机械字段，由 hook 补齐；报告若携带一律忽略 | — |

## 3. 落账映射（run_event → runs.json 记录）

| runs.json 字段（§5.2） | 来源 | 规则 |
| --- | --- | --- |
| `role` / `result` | 报告照抄 | 词表校验；表外值 → 跳过该块 + diagnostics |
| `cards` | 报告 `cards` | 缺省写 `[]`（无卡关联事件） |
| `evidence` | 报告 `evidence` | 缺省写 `[]` |
| `breakpoint` | 报告 `stoppedAt` + `nextStep` | 两者**都缺省** → `breakpoint: null`；否则 `{stoppedAt: <值或 null>, next: <值或 null>}`——缺省位写 `null`，不造内容 |
| `worktree` / `branch` | 块内显式照抄（仅显式声明） | 仅当报告**显式给出**时转入该字段；缺省一律 `null` + diagnostics「未声明工作树」（v2.1 勘误 #42：取消按卡号推导——推导会为管理型 run 造出幽灵执行现场，误触 `unmerged-worktree`） |
| `pr` | 报告照抄 | 仅当报告给出且形态合法（`{number: 正整数, url: http(s)}`）时写入该字段；缺省不写（板侧派生为 `null`）；形态非法 → 不落 + diagnostics |
| `runId` | hook 生成 | `run-<YYYYMMDD>-<短随机后缀>`，不可变 |
| `sessionId` | hook 补齐 | 当前会话 id |
| `at` | hook 补齐 | 落账时刻（带时区 ISO 8601） |

追加式（append-only）+ "临时文件 + 原子改名"；入 git。

**"未知键不转抄"兼容说明（v2.1）**：v1 冻结的未知键规则（§2 末行）使报告里的**非契约键**一律不转抄——防止契约漂移；`pr` 自本版本起**进入契约字段表（已知键）**，其转抄由 `mapRunEvent` 的已知键白名单承载（写明"integrator 携带、record-run 转抄"即为该通道的定案成文）。边界：白名单之外的键（含未来想加的字段）仍一律忽略，不得借 `pr` 通道顺手扩展；`pr` 转抄实现与契约同步落地前，报告携带的 `pr` 与其它未知键一样不进入 runs 记录——**不得以"未知键"为由伪造 pr、也不得由编排者手写 runs.json**（文件级单写者不变）。板侧 `pr` 的读取路径不受影响：`lib/derive.mjs` 对 runs 记录的 `pr` 已有形态校验（`{number, url}`，非法不落字段 + diagnostics）。

## 4. 与 `merge_report.v1` 的字段对齐（板侧约定）

`/Users/linguojin/.zcode/agents/integrator.md` 定义的 `merge_report.v1`（本任务**不修改**该文件）在报告内**同样携带 `run_event` 块**（`role: "integrator"`），使 merge 事实照常机械落账（设计 §7.5）。对齐约定：

| merge_report.v1 已有内容 | run_event 块 | 说明 |
| --- | --- | --- |
| 卡号（card number） | `cards: [<no>]` | 整数稳定号，不写层级标签 |
| 分支（branch）/ 工作树路径（worktree path） | 可在块内给出（可选） | 仅显式给出时转抄；缺省一律 `null`（v2.1 勘误 #42：不按卡号推导 `task-<no>`） |
| 门禁证据出处（两条 verdict 的来源与结论） | `evidence[]` | 落为路径指针（如 `.zcode/board/runs.json`、报告文件路径） |
| 动作（rebase 结果、merge commit hash / PR URL、清理完成） | `evidence[]` 追加一条合并凭据：本地 `Merge task-<no> [#<no>] (<hash>)`；远程为 PR URL | 合并事实的机械凭据；远程模式的 PR 另以 `pr` 字段携带（v2.1，见 §2） |
| 阻塞卡与确切阻塞原因（blocked cards） | 该卡**单独一块**：`result: "failed"`、`cards: [<该卡>]`、`breakpoint: {stoppedAt: <该卡>, next: "<阻塞原因一句话>"}` | 阻塞**不得记 `done`**：`unmerged-worktree` 缺口保留，退回路径按设计 §12 |
| 集成模式与理由（mode + reason）、建议下一角色 | 不进 `run_event` | 叙事与建议留在报告正文；runs 只记最小事实集 |

- 一致性要求：`result: "done"` 仅当该块的卡**全部门禁通过、已合并、工作树已正规清理**；任何 blocked 卡不得进入 `done` 块。
- integrator 无 Write/Edit 工具，物理上不能写板文件；落账仍由 PostToolUse(派发工具) hook 完成，编排者不直写 `runs.json`。

## 5. 容错语义（设计 §12 / 场景 28 逐条冻结）

| 情形 | 行为 |
| --- | --- |
| 报告**无 run_event 块** | **跳过落账** + diagnostics 提醒（schema 提示）；进程不失败；板照常重编译 |
| 块 JSON 解析失败 / 非对象 | 同上：跳过 + diagnostics，不阻塞 |
| 块内字段缺省 | **容错落账**（机械字段由 hook 补齐）：数组类缺省写空数组，`stoppedAt`/`nextStep` 缺省写 `null`；**不造字段值**（不猜卡号、不推导执行现场——`worktree`/`branch` 缺省一律 `null` + diagnostics「未声明工作树」（v2.1 勘误 #42）、不编下一步） |
| `cards: []` 或 `cards` 缺省 | 落账为**无卡关联事件**：不挂任何卡，卡的 `lastRun`/`activeRun`/attention 不因它变化 |
| `stoppedAt` 缺省 | `breakpoint` 不造 `stoppedAt`（写 `null`）；不按 `cards` 猜卡号 |
| `cards`/`stoppedAt` 写了层级标签形态 | 该值**不解析**（丢弃并 diagnostics）；不静默改写为其他号 |
| 落账失败（磁盘/权限等） | hook 不阻塞主流程；Stop 对账点名"未登记"兜底（§10.4）；重编译失败由 mtime 陈旧角标兜底 |
| 报告含多个 `run_event` 块 | 逐块落账（每块一条记录），互不合并 |

- 落账**同步**执行（其后任何读板前可见）；重编译可 async（§10.4）。

## 6. 正例与反例

```json
// 正例：implementer 断点
"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8, "evidence": ["specs/preview-channel/updater.ts"], "nextStep": "补 updater 单测后重新验证" }

// 正例：integrator 合并完成（本地模式）
"run_event": { "role": "integrator", "result": "done", "cards": [9], "evidence": [".zcode/board/runs.json", "Merge task-9 [#9] (a1b2c3d)"] }

// 正例：integrator 合并完成（远程门禁模式，PR 号经 pr 字段落账——v2.1）
"run_event": { "role": "integrator", "result": "done", "cards": [9], "pr": { "number": 41, "url": "https://github.com/ag-jin/ZPaPa/pull/41" }, "evidence": [".zcode/board/runs.json"] }

// 正例：integrator 阻塞（rebase 冲突）
"run_event": { "role": "integrator", "result": "failed", "cards": [12], "evidence": [".zcode/board/runs.json"], "nextStep": "rebase 冲突：卡片分支需 debugger 处理后再进合并队列" }

// 反例：卡号不推断执行现场（v2.1 勘误 #42）→ worktree/branch 落 null + diagnostics「未声明工作树」
"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8 }
// 正例：真开了工作树就显式声明（缺省不会替你写）
"run_event": { "role": "implementer", "result": "partial", "cards": [8], "stoppedAt": 8, "worktree": ".zcode/worktrees/task-8", "branch": "task-8" }

// 反例：层级标签进引用位 → 该值不解析 + diagnostics
"run_event": { "role": "implementer", "result": "partial", "cards": ["ID-1.2"], "stoppedAt": "1.2" }

// 反例：自报机械字段 → 一律忽略（以 hook 补齐值为准）
"run_event": { "role": "implementer", "result": "done", "runId": "run-19700101-0000", "at": "1970-01-01T00:00:00Z" }
```

## 7. 版本与冻结

- 本契约自 T1 冻结（v2）；**v2.1（T21）**增可选字段 `pr` 与"未知键不转抄"兼容说明，其余字段语义零变更。**v2.1 勘误（#42，2026-10-10）**：`worktree`/`branch` 的"恰一卡自动推导"作废（缺省一律 `null` + diagnostics；字段形态与 schema 不变，故版本号不升）——见文件头勘误段。`runs.json` 的字段契约以 `assets/templates/runs.template.json` 为准，本文件与之一致。
- 已冻结的缺省语义（第 3、5 节）与 runs 记录形态（`assets/templates/runs.template.json`）不得在下游任务中"顺手扩展"；确有需要走新任务 + 契约版本号变更。
