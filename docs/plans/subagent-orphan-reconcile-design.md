# 设计：后台子 agent 重启后孤儿收敛（subagent orphan reconcile）

- 分支：`fix-background-work-stale-status`（基线 48f7f18，冷恢复按 child session 真实终态裁决）
- 日期：2026-10-08
- 状态：待评审（architecture-planner 产出，供 task-planner 拆解）
- 问题编号：P2-1（用户已拍板要修）

---

## 1. 问题陈述

48f7f18 之后，冷恢复对后台 Agent 的裁决规则是：

> 已知 child（`taskType === "subagent_child"` 的持久记录在场）∧ 无终态记录 ⇒ **running**。

这个规则保护了「切走再切回时仍在跑的 agent 不被误收口」，但也留下一个无界漏洞：若子 agent 的宿主进程被硬杀/崩溃、child session 没留下任何终态落盘（没有最终 assistant outcome、没有 stop 关系），重启后该 agent **长期显示 running**——面板出现一张无 Stop 入口的常驻卡片，永不自愈。

需要一个**有界的孤儿收敛机制**：在可证明「没有任何运行时还认领它」的时刻，把这类 child 收敛到明确终态。

### 目标

1. 重启/接管会话后，真孤儿（进程已死、无终态落盘的后台 child）收敛到明确终态，常驻 running 卡片消失。
2. 收敛结果**幂等且持久**：后续 reload / 再切回 / 双端打开自然看到同一终态，不需要每次重新判定。
3. 绝不误杀：本 runtime 正在跑、SendMessage resume 后仍在跑、（契约外的）双进程场景中另一进程仍在跑的 agent，一律保持 running。
4. 风格与仓内先例 `dynamic-workflow-run-reconcile.ts` 对齐（接管时收敛、本会话 scoped、失败降级不拖垮主流程、终态语义可分辨）。

### 非目标

- 不做跨进程的会话租约/认领协议（那是 ADR0003 单运行时契约层面的课题）。
- 不恢复「重启后继续跑孤儿 agent」的执行能力（孤儿收敛只裁决状态，不复活进程）。
- 不改前台（阻塞式）Agent 的冷恢复语义。
- 不引入常驻周期性看门狗（v1 不做，见 §4.1 论证）。

---

## 2. 证据基础

以下事实均已在本工作树源码核实（标注文件:行号）。分类：**[C]** 已确认、**[I]** 推断、**[A]** 假设。

### 2.1 已确认事实

| #   | 事实                                                                                                                                                                                                                                                                                                                                            | 证据                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | 冷恢复终态判据：`HydratedSubagentChildFacts = { knownChildSessionIds, terminalStates }`；后台 part 在「child 已知 ∧ 无终态」时**只建 running 行**；`lost` 在 row 层映射为 `failed`                                                                                                                                                              | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts:109-141`、`:606-622`（`subagentLifecycleResolution`）、`:591-598`（`subagentStopStatusWord`）                                                                 |
| C2  | hydrate 用 `readSessionSubagentInventory` **同一次读**喂 hydration 判据与 `subagentsSeed`；读取在 raw-event buffer 补回之前                                                                                                                                                                                                                     | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4/v4-bridge.ts:1851-1913`                                                                                                                                                               |
| C3  | 权威清单的活/死判定：live child/parent projection 只查**本进程** `context.sessions`；侧栏 running 判定有后台兜底——`runInBackground ∧ background===undefined ∧ childProjection===undefined ∧ stoppedStatus===undefined ∧ childOutcome.status===undefined ⇒ running`（**孤儿显示 running 的根源**）；ended 兜底是 `childOutcome.status ?? "lost"` | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:1693-1776`（`readSessionSubagentInventory`）、`subagent-session-query.ts:292-332`（`runningStatus`）、`:353-373`（`endedStatus`）、`:242-277`（`lastChildOutcome`） |
| C4  | runtime task registry 纯内存：`deps.runtimeTaskRegistry ?? new InMemoryRuntimeTaskRegistry()`；**没有任何持久回灌路径**。runner 的 `metadata.json` 只写不读（唯一写方在 runner）                                                                                                                                                                | `apps/zcode-cli/packages/core/src/runtime/agent-runtime.ts:284`、`core/src/subagent/runner.ts:132`、`:1989`（`writeAgentMetadataFile`）、`:1952`（`writeStoppedAgentArtifacts`）                                                               |
| C5  | SendMessage 是 registry 绑定的：`registry.get(to)` 失败即报 `No active local_agent task found`；「resume 重臂」（`resumeTerminalAgentInBackground`）只对 **registry 里仍在的 terminal 条目**生效，重臂后 agent 在**本进程**续跑并继续写同一 child session                                                                                       | `core/src/subagent/runner.ts:900-934`、`:955-1062`                                                                                                                                                                                             |
| C6  | 仓内先例：dynamic workflow 的孤儿 run 收敛——**构造时**收敛（该时刻本服务名下零个在飞 run，故 journal 里本会话的非终态行只可能是死进程遗物，二次构造天然幂等）；**只收敛本会话**；**不合成 dwf_event**（状态权威在 run 行上）；终态 `stopped + stopReason=interrupted + 专属 failure code`（非 DriverError、非 cancelled）；失败 warn 不拖垮构造 | `apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-reconcile.ts:60-108`                                                                                                                                                           |
| C7  | `branchGeneration`（runtime-command-generation）是 rewind 分支的**进程内**代际，用于命令入队/事件发布前丢弃陈旧分支，重启即丢——**不能直接作跨重启的孤儿判据**。持久可见的「新 runtime 边界」是 core resume 发出的 `SessionResumed` 事件（进 eventStore）                                                                                        | `core/src/runtime/methods/runtime-command-generation.ts:6-66`、`core/src/runtime/methods/resume.ts:239-253`                                                                                                                                    |
| C8  | 会话状态是**进程内内存态**（`context.sessions` 每进程 Map）；ADR0003 已把设备侧收敛为单一运行时（窗口 host 兼常驻主机），dual-host 分叉是被消除的形态；远端双端共享同一常驻 runtime                                                                                                                                                             | `docs/adr/0003-single-runtime-window-host-as-resident.md`                                                                                                                                                                                      |
| C9  | **冷打开 = 接管**：v4 冷订阅走 `ensureColdReadyPublisher` → `coldResume.ensureResumed`（按会话单飞）→ `activateSessionForResume`（已激活则 `existing` 早退）→ `context.sessions.set` + `app.resume()`。即桌面/web 打开会话即在本 runtime 激活；重复订阅不会再 activation                                                                        | `bootstrap/src/zcode-protocol-v4/v4-gateway.ts:2899-2922`、`cold-session-resume.ts:43-66`、`server-operations.ts:1413-1433`                                                                                                                    |
| C10 | 面板：running 行 → 卡片（`conversationStatusPanelModel.ts:429-458`）；侧栏 `SubagentDirectorySidePane` 直接按 `subagentDirectory.status.${status}` 渲染，`lost` 键已存在（zh-CN「已丢失」/ en-US「Lost」），**零 UI 改动即可呈现 lost**                                                                                                         | `packages/ui/src/app-shell/SubagentDirectorySidePane.tsx:89`、`packages/ui/src/i18n/locales/zh-CN.ts:903-909`                                                                                                                                  |
| C11 | session entry 机制已有「写入 → 冷恢复读回」的完整先例（goal verification 经 `store.sessionEntries` 读回 hydration）                                                                                                                                                                                                                             | `transcript-hydration.ts:1067-1128`、`core/src/runtime/methods/events.ts:263-289`                                                                                                                                                              |
| C12 | 现有测试基线：`coldHydrationSubagentStatus.test.ts` 11 例，node:test + 直接构造 facts 走 `mergeColdConversationEvents → ProductProjection hydration 回放` 三段管线                                                                                                                                                                              | `apps/zcode-cli/packages/bootstrap/test/coldHydrationSubagentStatus.test.ts`                                                                                                                                                                   |

### 2.2 推断

| #   | 推断                                                                                                                                                                                                                                                             | 依据        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| I1  | 孤儿（宿主进程死亡、无终态落盘）**永远不会被任何活运行时认领**：唯一的「认领」机制是 spawn/resume 时 register 进本进程 registry（C4、C5），进程死后不存在；跨进程也没有可查的活清单（无会话租约；`resident-host.json` 是设备级 host 发现文件，非 per-session）。 | C4、C5、C8  |
| I2  | 收敛事实写入 **child session 的持久记录**后，同一次 `readSessionSubagentInventory` 即可让侧栏（ended=lost）与 v4 hydration（terminalStates=lost → row failed）同时正确——48f7f18 的「同源单一结论」原则继续成立，不需要第二个权威。                               | C2、C3、C10 |
| I3  | 接管时收敛的覆盖面 = 所有经桌面/web/CLI 打开的会话（冷打开即激活，C9）；浏览器回放桶无 session store，本来就退 part 推断（有界），不需要收敛。                                                                                                                   | C9、C1      |

### 2.3 假设

| #   | 假设                                                                                                              | 风险与核对点                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| A1  | `saveSessionEntry` 支持同 id 覆盖（upsert），且可对 `subagent_child` 会话写入                                     | 实现时核对 `sessionStore.saveSessionEntry` 语义；若不成立，备选落点见 §5.3 |
| A2  | 「会话单属主」契约对 subagent child 同样成立（与 dwf 先例同款前提）；双进程同会话属架构违例，用宽容期缓解而非根治 | 与 C6、C8 一致；残差风险见 §9                                              |

---

## 3. 设计总览

### 3.1 模块与 seam

新模块一个：**SubagentOrphanReconciler**（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/subagent-orphan-reconcile.ts`，与 `subagent-session-query.ts` 同目录、同拆分风格——对齐 dwf 把收敛拆出独立文件的先例）。

```
调用方（唯一）                模块（深模块：小接口，大实现）                    适配器
──────────────              ─────────────────────────────────              ──────
activateSessionForResume ──▶ reconcileSubagentOrphansOnActivation(input)
  （server-operations.ts       │  判据（复用 readSessionSubagentInventory
   激活成功、app.resume()       │   的同一次读：known / running / ended / live）
   完成之后，一行调用）         │  宽容期（child 最后落库活动距今）
                              │  写入（child session entry，幂等键固定）
                              ▼
                          child session 持久层（sessionStore.saveSessionEntry）
                              │
                              ▼
             读面（既有，不改权威链）：
             readSessionSubagentInventory → 侧栏 ended=lost / v4 hydration
                                           terminalStates=lost → row failed
```

- **Interface**：`reconcileSubagentOrphansOnActivation(input): Promise<SubagentOrphanReconcileResult>`。输入只有 `context`（窄面 deps）、`sessionId`、可选 `now`（测试注入时钟）。输出 `{ reconciled: number; skipped: Array<{ childSessionId: string; reason: string }> }`——供结构化日志与单测断言。
- **Seam**：外部 seam 在激活边界（`activateSessionForResume` 尾部）；测试 seam 就是本函数本身——用内存 fake store adapter 即可测全部判据分支，不需要起真 runtime。
- **Depth / leverage**：调用方一行、判据/宽容期/降级/写入全部藏在模块内；侧栏、hydration、面板三个消费方零改动拿到同一结论。
- **Deletion test**：删掉该模块，孤儿判定逻辑必然散落到 hydration、v4-bridge、RPC 三处（且互相不一致）——模块在挣钱，不是 pass-through。

### 3.2 状态所有者与事件顺序（规范要求的状态/时序图）

```
状态所有者：
  child session 持久记录（store）     ← 终态的唯一持久权威（48f7f18 已确立）
  reconcile entry（child 的 session entry） ← 本设计新增的「终态补洞」事实，只填洞不覆盖
  本进程 context.sessions / registry  ← 活性（claim）唯一判据，进程私有
  ProductProjection / 面板 / 侧栏     ← 纯投影，无独立状态

事件顺序（孤儿收敛的完整时序）：

  T0  runtime A：spawn 后台 agent → registry.register(agentId)
      child session 开始落库（transcript 持续写）
  T1  runtime A 进程被硬杀 —— 没有终态落盘，registry 随进程消失
  T2  runtime B：用户打开会话
      ├─ ensureColdReadyPublisher → ensureResumed（会话单飞）
      ├─ activateSessionForResume：record 入册 + app.resume()      ← 此刻 B 名下
      │   该会话在飞 agent 数 = 0（dwf「构造时」论证的等价时刻）        零个在飞
      ├─ ★ reconcileSubagentOrphansOnActivation                     ← 新增挂点
      │     读 inventory（known ∧ running ∧ ended ∧ live）
      │     running 中满足孤儿判据者 → 写 child entry{status:lost}
      │     （失败 warn，绝不拖垮激活）
      └─ hydratePublisher → readSessionSubagentInventory
            同一次读看到 entry ⇒ running=[] / ended 含 lost
            ⇒ row failed + 侧栏「已丢失」+ 无 Stop 入口的常驻卡片消失
  T3  之后任意次 reload / 双端打开：entry 已持久 ⇒ 同一终态，无需重判（幂等）
```

挂点放在 `ensureResumed` **内部**（activation 尾部）而不是 hydration 里，保证 T2 的 hydrate 读 inventory 时 entry 已在——首次打开即正确，不存在「第一次 running、第二次才收敛」的闪烁。

---

## 4. 设计点逐项结论

### 4.1 触发时机 —— 接管时收敛（activation-time），不做常驻看门狗

**结论**：挂在 `activateSessionForResume` 成功路径尾部（`app.resume()` 之后、返回之前）。不做切会话触发、不做周期性看门狗。

论证：

1. **为什么是接管时**：这是唯一一个「本 runtime 对该会话名下零个在飞 agent」的可证明时刻（C4：registry 进程私有且新建为空；C5：跨进程 resume 本来就不存在）。此刻该会话 running 集合里的任何 child，要么是孤儿，要么被宽容期排除（§4.2）。这与 dwf 先例「构造时收敛」同构（C6），幂等也同源：已激活会话的重复订阅走 `existing` 早退（C9），不会重复收敛。
2. **为什么不是冷 hydration 里**：`hydratePublisher` 存在**不带 activation 的重建路径**（forceRebuild、已激活会话的投影重建）。在 hydration 里收敛会让「纯投影重建」产生持久写副作用，且无法区分「我拥有这个会话」与「我只是 viewer」。
3. **为什么不是切会话**：切会话 = 已激活会话的重复订阅（C9 早退），此刻本 runtime 可能正在跑 agent（registry 非空），没有「零在飞」的前提，判据不成立。
4. **为什么不做看门狗**：孤儿是**一次性的历史遗留**（进程死亡瞬间的固定集合），不是持续产生的病态。接管时收敛 + 持久落盘后，同一孤儿不会再出现；看门狗只能处理「本 runtime 存活期间产生的异常」，而那属于进程内 registry 的既有职责。引入常驻 pass 反而新增误杀窗口（与活 registry 竞态）。若未来出现「不重启也会泄漏 running」的新病态，再按 dwf 形态加 pass，不在本期。

### 4.2 孤儿判据 —— 「接管时刻零认领 ∧ 无终态 ∧ 后台 ∧ 过宽容期」

**结论**：一个 child 被收敛为孤儿，当且仅当以下条件**全部**成立：

```
J1 后台启动     candidate.runInBackground === true
                （前台 Agent 的 part 终态即 child 终态，不可能停留 running，不参与）
J2 已知 child   ∈ readSessionSubagentInventory().childSessionIds
                （父 transcript 有 spawn 候选 ∧ store 里 child 记录在场 ∧ taskType=subagent_child；
                 复用 collectCandidates/activeBranchMessages，rewind 掉的分支自然不进集合）
J3 无终态       不在 ended 集合（childOutcome.status 缺席、无 stop 关系、part 无 error、
                无 background task 终态）——即它当前落在 running 集合里
J4 本进程不认领  本 runtime 刚激活该会话，registry/父投影对该会话零在飞（挂点保证）；
                child 也无本进程 live projection
J5 过宽容期     child 的最后持久活动（childSession.time.updated 与 child transcript
                最后消息时间的较大者）距今 > SUBAGENT_ORPHAN_GRACE_MS
```

> **P1-1 核实（2026-10-08，debugger）**：J4 里「child 也无本进程 live projection」这一句不成立于生产
> 拓扑——subagent child 由父 runtime 内联创建、没有 host record，`context.sessions` 里查不到它，J4
> 对子 agent 恒 false。主路径的安全来自「挂点位置（激活尾部零在飞）+ 后台 child 钉住常驻池（不满足
> `isEligible` ⇒ 父不会被容量去激活）+ 无连带终止入口 + J5」，唯一例外是显式会话关闭。取证与回归锁
> 见 spec `docs/superpowers/specs/2026-10-08-subagent-orphan-reconcile.md` §6。

**推荐宽容期常量**：`SUBAGENT_ORPHAN_GRACE_MS = 10 分钟`（命名常量，一处定义）。权衡：

- 子 agent 有模型流空闲看门狗（`createSubagentActivityWatchdog`，`runner.ts:208-219`），但长工具执行期间可能不写 transcript，10 分钟远大于常见工具时长，能覆盖「另一进程还在跑但暂时安静」的绝大多数情形；
- 孤儿最长多显示 10 分钟 running（有界、可接受），换取对双进程违例的防御。

对任务书各候选判据的核对结论：

- **「child transcript 无终态」**：即 J3，保留（C3 的 `lastChildOutcome` 语义）。
- **「spawn 的 runtime 世代已死」**：`branchGeneration` 不可用（C7，进程内 rewind 代际）；`SessionResumed` 虽是持久的新 runtime 边界，但**不需要**——「接管时刻本 runtime 零在飞」+ J4 已蕴含「spawn 它的 runtime 若还活着也不在本进程」，跨进程情形由 J5 + 单属主契约覆盖（A2）。不引入新世代标记，机制保持最小。
- **「desktop/host 架构里有没有跨进程可查的活子 agent 清单」**：**没有**（I1）。`context.sessions` 进程私有；无会话租约；`resident-host.json` 是设备级发现文件。因此判据只能落在「本进程不认领 + 宽容期 + 单属主契约」三者合取上，这正是 dwf 先例的边界处理方式（C6 同样只做本会话 scoped）。
- **远端双端场景是否安全**：安全。ADR0003 下双端共享同一常驻 runtime（C8）：host 没重启则会话已在 `context.sessions`，activation 早退不触发收敛；host 重启了则旧 agent 确实死了，收敛正确。
- **SendMessage resume 的重臂如何排除误杀**：现状「认领」= registry 进程内条目（C5）。重臂后的 agent 与收敛判据互斥有三道：
  1. 重臂发生在**已激活**会话上，activation 早退，reconcile 根本不跑；
  2. 重臂后 agent 持续写 child transcript，J5 宽容期将其排除；
  3. 若重臂后宿主进程再次崩溃，child 重新变成无终态孤儿——**下次接管收敛它是正确行为**。
     「现状认领机制是什么，若没有要补什么」：现状即 registry 进程内认领，没有跨进程认领；本设计**不补**跨进程认领（非目标），因为跨进程 resume 在现状就不存在（C5：`registry.get` 直接失败）。

### 4.3 收敛动作 —— 落盘 child session entry，终态 `lost`，不合成父事件

**结论：落盘（推荐）**，写入 child session 的 session entry：

```
type: "subagent_outcome"          （新 entry 类型，常量命名，对齐 SESSION_ENTRY_* 惯例）
id:   `subagent-outcome:${childSessionId}`     ← 幂等键（确定性，重放同 key 覆盖）
data: {
  status: "lost",
  reason: "runtime_exit",          ← 与用户取消/模型侧停止可分辨（对齐 dwf 的 stopReason=interrupted 思路）
  parentSessionId,
  reconciledAt: <ISO>,
  runtimeInstance: <本 runtime 可标识信息>       ← 审计用
}
time: { created: reconciledAt, updated: reconciledAt }
```

- **谁写**：`reconcileSubagentOrphansOnActivation`（唯一写方；单一写入路径，符合仓库「避免多条写入路径」规范）。
- **写什么事件**：**不合成任何父会话事件**（不写 `SubagentStopped` 进父事件日志）。对齐 dwf 先例「不合成 dwf_event——状态权威在 run 行上」（C6）：事件日志的契约是「引擎发过什么」，收敛者的职责是补齐 child 持久事实。展示层的 `SubagentStopped` 由 hydration 在视图重建时按终态事实自然合成（C1 既有机制，`lost → failed`）。
- **幂等键**：`subagent-outcome:${childSessionId}`——同一 child 只会有一个 outcome entry；重复收敛（理论上不会，因 activation 单飞 + 早退）也是同 key 覆盖，无累积。

**为什么落盘优于「hydration facts 临时合成」**：

1. **幂等与免重判**：落盘后，后续 reload、再切回、双端打开、`listSessionSubagents` RPC 全部自然读到终态，不需要每个读路径都携带孤儿判据（判据含宽容期时钟，每次重判结果还可能随时间漂移）。
2. **同源原则**：48f7f18 确立「终态唯一事实是 child session 的持久记录」（C1/C2 注释原文）。孤儿收敛若只活在 hydration facts 里，就会造出「侧栏说 lost、行说 running」的第二结论源——正是该修复消灭的裂缝形态。
3. **有界性**：不落盘则每次冷打开都重新面对同一个无界 running；落盘则一次收敛永久闭环。

**读取端接线（唯一的读面改动，收敛在 inventory 一处）**：

- `readSessionSubagentInventory` 读取 child 时顺带读该 child 的 `subagent_outcome` entry（与 `store.getSession`/`store.messages` 同一批子查询）；
- `projectSessionSubagents` 的判定链中，entry 作为**最低优先级**证据：
  - `runningStatus` 的后台兜底分支（C3 `:309-317`）增加条件「无 reconcile entry」——entry 在场即不再「凭空宣称存活」；
  - `endedStatus` 的兜底顺序变为 `childOutcome.status ?? entry?.status ?? "lost"`——entry 只在真实 outcome 缺席时填洞。
- v4 hydrate 侧**零改动**：entry 经 `ended` 集合自然进入 `terminalStates`（`{status:"lost"}`），hydration 已会把 lost 映射为 `SubagentStopped(failed)` 行（C1）。

**终态选 `lost` 而非 `failed` 的理由**：侧栏词表已有 lost（C10，「已丢失」，与 success/failed/cancelled 语义可分辨——「不在运行但无 outcome」正是它的定义，见 `endedStatus` 现有兜底 `?? "lost"`）；row 词表无 lost、按 failed 收口是 48f7f18 已定案的行为（C1）。**不新造终态词**。

### 4.4 不误杀不变量清单

| #   | 绝不能收敛的场合                                           | 判据如何排除                                                                                                                                                           |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | 本 runtime 正在跑该 agent                                  | 挂点在 activation 尾部：此刻本 runtime 对该会话零在飞（§4.1）；已激活会话的后续 spawn/resume 不会再触发 reconcile（C9 早退）                                           |
| N2  | SendMessage resume 后 agent 在本 runtime 续跑              | 三道互斥（§4.2）：会话已激活不触发；重臂持续写 child transcript 被 J5 排除；重臂产生的新活动让 child 不满足 J3                                                         |
| N3  | 远端另一端经共享 host 观看/操控同一会话                    | ADR0003 单运行时：所有端共享同一 host 进程，不存在「另一端的独立 runtime」（C8）；host 未重启则会话已激活、早退                                                        |
| N4  | 双进程违例（CLI + 桌面同会话，契约外）中另一进程在跑       | J5 宽容期（10 分钟）：活 agent 的 child transcript 有近期写入则跳过；残差见 §9-R1                                                                                      |
| N5  | rewind 分支上的陈旧 spawn 但分支仍被引用                   | J2 复用 `activeBranchMessages`/`collectCandidates`：只看当前分支的 spawn 候选；且收敛写的是 child 持久事实（分支无关），rewind 掉的 child 不被引用也不显示，entry 无害 |
| N6  | child 有任何真实终态（outcome/stop/error/background 终态） | J3：只处理落在 running 集合里的 child；ended 集合成员不碰                                                                                                              |
| N7  | 前台（阻塞式）Agent                                        | J1：`runInBackground === true` 才参与；前台 part 终态即证据（C12 用例已锁定该行为不回归）                                                                              |
| N8  | 调用方读不到 child 记录（浏览器回放桶）                    | J2：unknown child 不进收敛集合，保持 48f7f18 的 part 推断降级（C1「有界」注释）                                                                                        |
| N9  | child session entry 读取/写入失败                          | 收敛是自愈动作：warn + 跳过，绝不拖垮激活（对齐 dwf 边界 3，C6）；后果只是该孤儿暂不收敛（下次接管重试）                                                               |

### 4.5 与 48f7f18 降级矩阵的关系

现有矩阵（`coldHydrationSubagentStatus.test.ts`）按「child 事实 × 终态」分档：

```
维度一（child 持久事实）          维度二（终态证据）                → row 结果
known ∧ 无终态                    —                                → running      ← 孤儿藏身处
known ∧ terminal=success/failed/cancelled/lost                     → 对应收口
unknown（被裁剪/从未落库）         part 推断                          → 有界收口
facts 缺席（回放桶）              part 推断                          → 有界收口
```

新机制在「known ∧ 无终态」这一格上引入**第三个维度：运行时所有权 × 时间**：

```
known ∧ 无终态 ∧ {接管时刻，本 runtime 零在飞} ∧ 过宽容期   → 收敛写 entry{lost} → 终态档
known ∧ 无终态 ∧ {接管时刻} ∧ 宽容期内（child 有近期活动）  → 保持 running（防御 N4）
known ∧ 无终态 ∧ {会话已激活（含本 runtime 正在跑）}        → 保持 running（现状不变）
known ∧ 无终态 ∧ {本进程 child live}                        → 保持 running（现状不变）
```

关键性质：**矩阵的既有 8 档行为一档都不变**——新维度只在「接管时刻」这一个切片上把 running 改写为持久 lost；hydration 消费侧（facts → row）的映射完全复用。`coldHydrationSubagentStatus.test.ts` 需补的用例见 §4.7 与 §6。

### 4.6 UI 呈现

收敛后各面的显示（全部复用既有词表，**除一个可选 summary 键外零新增 i18n**）：

| 面                                | 显示                                                                                                                                                            | i18n 键                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 会话行（row）                     | `failed`（lost 在 row 层按 48f7f18 定案映射）                                                                                                                   | 既有 failed 词表（row 原生）                                         |
| 侧栏（SubagentDirectorySidePane） | 「已丢失」/「Lost」                                                                                                                                             | `subagentDirectory.status.lost`（zh-CN:909 / en-US:992，**已存在**） |
| 面板卡片                          | running 卡片**消失**（running 集合为空）；不产生新卡片                                                                                                          | —                                                                    |
| 无 Stop 入口问题                  | **随收敛自然消失**：Stop 入口只挂在 running 行/work 上（conversationStatusPanelModel.ts:415-427 只收 `status === "running"`），row 变 failed 后控制面自然不生成 | —                                                                    |
| （可选增强）ended 条目摘要        | 「运行时已退出，结果未知」                                                                                                                                      | 新键 `subagentDirectory.summary.reconciled`（zh/en 各一条，可延后）  |

呈现层的杠杆来自 §3.1 的读面收敛：面板/侧栏/行三个消费方不改代码就拿到 lost。

### 4.7 测试计划

**单测（bootstrap 层，node:test + 内存 fake，对齐仓库惯例 C12）：**

`subagent-orphan-reconcile.test.ts`（新文件，测模块接口 seam）：

1. known ∧ 无终态 ∧ 无近期活动 ⇒ 写 entry{status:lost, reason:runtime_exit}，幂等键正确；
2. 宽容期内（child transcript/`time.updated` 新于 grace）⇒ 不写，skip reason 可断言；
3. child 有真实 outcome ⇒ 不写（非孤儿）；
4. child 在本进程 live（fake `context.sessions` 有 child）⇒ 不写；
5. entry 已存在 ⇒ 幂等跳过（不重复写、不改写真实 outcome）；
6. `saveSessionEntry` 抛错 ⇒ warn 不抛出，返回结果标记失败；
7. 前台 agent（`runInBackground !== true`）⇒ 不参与；
8. unknown child ⇒ 不参与；
9. 多 child 混合场景：一个 ended、一个活、一个孤儿 ⇒ 只收敛孤儿一个。

`subagent-session-query` / inventory 层（扩展或新建）：

10. 有 entry 的 child：不进 running 集合；`ended` 含 `{status:"lost"}`；真实 outcome 在场时 outcome 赢过 entry（优先级验证）。

`coldHydrationSubagentStatus.test.ts` 扩展（矩阵新档位）：

11. facts 含 lost entry（即 ended 带 lost）⇒ row failed + `running=[]` + `endedTotal=1`——现有 307 行用例已覆盖该形状，**补一条「entry 经 inventory 注入」的集成形态**；
12. 收敛后幂等：同一 transcript + entry 重放两次 ⇒ subagents 与行逐字段一致（对齐 195 行用例的幂等断言）；
13. 回归护栏：`subagentChildFacts` 缺席（回放桶）+ 无 entry ⇒ 保持 part 推断（现有 297 行用例语义不被收敛机制影响）。

**真机 E2E 点（implementer/test-verifier 手工或脚本化）：**

1. 桌面启动 → 后台 agent 运行中 → `kill -9` 桌面进程 → 重启 → 打开该会话：卡片消失、侧栏「已丢失」、row failed、无 Stop 入口残留；
2. 同会话再次 reload / 切走切回：状态稳定不闪烁（持久性验证）；
3. 双端（手机远控）打开同一会话：看到同一终态；
4. 存活回归：后台 agent 正在跑时**正常**重启前的切走切回（不杀进程）⇒ running 保持（48f7f18 主语义不回归）；
5. SendMessage 到已收敛 agent ⇒ 得到既有 `No active local_agent task found` 失败（现状语义，不因收敛改变）。

### 4.8 实施拆分（T 级，供 implementer 执行）

依赖序：T1 → T2 → T3 → T4 → T5；T6 与 T2-T4 并行；T7 收尾。

| 任务 | 内容                                                                                                                                                                                                                                      | 依赖          | 风险标注                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------------------------------------------------------- |
| T1   | spec 先行：把本设计 §4 各结论落为行为 spec（产品规则、状态所有者、验收场景），更新到本分支文档                                                                                                                                            | —             | 低；仓库规范「先 spec 后实现」                                    |
| T2   | 判据纯函数 + `subagent-orphan-reconcile.ts` 模块骨架：`reconcileSubagentOrphansOnActivation` + `SUBAGENT_ORPHAN_GRACE_MS` 常量 + 结构化日志事件（`zcode_protocol.subagent.orphan_reconciled` / `_skipped` / `_failed`，对齐既有日志命名） | T1            | 低；纯函数可先行全测                                              |
| T3   | entry 写入与读取接线：新 `SESSION_ENTRY_SUBAGENT_OUTCOME` 类型常量；`readSessionSubagentInventory` 读 child entry；`runningStatus`/`endedStatus` 消费（优先级：真实 outcome > entry）                                                     | T2            | 中；核对 A1（saveSessionEntry upsert 语义），不成立则走 §5.3 备选 |
| T4   | 挂点：`activateSessionForResume` 尾部调用（`app.resume()` 成功后、返回前）；确认 `ensureResumed` 单飞覆盖（C9）使重复订阅不重复收敛                                                                                                       | T3            | 中；注意激活路径时延（复用 inventory 单次读，只对孤儿写）         |
| T5   | 测试补齐：§4.7 单测 1-13 + coldHydrationSubagentStatus 矩阵扩展                                                                                                                                                                           | T3            | 低                                                                |
| T6   | i18n 可选键 `subagentDirectory.summary.reconciled`（zh/en）+ 真机 E2E 五点                                                                                                                                                                | 与 T2-T4 并行 | 低；可选增强可独立裁剪                                            |
| T7   | `pnpm typecheck` / `pnpm lint` / `pnpm --dir apps/zcode-cli typecheck` / lint + 架构检查 `pnpm architecture:check --changed`；如实记录结果                                                                                                | T5、T6        | 流程项                                                            |

---

## 5. 备选方案记录（design-it-twice 摘要）

### 5.1 触发时机备选

- **hydration 时收敛**：被否——投影重建产生持久副作用，且无法区分 owner/viewer（§4.1-2）。
- **周期看门狗**：被否——孤儿是一次性遗留不是持续病态；看门狗与活 registry 竞态引入新误杀窗口（§4.1-4）。

### 5.2 判据备选

- **SessionResumed 世代判据**：被否——「接管时刻零在飞」已蕴含所需信息，引入世代标记是多余状态（AGENTS.md：避免重复状态）。
- **跨进程活清单/presence 协议**：被否——超出 P2 范围且 ADR0003 单运行时下无消费者（§4.2）。

### 5.3 落点备选（A1 不成立时）

- 写 child session entry（**首选**，先例 C11）；
- 备选：child `SessionInfo` 上的专用字段（需要 store schema 支持，成本高）；
- 被否：写 `metadata.json`——今天无任何读方（C4），会造成与 child transcript 平行的第二权威，违反单写路径规范；
- 被否：hydration facts 临时合成——见 §4.3 论证。

---

## 6. 降级矩阵扩展后的完整档位（测试对照表）

| 档  | child 事实 | 终态证据                      | 运行时切片        | row                 | 侧栏     | 用例锚                        |
| --- | ---------- | ----------------------------- | ----------------- | ------------------- | -------- | ----------------------------- |
| 1   | known      | 无                            | 已激活/活 runtime | running             | 运行中   | 现有 211/230/238 行（不回归） |
| 2   | known      | 无                            | 接管 ∧ 宽容期内   | running（本次跳过） | 运行中   | 新增 §4.7-2                   |
| 3   | known      | 无                            | 接管 ∧ 过宽容期   | failed              | 已丢失   | 新增 §4.7-1/11                |
| 4   | known      | success/failed/cancelled      | 任意              | 对应收口            | 对应     | 现有 251/264/275 行           |
| 5   | known      | lost（entry 或既有来源）      | 任意              | failed              | 已丢失   | 现有 307 行 + 新增集成形态    |
| 6   | unknown    | —                             | 任意              | part 推断           | —        | 现有 286 行                   |
| 7   | facts 缺席 | —                             | 任意              | part 推断           | —        | 现有 297 行                   |
| 8   | known      | entry ∧ 真实 outcome 后来到场 | 任意              | 真实 outcome 赢     | 真实终态 | 新增 §4.7-10                  |
| 9   | 前台 part  | part 终态                     | 任意              | part 终态           | —        | 现有 318 行（不回归）         |

---

## 7. 风险与回滚

| #   | 风险                                                                                        | 概率/影响 | 缓解                                                                                     | 回滚                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| R1  | 双进程违例（CLI+桌面同会话）下误收敛另一进程仍在跑的 agent                                  | 低/中     | J5 宽容期 10 分钟（§4.2）；ADR0003 已消除常态双 host                                     | entry 只增不改：删掉该 child 的 entry 即恢复 running 显示；或挂点短路（一行调用移除），机制整体退场不影响 48f7f18 行为 |
| R2  | entry 与 child transcript 真实终态竞争（收敛后 child 又有了真实 outcome——仅 R1 情形下可能） | 低/低     | 读取端优先级固定「真实 outcome > entry」（§4.3）；真实终态到场自动覆盖展示               | 同 R1：entry 是补洞事实，删除无损                                                                                      |
| R3  | 激活路径变慢（reconcile 串在 activation 尾部）                                              | 中/低     | 复用 inventory 单次读（与 hydrate 同源）；只对孤儿写；失败即刻降级 warn                  | 挂点移除即回到修前激活时延                                                                                             |
| R4  | A1 假设不成立（entry 无法按设想写入 child 会话）                                            | 低/中     | §5.3 备选落点；实现期 T3 第一件事核对                                                    | 设计不变，仅换存储 adapter                                                                                             |
| R5  | 收敛把「用户还想 resume 的 agent」标死，用户预期落空                                        | 低/低     | SendMessage 跨重启本来就不可用（C5，报错而非续跑）；lost≠failed 的文案已区分「结果未知」 | 无需回滚：行为与现状一致，只是显示从谎称 running 变为诚实的已丢失                                                      |
| R6  | 48f7f18 的 11 例回归                                                                        | 低/高     | 新维度不改既有档位（§4.5）；T5 回归护栏用例 13                                           | 模块独立、挂点独立，revert 单提交即可                                                                                  |

**回滚边界**：整个机制 = 一个新文件 + `server-operations.ts` 一行挂点 + inventory 读面一处消费，可单提交 revert，不触碰 48f7f18 的任何判定代码。

---

## 8. 交接说明（给 task-planner）

- 本设计已到「可拆解」状态：模块单一、接口单一（一个函数 + 一个常量 + 一个 entry 类型）、读面改动收敛在 `readSessionSubagentInventory`/`projectSessionSubagents` 一处、挂点一行。
- 拆解时保持 T2（判据）与 T3（存储接线）为两个独立提交（仓库提交规范：功能级独立提交）；T3 实现前必须先核对 A1（`saveSessionEntry` 对 child 会话的 upsert 语义），并把核对结论写进提交说明。
- 并行性：T6（i18n/E2E）与 T2-T4 无代码交叉，可并行；T5 依赖 T3 的读取端优先级实现。
- 不变量验收（给 code-reviewer 的两条硬线）：①任何情形下「本 runtime 正在跑的 agent」被收敛即为 P0 缺陷；②48f7f18 的 11 例测试必须逐例保持绿。

## 9. 未决问题（不阻塞拆解，实现期核定）

1. `SUBAGENT_ORPHAN_GRACE_MS` 的最终值（10 分钟为推荐默认；若 T6 E2E 观察到更长的合法静默工具，上调并记录依据）。
2. `subagentDirectory.summary.reconciled` 可选键是否进本期（建议进，成本低）。
3. entry 的 `runtimeInstance` 字段取什么进程标识（pid 足够；注意不得写入可识别用户目录等敏感路径——仓库敏感信息规范）。
