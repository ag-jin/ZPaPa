# spec：后台子 agent 重启后孤儿收敛（subagent orphan reconcile）

> 设计依据：[`docs/plans/subagent-orphan-reconcile-design.md`](../../plans/subagent-orphan-reconcile-design.md)
> （architecture-planner 产出，本文件的唯一上游）。基线：`48f7f18`（冷恢复按 child session 真实终态裁决）。
> 问题编号 P2-1。本文是该行为的**验收边界**：实现与评审都以下列条文为准，术语与设计文档一致。

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

- 写 child session 的持久 session entry：
  `type: "subagent_outcome"`、`id: "subagent-outcome:<childSessionId>"`（确定性幂等键）、
  `data: { status: "lost", reason: "runtime_exit", parentSessionId, reconciledAt, runtimeInstance: <pid> }`、
  `time: { created, updated } = reconciledAt`、`touchSession: false`（收敛不是任务活动，不改 child 的活动时间）。
- **不合成任何父会话事件**（不写 `SubagentStopped`）：事件日志的契约是「引擎发过什么」，
  收敛者只补齐 child 持久事实；展示层终态由 hydration 按终态事实自然合成（`lost → failed` 行）。
- 终态选 `lost`（侧栏词表已有「已丢失」/「Lost」），row 层按 `48f7f18` 定案收口成 `failed`，
  **不新造终态词**、不新造 UI 文案。

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

## 2. 状态所有者

| 状态             | 所有者                                         | 说明                                              |
| ---------------- | ---------------------------------------------- | ------------------------------------------------- |
| child 终态       | child session 持久记录（store）                | `48f7f18` 已确立的唯一持久权威                    |
| 孤儿收敛事实     | reconcile entry（child 的 `subagent_outcome`） | 只填洞不覆盖：真实 outcome 优先                   |
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
      └─ hydratePublisher → readSessionSubagentInventory（同一次读看到 entry）
             ⇒ running=[] / ended 含 lost ⇒ row failed + 侧栏「已丢失」+ 常驻卡片消失
T3  之后任意 reload / 双端打开：entry 已持久 ⇒ 同一终态，无需重判（幂等）
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

| 档  | child 事实 | 终态证据                      | 运行时切片      | row             | 侧栏     |
| --- | ---------- | ----------------------------- | --------------- | --------------- | -------- |
| 2   | known      | 无                            | 接管 ∧ 宽容期内 | running（跳过） | 运行中   |
| 3   | known      | 无                            | 接管 ∧ 过宽容期 | failed          | 已丢失   |
| 8   | known      | entry ∧ 真实 outcome 后来到场 | 任意            | 真实 outcome 赢 | 真实终态 |

真机 E2E（留给真机执行，见交接）：① 杀进程重启后打开会话：卡片消失、侧栏「已丢失」、row failed、
无 Stop 残留；② 同会话反复 reload / 切走切回状态稳定；③ 双端看到同一终态；④ 不杀进程的切走切回
仍 running（`48f7f18` 主语义不回归）；⑤ SendMessage 到已收敛 agent 仍是既有
`No active local_agent task found` 失败。

## 5. 回滚边界

整个机制 = 一个新文件 + `server-operations.ts` 一行挂点 + 读面一处消费（entry 读取与
`runningStatus`/`endedStatus` 消费）。挂点与读面消费**同一提交**，单提交可 revert；
revert 后回到 `48f7f18` 行为，entry 只增不改、删除无损。

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
