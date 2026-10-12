# spec：后台子 agent 重启后孤儿收敛（subagent orphan reconcile）

> 设计依据：[`docs/plans/subagent-orphan-reconcile-design.md`](../../plans/subagent-orphan-reconcile-design.md)
> （architecture-planner 产出，本文件的唯一上游）。基线：`48f7f18`（冷恢复按 child session 真实终态裁决）。
> 问题编号 P2-1。本文是该行为的**验收边界**：实现与评审都以下列条文为准，术语与设计文档一致。
> 2026-10-12 扩展（诊断 `ZCode/.zcode/debug/subagent-silence-report.md` 的「重启缺口」四项裁决）：
> §1.4b 父会话唤醒（裁决 1 = 父侧持久事实 + 复用通知管道）、§1.7 恢复面（裁决 2 = 2B）、
> §1.8 TaskOutput/TaskStop 回退（裁决 3 = 3D）、§3.3 账本重开语义。原 §1.4「不合成任何父会话
> 事件」按裁决改写，见 §1.4b。

## 1. 产品规则

### 1.1 问题

`48f7f18` 的冷恢复规则是「已知 child ∧ 无终态记录 ⇒ running」。它保护了「切走再切回仍在跑」的
agent，但留下无界漏洞：宿主进程被硬杀 / 崩溃、child session 没留下任何终态落盘时，重启后该
agent **长期显示 running**——面板出现一张无 Stop 入口的常驻卡片，永不自愈。

### 1.2 收敛规则（唯一行为条文）

一个 child 被收敛为孤儿，当且仅当以下条件**全部**成立：

| 判据            | 内容                                                                                          | 数据来源                                                        |
| --------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| J1 后台启动     | `runInBackground === true`（持久化 spawn input）                                              | 父 transcript 的 spawn 候选枚举 `collectCandidates`             |
| J2 已知 child   | ∈ 权威清单 `readSessionSubagentInventory().childSessionIds`                                   | store：child session 记录在场 ∧ `taskType === "subagent_child"` |
| J3 无终态       | 当前落在清单 `running` 集合（无 outcome / 无 stop 关系 / 无 background 终态 / part 无 error） | 同上（`projectSessionSubagents`）                               |
| J4 本进程不认领 | 本 runtime 对该 child 无 live 记录（`context.sessions` 无 child）                             | 进程内内存态                                                    |
| J5 过宽容期     | child 最后持久活动距今 > `SUBAGENT_ORPHAN_GRACE_MS`（10 分钟）                                | `max(childSession.time.updated, child transcript 最后消息时间)` |

J5 的宽容期是**有界**的代价项：孤儿最长多显示 10 分钟 running，换取对「契约外双进程」里另一
进程仍在跑的 agent 的防御（不误杀优先于收敛及时性）。

### 1.3 触发时机（唯一挂点）

- 挂在 `activateSessionForResume` 成功路径**尾部**（`app.resume()` 之后、返回之前）。
- 这是**唯一**可证明「本 runtime 对该会话名下零个在飞 agent」的时刻：runtime task registry 是
  进程私有内存态、冷恢复新建即为空，跨进程 resume 在现状不存在（SendMessage 只认本进程 registry）。
- 不做冷 hydration 内收敛（投影重建路径不拥有会话）；不做切会话收敛（已激活会话早退，不满足零在飞）；
  不做周期看门狗（孤儿是一次性历史遗留，非持续病态）。
- 已激活会话的重复订阅走 `existing` 早退 ⇒ 不重复收敛（天然幂等）。浏览器回放桶无 session store，
  本来退 part 推断（有界），不参与收敛。

### 1.4 收敛动作

收敛分两层。两层共用**同一把尺**：终态证据链 `真实 outcome > subagent_outcome entry > lost`（§1.5），
任何一层都不得另立第二把尺。

**a) 持久事实（display 层，机制原名「收敛」）**

- 写 child session 的持久 session entry：
  `type: "subagent_outcome"`、`id: "subagent-outcome:<childSessionId>"`（确定性幂等键）、
  `data: { status: "lost", reason: "runtime_exit", parentSessionId, reconciledAt, runtimeInstance: <pid> }`、
  `time: { created, updated } = reconciledAt`、`touchSession: false`（收敛不是任务活动，不改 child 的活动时间）。
- **不合成任何父会话事件**（不写 `SubagentStopped`）：事件日志的契约是「引擎发过什么」，
  收敛者只补齐 child 持久事实；展示层终态由 hydration 按终态事实自然合成（`lost → failed` 行）。
- 终态选 `lost`（侧栏词表已有「已丢失」/「Lost」），row 层按 `48f7f18` 定案收口成 `failed`，
  **不新造终态词**、不新造 UI 文案。

**b) 父会话唤醒（2026-10-12 裁决 1，取代本条原文「不合成任何父会话事件」）

原条文只补 child 持久事实，父会话模型永远不知道它启动的后台 agent 已死（诊断 R2-2 三轮红）。
裁决 1 = 组合方案：**父侧持久事实（幂等锚 childSessionId）+ 复用后台通知 admission/drain 管道真唤醒**。
「不合成父会话事件」的契约理由（事件日志=引擎发过什么）保持不变：唤醒是一条**投递**
（model-only synthetic user message），不是第二份终态事实，不进 subagent 投影、不改读面终态。

**触发时机**：`activateSessionForResume` 尾部（与 a 层同一次接管、写完 entry 之后、hydration 之前）。
候选集合 = 本次新收敛的孤儿 ∪ 读面 `ended` 里带 `reconciled: true` 的 child
（该标记的语义是「**这条行的终态由 entry 决定**」——真实 outcome 已到场的 child 不在候选内）。

**唤醒判据（全部成立才投递，任一不成立只保留 a 层）**：

| # | 判据 | 内容 |
| - | ---- | ---- |
| W1 | 终态由 entry 决定 | 读面 `reconciled === true`（真实 outcome > entry：真实结果到场即自愈，不唤醒） |
| W2 | **pid 硬证据** | agent 产物目录 `metadata.json` 的 `runtimeInstance.pid`（spawn 时由宿主进程写入）在场 ∧ 该 pid 不存活（`kill(pid,0)` 失败且非 EPERM）。宽容期（J5）只为 display 层校准；模型可见的「已丢失」断言必须有进程级死亡证据。pid 复用窗口的代价落在保守方向：pid 被复用（存活）⇒ 不投递，宁可不投递不误报。旧版本 spawn 的 agent（metadata 无 pid）/ 文件缺失 ⇒ 证据不可用，不投递 |
| W3 | 父侧无已交付标记 | session_input 账本行 id = `subagent-orphan-wake:<childSessionId>`：**只有「缺席 / `admitted` / `discarded`」三种状态算未交付**——`promoted` = 已交付；其余终态（`cancelled` / `failed` 及未来新增状态）一律视为已终态、不再重投（防御性收口：现路径产不出这两种状态，但「不在白名单内即视为终态」比「只跳过 promoted」安全，避免未来状态变更静默变成每次激活重投）。`admitted` 是上一条命令在途；重启被 `session_resumed` 收口的在途行必须可重开，见 §3.3 |

W3 判据放在父侧（不是「本次新收敛集合」）：崩溃在「entry 已写、admission 未落 / 未消费」之间时，
下次激活 child 已不在 running 集合，只有父侧标记能区分「没投过」与「投过了」。

**投递（复用既有管道，不新建面）**：

- 每条 lost child 一条 `task-notification` 命令：**账本 admission id 用上面的确定性键，并兼作命令 id**
  （既有管道的 promotion 按 `String(command.id)` 补标记，两者必须同源；随机命令 id 会让账本行永不
  `promoted` ⇒ 每次激活重投）；同一批一次 drain
  ⇒ 同一次收敛的多个 lost **合并成一条** model-only synthetic 消息 + 一个模型轮（`dequeueNextBatch` 既有语义）。
- 通知文案：`<task-notification>` 形态；状态词 `lost`（诚实词，非第二把尺——它就是 entry 的终态）；
  含 `<task-id>`（agentId）、childSessionId、原因 `runtime_exit`、被杀前产出摘要（恢复面，§1.7）
  与「**可能重复**」说明（at-least-once，见下）；文案同时写明「若已见过该 agent 的真实结果，以真实结果为准」。
- **呈现归属：新 origin kind `backgroundSource: "subagent_lost"`**（协议 `.strict()` 闭集扩展，
  CLI 与客户端同批发布）。**禁止蹭 `"subagent"`**：UI 轮标题白名单与遥测
  `backgroundSubagentResultConsumed` 都按 `backgroundSource === "subagent"` 判「后台结果到达」，
  蹭用会把「丢失」渲染/统计成「结果到达」（正是诊断交叉核对里被证伪的那类归因的机器化版本）。
- 幂等与重复语义（红队 A1-3）：
  - **at-least-once**：账本 promotion 与消息持久化在既有管道里不是同一事务
    （`markSessionInputPromoted` 是补标记）。崩在「消息已写、标记未落」之间 ⇒ 下次激活重投递；
    文案已声明可能重复。**不追求恰好一次**。
  - 交付标记与事实同源：标记是父会话账本行（durable），投递内容是消息；两者都不依赖进程内认领
    （接管时刻 registry 为空，`notified` 认领无处落，见红队 A1-5）。
- 失败降级：W2 证据读不到、账本读写失败、runtime 不在场（无 record / 旧宿主）⇒ 只 `warn`，
  保留 a 层收敛，绝不拖垮激活（N9 语义不变）。

### 1.5 读面语义（终态证据优先级）

`readSessionSubagentInventory` 在读取 child 时顺带读该 child 的 `subagent_outcome` entry，作为
**最低优先级**证据接入 `projectSessionSubagents`：

```
running 判定：live 父投影 / live child 投影 优先；「后台 spawn 兜底宣称 running」分支增加
              「无 reconcile entry」条件——entry 在场即不再凭空宣称存活。
ended 判定：  childOutcome（真实 outcome）> entry > "lost"（既有兜底）
```

真实 outcome 后来到场时**赢过** entry（终态永远以真实记录为准）。

### 1.6 失败与降级

收敛是自愈动作，不是激活的前提：读清单、读 child 事实、写 entry 任一步失败都只记 `warn`
并跳过该 child（结果里标记失败原因），**绝不抛出、绝不拖垮激活**。后果只是该孤儿暂不收敛。

### 1.7 恢复面：child transcript 尾部（2026-10-12 裁决 2 = 2B）

**定义**：被打断（硬杀 / 崩溃 / 进程退出）的 in-flight 子代理，「被杀前的产出」唯一持久面 =
**child session 的 transcript 尾部**。产物目录（`output.txt` / `task.output`）只在终态收尾写
（`write*AgentArtifacts`），硬杀路径一条都到不了——运维直觉「output.txt 是事实源」对 in-flight 是假话。

**零新写者**：不落 partial 文件、不做运行期增量写、不做收敛者回填（2C / 2D 被否：与 transcript
重复状态、常驻 IO、产物目录第二写者）。恢复面是**读侧定义**，写侧完全不变。

**提取规则（唯一提取函数，core 公共面；三处消费共用，不各写一份）**：

- 取 child transcript 中**最后一条** assistant 消息；
- 只收集 `type === "text"` 且 `ignored !== true` 的块，按序拼接（与读面 `lastChildOutcome` 的
  文本口径一致）；
- 截断到 N = 4000 字符，**保留尾部**（最新产出最相关），前部以省略标记开头；
- 流恢复作废的半截 assistant（`error.name = STREAM_RECOVERY_DISCARDED_ERROR_NAME`）不参与提取；
- 无 assistant 文本 ⇒ 空态（不报错、不伪造内容）。

**消费面**：① 丢失唤醒通知的 `<result>` 摘要（§1.4b）；② TaskOutput registry miss 回退的 output
（§1.8）；③ 人 / 模型主动读 child 会话（既有 `readSubagentTranscript` 读面，本定义不改它）。
存量 61 个零产物目录：只要 child 会话记录在 store，恢复面立即覆盖（定义对存量有追溯力）。

### 1.8 TaskOutput / TaskStop 的 registry miss 回退（2026-10-12 裁决 3 = 3D）

进程内 `runtimeTaskRegistry` 是活性 / 认领的唯一权威，重启即空（§2）。重启后按 agentId 查任务
直接 `No task found`——「output.txt 是事实源」的运维兜底在重启场景失效

**回退解析（只在 registry miss 时走，命中时行为一字不变）**：

- `agentId → childSessionId` 由**确定性推导**：`createSessionId(\`subagent_${agentId}\`)`
  （与 runner 生成 child 会话同一函数，无索引、无新状态）；
- 查 store：child session 记录在场 ∧ `taskType === "subagent_child"` ∧ **`parentID === 当前会话`**
  （归属校验双查，house pattern 同 `subagent-observation.ts` 的 `readSubagentTranscript`；不满足 ⇒
  维持既有 `No task found`，不猜测。只查 taskType 会让本会话解析出他会话 agent 的恢复面——越权读）；
- 终态锚 `subagent_outcome` entry（同一把尺、**唯一解释者**的同一解析函数）：**只认 `status: "lost"`**。
  无 entry ⇒ 维持既有 `No task found`——真实完成 / 失败的死任务不在本回退的解析面内（诚实边界；
  它们的 output.txt 存在于产物目录，由运维 / 文件面读，不在本机制范围）；
- 状态词映射：`lost → failed`（沿用 row 层先例，`§1.4a`）；`lost` 事实与原因写进 `error`，
  output 取恢复面（§1.7）尾部；`outputFile` 留空（死任务没有可读产物面，不把路径伪装成可用产物）；
- **回退读不算 notified claim**：registry 里不存在该任务，`markTaskNotified` 无对象——不认领 ⇒
  不抑制后续真实通知；也**不**因读过一次就跳过丢失唤醒（唤醒只认账本标记，§1.4b）；
- 输入校验不再对 registry miss 直接判死：有回退读面时把判定交给 handler（异步读 store），
  没有回退读面（无 store 注入的旧宿主）时维持既有早退。
- **TaskStop 同病同批**：任务缺席但 child 已收敛为 lost ⇒ 报「不在运行（已丢失，进程已退出）」
  并给出同一 entry 判据的原因，而不是 `No task found`。用户停止链路（`stopBackgroundTask` 端口）
  的语义不变——回退只发生在端口返回任务缺席之后，且不产生任何写。

## 2. 状态所有者

| 状态             | 所有者                                         | 说明                                              |
| ---------------- | ---------------------------------------------- | ------------------------------------------------- |
| child 终态       | child session 持久记录（store）                | `48f7f18` 已确立的唯一持久权威                    |
| 孤儿收敛事实     | reconcile entry（child 的 `subagent_outcome`） | 只填洞不覆盖：真实 outcome 优先                   |
| 父侧唤醒交付标记 | 父会话 session_input 账本行（`subagent-orphan-wake:<childSessionId>`） | 状态 `promoted` = 已交付；重投递的幂等判据（§1.4b W3） |
| 唤醒命令 / 在途  | 父 runtime 命令队列（进程内）+ 账本 admitted 行 | 命令队列随进程消失；账本行是唯一 durable 痕迹     |
| 旧 runtime 死亡证据 | agent 产物目录 `metadata.json.runtimeInstance.pid`（spawn 时宿主写） | 只读；pid 不存活 = 语义唤醒的进程级硬证据（W2）   |
| 活性 / 认领      | 本进程 `context.sessions` / runtime registry   | 进程私有；重启即空                                |
| 面板 / 侧栏 / 行 | 纯投影（无独立状态）                           | 复用既有词表：面板卡片消失、侧栏 lost、row failed |

事件顺序（冷恢复收敛）：

```
T0  runtime A：spawn 后台 agent → registry.register；child transcript 持续落库
T1  runtime A 进程被硬杀 —— 无终态落盘，registry 随进程消失
T2  runtime B：用户打开会话 → ensureResumed → activateSessionForResume
      （record 入册 + app.resume()，此刻 B 名下该会话在飞 agent 数 = 0）
      └─ reconcileSubagentOrphansOnActivation（本机制）
             读清单（known/running/ended/live/background）→ 判 J1-J5 → 只对孤儿写 entry{lost}
             └─ [裁决 1] 对候选（新收敛 ∪ 读面 reconciled）逐条：W1 终态取自 entry
                → W2 metadata.json 的宿主 pid 不存活 → W3 账本无 promoted 标记
                ⇒ 账本 admission(subagent-orphan-wake:<child>) + 命令入队（新 origin kind
                  backgroundSource:"subagent_lost"）⇒ 批次 drain
      └─ hydratePublisher → readSessionSubagentInventory（同一次读看到 entry）
             ⇒ running=[] / ended 含 lost ⇒ row failed + 侧栏「已丢失」+ 常驻卡片消失
      └─ drain 起一个模型轮：父模型收到「后台 agent 已丢失」通知（可自查 child 会话的恢复面）
T3  之后任意 reload / 双端打开：entry 已持久 ⇒ 同一终态；账本行 promoted ⇒ 不重复投递
    （若 T2 崩在 drain 之前：行被 resume 收口为 discarded(session_resumed) ⇒ 下次激活重投递，
      文案标注可能重复）
```

## 3. 接口

### 3.1 模块接口（新文件 `bootstrap/src/zcode-protocol/subagent-orphan-reconcile.ts`）

- `SUBAGENT_ORPHAN_GRACE_MS = 10 * 60 * 1000`（宽容期常量，一处定义，可注入小值供测试）。
- `selectSubagentOrphans(facts, { now, graceMs })`：**纯函数**，输入每个候选的
  `{ childSessionId, backgroundLaunch, running, liveInProcess, lastActivityAt }`，
  输出 `{ orphans, skipped: [{ childSessionId, reason }] }`，reason 词表见下。
- `reconcileSubagentOrphansOnActivation({ context, sessionId, now?, graceMs? })`：
  读权威清单（同一次读）→ 纯判据 → 逐 orphan 写 entry → 返回
  `{ reconciled: number; skipped: [{ childSessionId, reason }] }`；读/写失败只 warn。
- 结构化日志事件：`zcode_protocol.subagent.orphan_reconciled` / `.orphan_skipped` /
  `.orphan_reconcile_failed`。
- skip reason 词表：`not_background`(J1/N7)、`terminal_evidence`(J3/N6)、`live_child`(J4/N1/N2)、
  `activity_unknown`(child 事实读不到/N9)、`within_grace`(J5/N4)、`write_failed`(N9)。

### 3.2 调用方

`activateSessionForResume` 尾部**一行**调用（唯一调用方、唯一挂点）。

### 3.3 唤醒的窄面与账本重开语义（裁决 1 的实现约束）

- **core 窄面**：bootstrap 经 `record.app.runtime` 调用一个**新公开窄方法**
  （`AgentRuntime` 公开接口上的 `enqueueSubagentLostWakes`；`enqueueBackgroundTaskNotification`
  仍在 internal 面，本批不放开它）。方法职责：逐 child 查账本标记（W3）→ 读恢复面摘要（§1.7）
  → 写确定性 id 的账本 admission → 全部命令入队后**一次** drain（同一批合并成一条唤醒）。
  集成路径由实现核定（U1）：可见性不足时在该窄方法内直写 `sessionStore` + 队列，不经 internal 接口。
- **账本重开语义**（复用同一 id 重投递的硬前提）：`session_input` 的既有 upsert
  （`on conflict(id)` 只更新 kind/delivery/payload、保留状态）是为「执行前预 admission 幂等」设计的，
  `discarded` 行不会被重开，重投递会静默失败。本批把冲突语义收紧为：
  **现有状态为 `discarded` 时重开为 `admitted`**（`discarded` = 被重启收口的未消费输入，同 id 重投递
  是「记忆中的再次投递」）；`promoted` / `cancelled` / `failed` 是真实结论，**不重开**。
- **顺序约束（必须写进测试）**：唤醒命令入队发生在 hydration 快照之前（挂点在激活尾部），
  但 drain 的模型轮是异步的——首次 hydration 快照可能先于唤醒消息落盘，也可能已含唤醒消息；
  两者都不丢，测试只需断言「激活返回后（同一进程内）唤醒事实可观察」，不得依赖哪一侧先发生。
- 批量化：同一次收敛的 N 个 lost = 一条唤醒消息 + 一个模型轮（成本与体验的红队必选项）。

## 4. 不误杀不变量与验收场景

每条不变量至少映射一个用例（测试文件 `bootstrap/test/subagent-orphan-reconcile.test.ts` 与
`bootstrap/test/coldHydrationSubagentStatus.test.ts`）：

| #   | 绝不能收敛的场合                       | 判据                                                     | 用例                                        |
| --- | -------------------------------------- | -------------------------------------------------------- | ------------------------------------------- |
| N1  | 本 runtime 正在跑该 agent              | 挂点在激活尾部；已激活会话早退                           | J4 用例（live child 跳过）+ 现有 211/230 行 |
| N2  | SendMessage resume 后在本 runtime 续跑 | 会话已激活不触发；重臂持续写 child transcript 被 J5 排除 | 同上 + 宽容期用例                           |
| N3  | 远端另一端经共享 host 观看同一会话     | ADR0003 单运行时：共享同一 host，未重启即已激活          | 同上（无独立 runtime）                      |
| N4  | 双进程违例中另一进程仍在跑             | J5 宽容期 10 分钟                                        | 宽容期内不写用例                            |
| N5  | rewind 分支上的陈旧 spawn              | J2 复用 `activeBranchMessages`/`collectCandidates`       | 候选枚举用例（分支外 spawn 不入集合）       |
| N6  | child 有任何真实终态                   | J3：只处理 running 集合成员                              | 真实 outcome 不写用例                       |
| N7  | 前台（阻塞式）Agent                    | J1：`runInBackground === true` 才参与                    | 前台用例                                    |
| N8  | 调用方读不到 child 记录（回放桶）      | J2：unknown child 不进集合，保持 part 推断               | 回放桶护栏用例（现有 297 行）               |
| N9  | child entry 读/写失败                  | warn + 跳过，绝不拖垮激活                                | 写失败用例                                  |

矩阵新档位（`48f7f18` 既有 8 档行为一档不变，新维度只在「接管时刻」切片上改写 running）：

| 档  | child 事实 | 终态证据                      | 运行时切片      | row             | 侧栏     | 父模型唤醒（裁决 1） |
| --- | ---------- | ----------------------------- | --------------- | --------------- | -------- | -------------------- |
| 2   | known      | 无                            | 接管 ∧ 宽容期内 | running（跳过） | 运行中   | 无                   |
| 3   | known      | 无                            | 接管 ∧ 过宽容期 | failed          | 已丢失   | pid 硬证据成立才唤醒；否则只收敛 |
| 8   | known      | entry ∧ 真实 outcome 后来到场 | 任意            | 真实 outcome 赢 | 真实终态 | 不唤醒（W1：终态不取自 entry） |

唤醒判据的验收场景（`bootstrap/test/restartRecoveryWake.test.ts` + 幂等/证据用例）：

| #  | 场景 | 断言 |
| -- | ---- | ---- |
| W-3 | 硬杀后接管 | R2-2 绿：父侧出现账本 admitted 行（确定性 key）+ 唤醒命令可观察；R2-1/R2-3 不回归 |
| W-1 | 二次接管（账本 promoted） | 不重复投递（无第二条命令、无第二个模型轮） |
| W-2 | 崩在 drain 前（账本 discarded） | 重开为 admitted 并重投递；文案含「可能重复」 |
| W-2b | 宿主 pid 仍存活（双进程违例） | 不投递（只保留 display 层收敛） |
| W-2c | metadata 无 pid / 文件缺失 | 不投递（证据不可用，保守） |
| W-4 | 同一次收敛两个 lost | 一条唤醒消息、一个模型轮 |
| W-5 | 真实 outcome 后来到场（entry 仍在） | 不再投递；读面终态仍是真实 outcome |

真机 E2E（留给真机执行，见交接）：① 杀进程重启后打开会话：卡片消失、侧栏「已丢失」、row failed、
无 Stop 残留；② 同会话反复 reload / 切走切回状态稳定；③ 双端看到同一终态；④ 不杀进程的切走切回
仍 running（`48f7f18` 主语义不回归）；⑤ SendMessage 到已收敛 agent 仍是既有
`No active local_agent task found` 失败。

## 5. 回滚边界

显示层机制（原范围）= 一个新文件 + `server-operations.ts` 一行挂点 + 读面一处消费：挂点与读面消费
**同一提交**，单提交可 revert；entry 只增不改、删除无损。

裁决 1 唤醒面（2026-10-12 追加）= 收敛模块内的唤醒判据 + 一个新 core 公开窄方法 + 协议
`backgroundSource: "subagent_lost"` 闭集加值 + 账本重开语义 + metadata 加 pid 字段。回滚 = revert
该批提交；残留物都是附加事实（账本行 / 已发消息 / entry 字段），不影响旧读面：旧代码不认
`"subagent_lost"` 的 origin 值（白名单外，渲染退回普通分支），也不读 metadata 的新字段。
`session_input` 的重开语义回滚后，`discarded` 行恢复为不可重开（此前无路径依赖它）。

## 6. P1-1 边界核实：J4 信号的真实覆盖面与例外（debugger 取证，2026-10-08）

**问题**：§1.2 的 J4 用 `context.sessions` 当「本进程认领」信号，但生产拓扑里 subagent child 是父
runtime 内联创建的 `new AgentRuntime(...)`（`core/src/runtime/methods/subagent.ts`），**没有 host
record**——`context.sessions.set` 只发生在 create/resume/fork 的 host 会话上。⇒ J4 对子 agent 恒
false，旧 J4 用例绿是因为 fake 手工把 child 放进了 `context.sessions`。

**核实结论**：父会话被去激活时，仍在跑的后台子 agent **不会被连带终止**；但主路径上
「父被去激活 ∧ child 还活着」也不可达，两道防线都不是 J4：

| 触发               | 父是否真被去激活                                                | child 是否被终止 | 误杀窗口 |
| ------------------ | --------------------------------------------------------------- | ---------------- | -------- |
| 切走会话           | 否（退订≠去激活；且后台 child 会让 `isEligible` 拒绝该会话）    | 否               | 不可达   |
| 容量/idle 回收     | 否（`hasResidencyBlockingWork` 为真 ⇒ idle TTL 与高水位都跳过） | 否               | 不可达   |
| host 卸载/进程退出 | 是（进程消失）                                                  | 是（随进程）     | 不可达   |
| 显式会话关闭       | 是（绕过常驻池闸门摘 record，但不碰 child）                     | **否**           | **存在** |

- 防线 1（常驻钉住）：后台 child 在父 runtime 的 task registry 里是 `isBackgrounded ∧ running`
  ⇒ `hasRunningBackgroundTasks()` / `hasResidencyBlockingWork()` 为真 ⇒ 常驻池两条回收路径都跳过
  （`session-resident-pool.ts` 的 `isEligible` + 执行前 fresh facts 二次校验）。
- 防线 2（无连带终止入口）：后台 launch 不订阅父 turn 的 signal（`runner.ts` 的 `start()` 只在启动
  瞬间读一次 `aborted`），`SubagentPort` 没有 stopAll/close，唯一停止入口 `stopTask` 只被用户
  Stop / TaskStop / rewind 调用；会话关闭链（`beginShutdown` / `drainMemoryExtractions` /
  `closeBrowserSession` / executionPort / MCP / session store）够不到它。
- **例外（已确认可达）**：`deleteSession`（v4 命令）与 `session/close` 摘掉父 record 前不检查常驻
  事实，也不停本会话的后台 child ⇒ child 继续在本进程跑，而 J4 与网关的 detached-child 跟踪都不在场
  （后者随父 record 的 `cleanupSessionRuntime` 一并释放）。此时若父会话在同一进程内被重新激活
  （被关闭的会话仍在 store 里——`deleteSession` 只退订 + 关 runtime，不清 message 库；sessions-index
  的冷启动种子直接来自 store，故重载/新端接入会把它带回列表）且 child 静默已过宽容期，child 会被
  暂时标成 `lost`；真实终局到场后自愈（读面「真实 outcome > entry」），期间面板卡片与 Stop 入口
  消失。可达性前提：须有客户端对「正在跑后台 agent 的会话」下发这两个命令之一——本仓 UI 现有
  `deleteSession` 派发点只有 draft/预热的空会话清理（`useDraftSessionPrewarm`、saved workflow
  launcher），未发现桌面端对主会话的一等处；命令本身属 v4 协议面，任一客户端可下发。

**回归锁**：`core/test/backgroundSubagentParentLifetime.test.ts`（真实 runtime + 真实 port：常驻钉住、
父侧 teardown 不终止 child、唯一终止入口是 `stopTask`）与
`bootstrap/test/session-resident-pool-background-pin.test.ts`（闸门语义 + 反面对照）。

**未决修法（不在本次范围，需架构决策）**：① 新建进程级认领信号（runner 维护「本进程在跑的 child
session」索引，J4 并查它）；② 会话关闭时收走本会话的后台 agent（与同链已有的后台 bash、dwf run
关闭对齐，让 child 落一个真实终态而非事后被推断为 lost）。两者都引入新的状态所有者或改变产品语义，
按「发现设计缺陷先对齐」的约定留待决策，本分支不自行扩判据。

## 7. 三面同源与收敛行的呈现（分支复核加固，2026-10-08）

§1.5 只写了 `readSessionSubagentInventory` 一个读面，实现里却有多条取数路径共用
`projectSessionSubagents`：V4 侧栏 / hydration 的权威清单，以及 TUI 观察面
（`bootstrap/src/app/subagent-observation.ts` 的 `readSubagents`，终端子智能体目录的取数口）。
**同一份持久记录必须由同一解释器读**——任一面自己判一次活、判一次终态，同一个孤儿就会在终端
显示 running、在 V4 显示 lost（终端还会留一张永不消失的卡片）。

### 7.1 TUI 观察面消费同一份 entry 事实

- `createSubagentObservation` 与权威清单一样，按 child 读 `subagent_outcome` entry，作为
  `subagentOutcomeEntryById` 传给同一次 `projectSessionSubagents`：running 集合与 ended 终态在
  V4 清单 / hydration / TUI 目录三面逐字段同结论。
- 用例：`bootstrap/test/coldHydrationSubagentStatus.test.ts`
  「集成：同一孤儿收敛后 V4 侧栏清单 / hydration / TUI 观察三面同一终态」。

### 7.2 收敛行的时间与 `reconciled` 标记：只在 entry 决定终态时成立

`entry.data.reconciledAt` 是读面事实（与 `time.created` 同值）。**当且仅当该行的终态取自 entry**
（child 无真实 outcome ∧ `endedStatus` 的结论 === entry 的终态）时，`endedAt` 取收敛时刻，并带
`reconciled: true`；否则两者都退回既有时间链、不带标记。

- 时间：spawn part 的 `end` 是 launch ACK（启动那一刻），拿它排序会让「跑了很久才被收敛」的孤儿
  带着很早的时间沉到分页底部（用户翻不到）⇒ 收敛行的排序时间必须是收敛时刻。
- 标记：更硬的终局事实（background 终态 / child projection / part error / stop 事件 / 真实 outcome）
  赢过 entry 时，终态不是收敛来的——标记与成因文案必须跟着**真正决定终态的那条证据**走，
  否则会给出「已取消」+「运行时已退出，结果未知」这种自相矛盾的呈现，并按收敛时刻错误排序。
- 用例（`bootstrap/test/subagent-orphan-reconcile.test.ts`）：「收敛行的 endedAt 取
  entry.data.reconciledAt」「因收敛落 lost 的行带 reconciled 标记」「更晚的 stop 事实赢过收敛
  entry」「长期孤儿按收敛时刻排序」。

### 7.3 呈现决定：`subagentDirectory.summary.reconciled` 接线（不删键）

该文案键原先只写不用（死键）：收敛落 lost 的行只显示「已丢失」，说了状态没说成因。决定**接线**：

- 读面给收敛行带 `reconciled: true`（`packages/shared` 的 `zcodeSessionEndedSubagentSchema` 增
  可选字段），UI 纯函数 `ui/src/lib/subagentDirectoryRow.ts` 据此给副文案：child 自己的 `summary`
  优先（它是证据），无 summary 且 `reconciled` 才补成因；组件只渲染纯函数的结果。
- 代价（已接受）：`.strict()` 闭集加字段属于偏斜加值——旧桌面收到未知字段会整帧解析失败，依赖
  CLI 与桌面同批发布（同类代价先例：`backgroundWorkSummarySchema.kind` 的闭集枚举加值）。
- 用例：`ui/test/subagentDirectoryReconciledSummary.test.ts`（判据、优先级、接线守卫、两语文案在场）。
