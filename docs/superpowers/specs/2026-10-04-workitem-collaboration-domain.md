# 工作项协作域规格：Comment / Activity / Decision

- **状态**：规格草案，待后续实现轮次拆解；本轮只新增规格，不实现产品代码。§12 十二项未决问题已于 2026-10-05 全部裁定（§12.1）；同日上位裁定「优先按 multica 的设计」+ 分歧五项与追加三项定案（§12.2）
- **日期**：2026-10-04
- **适用分支**：`feat/multi-agent-squad-p2b`
- **上位依据**：`docs/superpowers/specs/2026-10-01-multi-agent-squad-design.md`（§5.1、§5.5、§5.7、§8、§10、§15），`docs/multica-squad-absorption-review.md`（§1.4、§1.6、§1.8、§5.6、§5.7），以及 `.superpowers/sdd/2026-10-01-multi-agent-squad-p2b/progress.md` 最近的 P2b 接线记录。

> 本规格只定义工作项协作域的持久事实、触发语义和未来接线契约。当前仓库已经有 `WorkItem`、`WorkItemService`、`WorkItemEvent`、`WakeRule`、`InboxItem` 与 `squad_runs` 的部分实现，但 **Comment / Activity / Decision 尚未实现**。文中“必须”是后续实现契约；“预留”是本轮不实现的接口边界，不能当作已完成能力。

## 1. 目的与范围

本域解决一个窄而完整的问题：人、队长 run、队员 run 围绕一个 `WorkItem` 沟通时，如何留下可审计的评论和活动事实，如何表达需要明确裁决的决定，以及评论何时只记录、何时触发一次派发。

本域不重新定义：

- `WorkItem` 生命周期。状态仍为 `todo | in_progress | in_review | blocked | done | cancelled`，由 `WorkItemService.transition` 通过 CAS 唯一写入。
- `Run` 执行生命周期。当前 `squad_runs` 的 `running | completed | error | ...` 等执行台账继续由现有运行时拥有。
- `WakeRule` 的四种 `event | at | every | cron` 调度语义。
- 父子 `SendMessage` 语义。它仍表示父会话与其派出的子 agent，不变成工作项群聊。
- 本轮 Subscriber 的实现、权限判定实现、Chat UI 实现和网络同步。

## 2. 逆推：从 multica 协作闭环反推边界

### 2.1 闭环事实

multica 的协作闭环可压缩为：

```text
WorkItem 被创建/指派
  -> 人或队长说明目标、上下文、阻塞点
  -> agent 独立 Run 执行
  -> Run 汇报结果或提出问题
  -> 人/队长作决定，或继续派发
  -> WorkItem 状态由唯一状态机推进
  -> 全部事实可按时间线重放
```

从这个闭环反推，必须分开三种东西：

1. **Comment**：有人对工作项说了一段话，可能带 thread、代码位置、mention 和命令标记；它是沟通输入。
2. **Activity**：系统确认发生了一件可审计的域事实，例如评论已创建、派发请求已发出、Run 已开始或状态已变更；它是时间线事实，不是聊天正文。
3. **Decision**：对工作项作出的结构化裁决，例如“选择方案 B”“接受/拒绝某个交付物”“允许继续派发”；它必须能指向证据和发起来源，但不能偷偷替代 `WorkItemService` 的状态写入。

若把三者混为一张表，会产生三类不可接受的歧义：

- 一条普通评论被误当成状态命令；
- 一个活动时间线条目被误当成可回复消息；
- 一个决定被误当成“Run 成功即工作完成”。

### 2.2 边界结论

- Comment 是**输入事实**，只增不改；Activity 是**派生/记录事实**，只增不改；Decision 是**结构化输入事实**，只增不改。
- 评论的触发能力只产生 `dispatch event`，不直接开 Run、不直接改负责人、不直接改 WorkItem 状态。
- Activity 不能触发执行，除非它作为事实被匹配到已有 `WakeRule`；即“Activity 记录”与“WakeRule 消费事实”是两步，不是 Activity 自己开 Run。
- Decision 默认只表达裁决；若后续实现需要状态变化，必须调用 `WorkItemService.transition`，并把该状态变更另记为 Activity。
- 共享沟通会话是沟通面；工作项评论是可触发的执行入口；队员执行始终发生在自己的 Run/工作树中。

## 3. 实体契约

### 3.1 公共值对象：Author 与 SourceRun

所有三种实体都必须带作者和来源，不能只存一个自由文本作者名。

```text
AuthorRef {
  kind: human | agent | system
  id: string                 // human 使用顶层人类主体 id；system 使用稳定服务主体 id
  displayName?: string       // 展示快照，不作为身份键
}

SourceRunRef {
  runId: string
  agentId?: string
  squadId?: string
  role: leader | member | standalone
}
```

规则：

- `author` 是“谁写下这条事实”；`sourceRun` 是“哪一次 Run 产生/携带了它”。人手工评论的 `sourceRun` 为 `null`；队长或队员在 Run 中写评论时必须带 `sourceRun`。
- agent 代人发言不能把 `author.kind` 写成 human；顶层人类发起者另存为 `initiatedBy`（见 §8），用于权限和审计归因。
- `system` 只用于系统生成的 Activity/Decision，例如状态机消费派发事件；系统不能冒充某个 agent。

### 3.2 WorkItemComment

`WorkItemComment` 是工作项下的不可变沟通条目。建议字段如下：

| 字段                | 类型/取值       | 约束与含义                                                      |
| ------------------- | --------------- | --------------------------------------------------------------- | -------------------------------------------- | ------------------------------------- |
| `id`                | 稳定字符串      | 唯一主键；生成后不变                                            |
| `workspaceIdentity` | string          | 使用既有规则：`workspaceIdentity?.trim()                        |                                              | workspacePath`；持久化键优先 identity |
| `workspacePath`     | string          | 当前本地工作区路径快照；不得用它跨 workspace 合并记录           |
| `workItemId`        | string          | 必须指向同一 workspace 的未归档或历史工作项                     |
| `threadId`          | string          | 线程根 id；根评论的 `threadId = id`                             |
| `parentCommentId?`  | string          | 直接回复的父评论；必须属于同一 `threadId` 和工作项              |
| `author`            | `AuthorRef`     | 评论作者                                                        |
| `sourceRun?`        | `SourceRunRef`  | agent/队长 Run 来源；人手工评论为空                             |
| `initiatedBy`       | `AuthorRef`     | 顶层人类发起者；agent 链路也必须保留，禁止由最后一个 agent 覆盖 |
| `body`              | string          | 原文，创建后不可编辑；空白正文拒绝                              |
| `mentions`          | `MentionRef[]`  | 解析后的 `agent`/`all` mention 快照；不得只靠展示时重新解析     |
| `command`           | `none           | note`                                                           | `/note` 解析结果；未知命令不得静默当普通命令 |
| `inline`            | `InlineAnchor?` | 文件/行/片段锚点；锚点失效仍保留原值                            |
| `createdAt`         | epoch ms        | 服务端事实时间                                                  |
| `clientRequestId?`  | string          | 调用方重试幂等键；作用域为 workspace + author                   |
| `revision`          | integer         | 评论序号或存储版本；创建后不变，用于排序/重启审计               |

`InlineAnchor` 至少包含 `path`、`startLine`、`startColumn?`、`endLine?`、`endColumn?`、`baseRevision?`。它是上下文，不是工作树状态；行号漂移不能修改评论，也不能让评论消失。引用形态已定案：锚点 + 尽力存评论时 commit SHA（`baseRevision`），不存内容快照（§12.1-9）。

评论**软删除**（对齐 multica #8296，2026-10-05 裁定）：新增 `deletedAt?` 墓碑字段——置位只写时间戳，正文/作者/锚点一律不动；已删评论不再作为 thread_parent 参与路由（§4.5 第 5 条），但其线程内回复仍是回复（不升格为新请求）；删除事实写 `comment_deleted` Activity。编辑/覆盖仍不支持。

**线程解决态**（对齐 multica 069，2026-10-05 裁定）：线程根评论新增 `resolvedAt?`；仅根可置位/取消，各写一条 Activity；解决态不影响任何触发语义。

**表情回应**（对齐 multica 026，2026-10-05 裁定）：新增轻实体 `WorkItemCommentReaction { id, workspaceIdentity, workItemId, commentId, author, emoji, createdAt }`，append-only，`(commentId, author, emoji)` 幂等；永不触发派发；写 `comment_reaction_added` Activity。

### 3.3 WorkItemActivity

`WorkItemActivity` 是工作项时间线中的不可变事实。它不是评论的别名，也不是任意日志。

| 字段                                  | 类型/取值      | 约束与含义                                       |
| ------------------------------------- | -------------- | ------------------------------------------------ |
| `id`                                  | 稳定字符串     | 唯一主键                                         |
| `workspaceIdentity` / `workspacePath` | string         | 与 Comment 相同                                  |
| `workItemId`                          | string         | 所属工作项                                       |
| `kind`                                | 闭集枚举       | 初始集合见下表；未知 kind 读回必须响亮失败       |
| `occurredAt`                          | epoch ms       | 事实发生时间；不以读取时间代替                   |
| `sequence`                            | integer        | 同一 workspace/workItem 的单调序号；用于稳定排序 |
| `actor`                               | `AuthorRef`    | 事实直接发生者；系统消费事件时可为 system        |
| `sourceRun?`                          | `SourceRunRef` | 若由 Run 产生则带上                              |
| `initiatedBy`                         | `AuthorRef`    | 顶层人类归因，规则触发可为 system/原始人类上下文 |
| `commentId?`                          | string         | 与评论事实关联；仅评论相关 Activity 使用         |
| `decisionId?`                         | string         | 与决定事实关联                                   |
| `dispatchEventId?`                    | string         | 与派发事件关联；用于重放与去重                   |
| `payload`                             | JSON object    | 结构化快照；不得承载可变引用来改变历史意义       |
| `dedupKey`                            | string         | 同一事实重投只留一条；数据库唯一约束兜底         |

初始 `kind` 建议闭集：

- `comment_created`
- `comment_mention_parsed`
- `comment_dispatch_requested`
- `comment_dispatch_suppressed`
- `decision_created`
- `status_changed`
- `assignee_changed`
- `run_started`
- `run_completed`
- `run_failed`
- `run_cancelled`
- `worktree_created`
- `worktree_merged`
- `worktree_discarded`
- `wake_rule_fired`
- `inbox_item_created`
- `comment_deleted`
- `comment_resolved`
- `comment_reaction_added`

其中 `status_changed` 必须引用既有 `WorkItemService.transition` 产生的事件；Activity 不能反过来成为状态写接口。

### 3.4 WorkItemDecision

`WorkItemDecision` 是工作项上的结构化裁决，不等于“评论里提到一个选择”。只有显式创建决定的入口才产生它。

| 字段                                  | 类型/取值      | 约束与含义                                       |
| ------------------------------------- | -------------- | ------------------------------------------------ | ----------------- | -------------------- | --------- | ------------------------------------ |
| `id`                                  | 稳定字符串     | 唯一主键                                         |
| `workspaceIdentity` / `workspacePath` | string         | 与其他实体相同                                   |
| `workItemId`                          | string         | 所属工作项                                       |
| `threadId?`                           | string         | 决定所在讨论线程；可为空但推荐关联证据线程       |
| `parentDecisionId?`                   | string         | 对前一决定的替代/复议关系，不覆盖前决定          |
| `author`                              | `AuthorRef`    | 作出裁决者                                       |
| `sourceRun?`                          | `SourceRunRef` | 若由队长/队员 Run 提议或提交                     |
| `initiatedBy`                         | `AuthorRef`    | 顶层人类发起者归因                               |
| `kind`                                | `proposal      | accepted                                         | rejected          | superseded           | reopened` | 决定关系，不直接等于 WorkItem status |
| `subject`                             | string         | 被裁决的事项或问题键                             |
| `selection`                           | JSON           | 选中的方案/值；结构由后续具体 Decision kind 约束 |
| `rationale`                           | string         | 人可读理由；可为空但不建议省略                   |
| `evidence`                            | `CommentRef[]  | ActivityRef[]                                    | DeliverableRef[]` | 支撑决定的不可变引用 |
| `effectiveAt`                         | epoch ms       | 决定生效时间                                     |
| `dedupKey`                            | string         | 同一明确决定请求重试不产生重复决定               |

Decision 只增不改。`superseded` 是一条新决定，不能把旧决定更新为无效；时间线必须能回答“当时作了什么决定、后来由什么决定取代”。

## 4. 触发矩阵：穷举来源与结果

### 4.1 触发结果的定义

为避免“写活动”和“触发运行”混为一谈，结果列使用以下闭集：

- `C`：写入 `WorkItemComment`。
- `A`：写入一个或多个 `WorkItemActivity`。
- `D`：产生 `dispatch event`，进入既有派发收口；不等于已开 Run。
- `R`：由派发桥成功接受后才创建/合并 Run；本规格只规定 Comment 侧不能直接做这一步。
- `N`：不触发派发；可以仍写 `C`/`A`。
- `I`：未来按需创建 Inbox/Subscriber 通知；本轮只留接口，不实现。

### 4.2 评论来源矩阵

| 来源/形态                     |                                     C |                                                                            A |                              D | N/R 规则                                      | 说明                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------: | ---------------------------------------------------------------------------: | -----------------------------: | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 普通人类评论，无 mention      |                                    是 |                                        `comment_created`；触发时另写派发事实 |                         按级联 | 隐式路由级联定目标（§4.5）；无 agent 语境则 N | 对齐 multica：对 agent 指派/agent 参与的项说话＝请求其处理；@all/@人名 抑制（§4.5）                                                                                                      |
| 普通 agent 评论，无 mention   |                                    是 |                                                            `comment_created` |                             否 | N                                             | `sourceRun` 必须存在；agent 评论不参与隐式路由（§4.5），显式 @ 才触发                                                                                                                    |
| `@agent` 人类评论             |                                    是 |  `comment_created` + `comment_mention_parsed` + `comment_dispatch_requested` |                       是，一次 | D 后按既有去重/合并规则进入 R                 | `@` 是一次运行请求，不是改派，不改负责人/状态                                                                                                                                            |
| `@agent` 队长/队员评论        |                                    是 |                                                                         同上 |                       是，一次 | 顶层人类归因沿 `initiatedBy` 传递             | A2A 不得绕过权限；不因“来自 agent”自动放大权限                                                                                                                                           |
| `@all` 评论                   |                                    是 | `comment_created` + `comment_mention_parsed` + `comment_dispatch_suppressed` |                             否 | N                                             | @all 无副作用（不开 run/不订阅/不通知），唯一语义＝抑制隐式路由（§12.1-3、§4.5）                                                                                                         |
| `/note` 无 mention            |                                    是 |                            `comment_created` + `comment_dispatch_suppressed` |                             否 | N                                             | `/note` 只留记录；正文是否去除命令前缀由实现统一决定，原文必须可审计                                                                                                                     |
| `/note @agent`                |                                    是 |                                                    同上，另记录 mention 解析 |                             否 | N                                             | `/note` 优先级高于 mention；不得因为 mention 再派发                                                                                                                                      |
| 未知 slash command            | 是或拒绝，取决于 parser；不得静默降级 |                                                   若接受则 `comment_created` | 否，除非明确解析为已知触发命令 | N                                             | 规格要求响亮错误或明确普通文本策略，不能让客户端各自猜                                                                                                                                   |
| 内联评论，无 mention          |                                    是 |                                             `comment_created`（含 `inline`） |                         按级联 | 同普通人类评论（§4.5）                        | 行锚点只提供上下文，不改变触发语义                                                                                                                                                       |
| 内联评论 `@agent`             |                                    是 |                                                                   评论三件套 |                       是，一次 | D 后按普通 `@agent` 规则                      | 内联不抑制触发                                                                                                                                                                           |
| 同一作者连续普通评论          |                              每条均是 |                                                                     每条均写 |                             否 | N                                             | 评论事实不合并、不丢原文（**口径备注 2026-10-07 裁定**：本行「否」＝不因连续而各自独立派发——首条评论仍按 §4.5 级联进入触发解析（含兜底），后续同对评论按 §4.3 合并窗口并入同一派发决策） |
| 同一 agent 连续 `@agent` 评论 |                              每条均是 |                                                                     每条均写 |  合并为一个逻辑 dispatch event | 目标相同且合并窗口内时只 R 一次               | “连续评论合并”只合并派发，不合并 Comment/Activity                                                                                                                                        |
| 不同 agent 连续评论           |                              每条均是 |                                                                     每条均写 |                 分别按目标去重 | 不得因时间接近而跨作者合并                    | 合并键至少包含 workItem、目标 agent、thread、窗口/代次                                                                                                                                   |
| 评论回复 `parentCommentId`    |                                    是 |                                                            `comment_created` |                     由级联决定 | N 或 D                                        | mention 优先；否则 thread_parent / conversation_continuation 规则（§4.5）；人回人不触发、不落兜底                                                                                        |
| 共享沟通会话消息              |      否（除非显式转成工作项 Comment） |                                                          不写工作项 Activity |                             否 | N                                             | 会话消息不享有评论触发特权                                                                                                                                                               |
| 系统状态/Run/合并事实         |                                    否 |                                                              写对应 Activity |         不由 Activity 直接产生 | N；若匹配 WakeRule，由规则路径 D              | 事实可被 WakeRule 消费，但 Activity 不是执行器                                                                                                                                           |

### 4.3 连续评论合并契约

“连续评论合并成一次运行”不是把评论压成一条，也不是丢弃重复评论。实现必须：

1. 每条 Comment 原样落库，每条对应 `comment_created` Activity。
2. 解析每条 mention 并落 `comment_mention_parsed` Activity。
3. 对可触发 mention 计算稳定合并键：
   `workspaceIdentity + workItemId + targetAgentId + dispatchGeneration`。
   （B-3 裁定 2026-10-06：**threadId 不进合并键**——与已落地的队列唯一索引
   `(workspace_key, work_item_id, agent_id) WHERE status='queued'` 同键；threadId 降为
   请求身份键（进 dedupKey，不进唯一性），避免两套「至多一个待开」定义。）
4. 在规定合并窗口内，重复目标只产生一个 `comment_dispatch_requested` 的事实和一个逻辑 dispatch event；后续评论 Activity 引用第一次 event。
5. 合并窗口、窗口结束条件、跨重启如何恢复必须是持久化契约，不得靠内存定时器决定事实是否重复。
6. `/note` 与 `@all` 永不进入可触发合并桶。

窗口形态已按 multica 源码定案为**队列状态窗**（非时间窗）：合并条件 = (workItem, targetAgent) 已有待开 Run；持久状态即待开 Run 行与完成重放义务本身，重启天然恢复（§12.1-1、§12.2）。

### 4.4 什么“绝不触发”

下列输入绝不直接产生 dispatch event：共享沟通会话消息、普通 **agent** 评论、无 agent 语境的人类普通评论（指派给人或未指派）、`@all`（仅抑制，自身不触发）、所有 `/note`、Activity 被读取/展示、Decision 被创建、评论编辑请求（不支持）与软删除请求、表情回应。人类普通评论对 agent 语境工作项的触发走 §4.5 隐式路由级联，是显式规则而非例外。若未来 WakeRule 消费这些事实，必须由 WakeRule 的 `eventKey`、`revision` 和防失控规则决定是否派发，不能把“Activity 写入”本身解释成自动执行许可。

### 4.5 隐式路由级联（对齐 multica，2026-10-05 裁定 a/b/c；五源一次全量进 C1）

人类评论（无显式 @agent/@squad mention）按以下优先级确定触发目标，命中即止：

1. **显式 mention 优先**：`@agent`/`@squad` 走 §4.2 矩阵，本级联不参与；
2. **@all 抑制**：含 `@all` ⇒ 无隐式触发（MUL-5411）；
3. **@人名抑制**：评论点名了人类成员 ⇒ 无隐式触发（说给人听，不惊动 agent）；
4. **指派小队 ⇒ 队长**：assignee 为 squad 时触发其队长；
5. **thread_parent**：回复某 agent 作者的评论 ⇒ 触发该 agent；父评论已软删除（`deletedAt` 置位）则不算；
6. **conversation_continuation**：回复线程的根所有者 agent ⇒ 触发之；人回人（父作者为人类）⇒ 不触发，也不落到指派兜底；
7. **issue_assignee 兜底**：以上未命中且指派为 agent ⇒ 触发该 agent。

约束：agent 评论不参与本级联（显式 @ 才触发）；触发源为五源闭集 `issue_assignee | mention_agent | mention_squad_leader | thread_parent | conversation_continuation`，派发事实与 Activity 必须带源；命中目标后的合并/排队/重放仍按 §12.1-1/2 执行（队列状态窗、并入待开 Run、完成重放义务）。**system 锚点口径（2026-10-07 裁定）**：线程锚点是 system 事实（system 作者的父评论/根评论，无论是否已软删）⇒ 本级联**不触发也不落到 issue_assignee 兜底**——system 既非人类亦非 agent，兜底会把对系统事实的回复误路由给 assignee（软删父「不算」的既有规则只解除 thread_parent 命中，不授予兜底资格）。

## 5. 状态与唯一写者

### 5.1 评论/活动/决定只增不改

- 三类实体均采用 append-only 存储；禁止 `UPDATE body/payload/author/selection`。
- 纠错使用新 Comment、`superseded` Decision 或补充 Activity；不得覆盖历史。
- 归档、已读、通知投递状态属于 Inbox/Subscriber 的控制面，不改变协作事实。
- 所有写入应在同一 workspace 事务边界内完成：先验证工作项身份和权限，再写实体，再写关联 Activity，再提交 dispatch event receipt。

### 5.2 WorkItemService 是状态唯一写者

`WorkItemService.transition(id, next, expect)` 仍是唯一可写 `WorkItem.status` 的服务入口。评论触发链必须是：

```text
CommentService.create
  -> append Comment
  -> append comment Activities
  -> produce dispatch event / receipt
  -> dispatch bridge 做门禁、幂等、合并、开 Run
  -> Run 结束或规则事实
  -> WorkItemService.transition（如确需状态变化）
  -> append status_changed Activity
```

禁止：

- Comment handler 直接调用 `repo.updateStatus`；
- mention parser 直接调用 `openMemberRun`；
- Decision handler 直接把工作项写成 `done`/`blocked`；
- UI、CLI 工具、队长 Run 各自复制一套触发判据。

`@agent` 不等于改派。它只产生一次派发请求，`assignee` 保持不变；用户改派仍走 `WorkItemService`/既有改派接口并产生 `workitem.dispatch_requested`，其 `cause` 继续使用现有 `leader_tool | user_reassign | rule` 闭集的扩展方案（评论成因必须另行扩展，不得把 `@` 伪装成 `user_reassign`）。

## 6. 共享沟通会话、队长/队员 Run 与 steering 边界

| 表面             | 目的                                        |              是否写 WorkItemComment |                 是否启动新 dispatch |                                     是否 steering 当前 Run |
| ---------------- | ------------------------------------------- | ----------------------------------: | ----------------------------------: | ---------------------------------------------------------: |
| 共享沟通会话     | 多方讨论、汇报、队长协调                    |                              默认否 |                                  否 |                                   否；需显式 steering 入口 |
| 工作项 Comment   | 对工作项留下可审计沟通                      |                                  是 |                        仅按 §4 矩阵 |                                                         否 |
| `@agent` Comment | 请求目标 agent 独立处理一次                 |                                  是 |                    是，一次逻辑请求 |                            否，除非调用方明确选择 steering |
| steering         | 给正在运行的同一 Run 补充输入               | 可选关联 Activity，不自动造 Comment |                                  否 |                     是，进入 `CommandInbox` 串行 admission |
| 新 dispatch      | 创建/合并新的目标 Run                       |             可关联 Comment/Activity |                                  是 |                                                         否 |
| 队长 Run 派单    | 队长在 leader-role Run 中产出子项或派发事件 |                 可由 Run 写 Comment |                  是，走既有派发收口 | 队长对自己的 Run 可 steering，但不把 steering 变成队员 Run |
| 队员 Run 汇报    | 独立执行结果、风险、证据                    |             推荐写 Comment/Activity | 否，除非显式 mention 或规则消费事实 |                         队员只能 steering 自己的运行上下文 |

关键判定：

- **steering 不是 Comment 的隐式别名**。它是运行期输入，目标是一个已存在且可接收输入的 Run；不能创建新 Run，不能改变负责人或状态。
- **Comment 不是 steering**。即使目标 agent 当前 busy，`@agent` 仍是一次可去重的 dispatch 请求；派发桥决定合并、排队或拒绝，而不是把内容偷偷注入当前 Run。
- **队长派单不是状态推进**。队长只能产出子工作项和派发事件；父项状态仍由服务层按条件推进。
- **共享会话不触发执行**。若用户需要执行，必须明确发工作项 Comment `@agent` 或使用既有手动派发入口。

## 7. Inbox / Subscriber 预留接口

本轮不实现 Subscriber，也不扩大当前 Inbox 的 kind 闭集。规格先固定未来挂接形状，避免后续各入口自行推导通知原因。

### 7.1 Subscriber 预留

未来订阅关系仍为：

```text
Subscriber {
  id
  workspaceIdentity
  workItemId
  subject: { type: human | agent | squad, id }
  reason: creator | assignee | commenter | mentioned | delegated | manual
  optOutScope: issue | subtree
  tombstonedAt?
  createdAt
}
```

Comment/Decision 接入时必须按以下事实挂 reason：

| 事实                            | 默认 reason | 说明                                                                                                                                                                        |
| ------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 创建工作项的顶层人类            | `creator`   | 记录创建者，不因后续改派消失                                                                                                                                                |
| 当前 assignee                   | `assignee`  | 改派后按新负责人生成/撤销关系                                                                                                                                               |
| 成功写入至少一条 Comment 的主体 | `commenter` | 不能仅因浏览评论订阅                                                                                                                                                        |
| 被 `@agent` 明确点名的主体      | `mentioned` | `@all` 只广播，不 fan-out 触发；已定案**无副作用**：不开 run、不建订阅、不产生通知（通知只发订阅者），唯一语义 = 抑制隐式派发路由（§12.1-3；隐式路由对齐见 §12.2 待裁项 a） |
| 队长将子项派给队员/小队         | `delegated` | 来源由 `causedByRunId` 或派发 Activity 关联                                                                                                                                 |
| 用户手工订阅                    | `manual`    | 不被自动规则删除                                                                                                                                                            |

所有 reason 必须由事实生产点显式写入或调用统一 reconciler；UI 不得根据当前列表临时猜 reason。`optOutScope` 和 tombstone 的语义沿上位规格保留，未实现。

### 7.2 Inbox 预留

未来评论/决定相关 Inbox 至少要能表达：

- `mention_action_required`：明确要求某人回应/执行；
- `decision_required`：需要人作裁决；
- `comment_attention`：仅需关注，不要求动作；
- `dispatch_skipped` / `member_failed` / `merge_conflict` 等既有种类继续由当前 Inbox 生产器负责。

Inbox item 必须引用 `workItemId`、可选 `commentId`/`decisionId`/`runId` 和稳定 `dedupKey`。严重级仍由 kind 的唯一映射决定，不由评论入口自行传入。何时推送、父子冒泡、渠道只读通知属于后续 Inbox 实现轮次。

## 8. 幂等、排序、并发、重启恢复与 workspace identity

### 8.1 幂等

- Comment：`clientRequestId` 在 `(workspaceIdentity, author, clientRequestId)` 范围唯一；同请求重试返回同一 Comment，不重复写 Activity。
- Activity：`dedupKey` 唯一；状态事件沿既有 CAS 规则，CAS 未命中不得补发伪造的 `status_changed`。
- Decision：由 `workItemId + subject + initiatedBy + sourceRequestId` 形成请求幂等键；复议使用新 `parentDecisionId`，不重用旧 id。
- Dispatch：评论派发不得复用现有 `eventKey` 的临时字符串拼接。应新增统一 `computeCommentDispatchKey`，并纳入评论 id/合并代次/目标；最终仍由派发收口做 dedup、merge 和 gate。
- Inbox：继续使用存储层唯一索引和 `INSERT OR IGNORE`，不能先查后插。

### 8.2 排序

展示排序必须确定且可重放：

1. 主排序按 `sequence ASC`；
2. 同一事务/序号冲突按 `occurredAt ASC`；
3. 最后按 `id ASC` 兜底。

Comment 线程内按 `createdAt ASC, id ASC`；Activity 时间线按 `sequence`。客户端不得用本地接收时间重排服务端事实。

`sequence` 必须由 workspace/workItem 级持久计数或同等原子机制产生。多进程写入时不能用内存 counter；若当前 SQLite 连接模型无法提供跨连接原子序号，应在实现计划中先解决，而不是退回随机排序。

### 8.3 并发

- 同一工作项的 Comment/Activity/Decision 写入按 workspace → workItem 固定锁序；不得出现 Comment handler 与 WakeRule handler 互相等待的反向锁序。
- Comment 与派发 receipt 必须在能保证“事实已落库则请求可重放”的事务边界内提交；若 dispatch bridge 暂不可用，保留待投递 receipt，不丢评论。（**实现状态（2026-10-06）**：现行实现为顺序语句、无显式事务包裹；崩溃窗口的半成品态由 `clientRequestId`/`dedupKey` 幂等键的持久性兜底可重放，并由未收敛回执读口保持可见——**显式缓办**，不入本期验收；需强一致时再补事务包裹层。）
- 连续评论合并由数据库/持久 receipt 决定，不由单个进程内的 timer 决定。
- WorkItem 状态仍使用既有 CAS；并发触发的状态变更失败是可预期 no-op/审计事实，不应覆盖后来状态。

### 8.4 重启恢复

启动恢复必须至少：

1. 扫描未完成的 comment dispatch receipt，按 `dedupKey` 重投；
2. 恢复连续评论合并窗口/代次，不能因重启把同一串评论再次开多个 Run；
3. 扫描缺失关联 Activity 的半成品事务，只允许补写缺失的派生 Activity，不重复 Comment；（**实现状态（2026-10-06）**：本项未实现、**显式缓办**——顺序语句崩溃窗口的半成品概率极低且经未收敛回执读口可见可复盘；X 线收官评审已将本项显式排除出验收范围。）
4. 继续遵守 P2b 的 Run/worktree orphan recovery；Comment 恢复不能复活已归档 WorkItem，也不能恢复已被取消的 Run；
5. WakeRule 仍按既有 `revision + eventKey` 重算，评论事实若被 event rule 消费，必须沿统一 eventKey 规则处理。

### 8.5 workspace identity

所有 Comment/Activity/Decision、receipt、订阅和 Inbox 引用必须包含 `workspaceIdentity`。调用方传入的 workspace 若与 runtime 的 `boundWorkspace` 不一致，必须响亮拒绝；不得“取首个 workspace”，不得只按 `workItemId` 跨 workspace 查询。`workspacePath` 是本地定位快照，不是跨 workspace 的逻辑身份。

## 9. 权限占位与顶层人类归因

本轮不实现权限判定，但接口必须预留三轴，不能继续用单个 `canAccess` 代替：

```text
canView(subject, workItem, resource)    // 能否读取工作项/线程/评论/活动/决定
canComment(subject, workItem, context)  // 能否新增评论/回复/内联评论
canInvoke(subject, workItem, target)    // 能否通过 @、手动入口或工具产生 dispatch/steering
```

约束：

- `canView` 不蕴含 `canComment`；`canComment` 不蕴含 `canInvoke`。
- `canInvoke` 的判定对象是目标 agent/Run 和工作项上下文；即使能看见评论，也未必能调起 agent。
- A2A 链路必须按顶层人类 `initiatedBy` 归因：人 U 触发 agent A，A 再 `@B` 时，权限按 U 是否能 invoke B 判定，不能按 A 的权限绕过允许名单。
- system 产生的 Activity 只能记录事实；不能以 system 身份绕过 `canInvoke`。
- 内联评论除了 `canComment`，未来还需要对代码/交付物可见性做 `canView` 检查；本轮不实现。

## 10. 与 ZPaPa 有意差异

本域吸收的是 multica 的协作语义，不复制其运行时基础设施：

1. **本地 SQLite**：ZPaPa 的 WorkItem/WakeRule/Inbox/Run 台账落在本地 SQLite，迁移只追加；不采用 multica 的 Postgres/sqlc/服务端事务模型。要补充 Comment/Activity/Decision 表时，必须复用现有 tasks database/shared connection 口径。
2. **自有 CLI、单一 runtime**：不引入 multica 的多 CLI daemon 探测、版本 gate、协议族和 claim/WS 适配层。Run 仍由 ZPaPa 自有 CLI/runtime 创建；steering 复用已有 `CommandInbox` 串行 admission。
3. **Chat 复用**：不另建 multica 式独立 Chat 入口。ZPaPa 现有会话窗口承载共享沟通会话；但工作项 Comment 仍是单独的可审计实体，不能把所有 Chat 消息自动当 Comment。
4. **本地 workspace identity**：不做多租户/多设备治理；仍保留 `workspaceIdentity` 与 `workspacePath` 双键规则，因为单机多 workspace 仍会发生串台风险。
5. **状态与执行分离**：沿用 ZPaPa 已定的 `completed != done != closed`、WorkItemService 唯一状态写者和现有 `squad_runs.dispatchCause/causedByRunId`；不把评论触发直接塞进 Run 生命周期。

## 11. 分期与独立验收

### 11.1 C0：域模型与存储事实

范围：三实体 schema/type、SQLite 追加迁移、Repo append/read/list、workspace identity、唯一键、只增不改。

验收：

- 能写入并读回 Comment/Activity/Decision；非法枚举/坏 JSON 响亮失败；
- 同一幂等键并发重试只产生一行；
- 编辑/删除 API 不存在或明确拒绝；
- 排序在相同时间戳、多连接、重启后稳定；
- 不改 `work_items.status` 写路径。

### 11.2 C1：评论解析与触发矩阵

范围：thread/parent、mention、`/note`、`@all`、inline anchor、连续评论合并、comment dispatch receipt；**隐式路由级联五源一次全量**（§4.5，2026-10-05 裁定 b）；软删除、线程解决态、表情回应三件套（§3.2，2026-10-05 追加裁定）。

验收场景至少穷举：普通评论、`@agent`、`@all`、`/note`、`/note @agent`、内联评论、回复、连续同 agent 评论、不同 agent 评论、共享会话消息；级联五源各自命中与优先级（含 @all/@人名抑制、软删除父评论排除、人回人不兜底）；软删除/解决态/回应各自动作且均不触发派发。

每个场景都断言 C/A/D/N/R 结果，特别断言：

- `@agent` 不改变 assignee/status；
- `/note` 和 `@all` 永不产生 dispatch event；
- 连续评论每条 Comment/Activity 都保留，但逻辑 Run 只合并一次；
- Comment handler 不直接调用 `openMemberRun`。

### 11.3 C2：既有 dispatch/WakeRule/Run 接线

范围：把 comment dispatch receipt 接入已有派发收口；补 dispatch cause 的闭集扩展；与 WakeRule eventKey/revision、三道闸、重启重投对齐。

验收：

- 派发桥故障后重启可重投且不重复 Run；
- 规则触发、用户手动触发、评论触发分别保留成因；
- 当前 Run busy 时，评论 dispatch 的合并/排队策略有持久事实；
- 在途 Run 不受实验开关关闭影响，新 Comment dispatch 被门禁拒绝且事实仍可审计。

### 11.4 C3：Decision、steering 与 Activity 完整时间线

范围：决定创建、复议/取代、steering Activity、Run/合并/状态事实投影。

验收：

- Decision 不直接写 WorkItem status；需要状态变化时必须经 `WorkItemService.transition`；
- steering 只进入目标现有 Run，不创建新 Run；
- 共享沟通会话发言不产生 WorkItem Comment/dispatch；
- 时间线可从 Comment、Activity、Decision、Run、状态变更重放闭环。

### 11.5 C4：Subscriber/Inbox/权限

范围：实现 §7 的 reason、tombstone、opt-out、评论/决定 Inbox，以及 `canView/canComment/canInvoke` 和顶层人类归因。

验收：

- creator/assignee/commenter/mentioned/delegated/manual 六种 reason 都由事实驱动；
- A2A 不能绕过顶层人类的 invoke 权限；
- Inbox dedup、父子冒泡和渠道只读通知不产生额外 dispatch；
- 权限失败不写半条 Comment，不留下无来源的派发 receipt。

## 12. 未决问题

以下问题必须在对应实现轮次开始前定案；本规格刻意不把它们伪装成完成。（**2026-10-05 已全部定案，逐项裁定见 §12.1**）

1. Comment dispatch 的合并窗口是固定毫秒数、线程 turn，还是显式“消息批次”？窗口跨重启的持久表示是什么？
2. 连续同 agent 评论若目标 agent 当前已有 Run，默认是合并为同一新 Run、排队，还是升级为 steering？本规格只规定三者不能隐式混用。
3. `@all` 是否在未来创建 mentioned Subscriber/Inbox 通知，还是只作展示广播？本轮确定“不触发 dispatch”，通知语义仍未定。
4. `/note` 的正文存储是保留命令前缀、去除前缀，还是同时保存 raw/normalized 两份？需要统一 parser 契约。
5. Decision 的 `kind/selection` 是否按 `review_gate`、`scope_change`、`resolution` 等子类型进一步闭集化？当前只冻结通用骨架。
6. Activity 的 sequence 是每个 workspace 全局、每个 WorkItem，还是每个 thread？本规格要求稳定且可原子生成，具体粒度需结合 SQLite 索引和 UI 查询定案。
7. Activity 是否允许补偿性系统事件在原事实之后写入，及其 `occurredAt`/`sequence` 关系如何展示？
8. 评论触发是否允许跨父项/子项冒泡？上位规格有 Inbox 父子冒泡，但 Comment dispatch 默认只作用于被评论 WorkItem；跨项触发必须显式规则化。
9. 内联评论的代码快照如何引用：只存 path/行锚点，还是必须绑定 commit/blob SHA？工作树合并后锚点可见性尚未定。
10. Comment/Activity/Decision 是否进入现有远程投射/同步面？当前 ZPaPa 实验功能不参与远程投射，需在协议层明确过滤。
11. `initiatedBy` 的主体 id 如何与现有 session/user identity 对接，尤其是离线本地单用户没有服务端 account 的情况？
12. 权限失败、归档工作项、已关闭实验开关时，评论是否仍允许只读写入 Comment/Activity？本规格倾向”可审计但不可 dispatch”，待 C1/C4 裁定。

### 12.1 用户逐项裁定 + multica 源码复审定案（2026-10-05，12 项全部定案）

用户先经逐项确认（三批 4+4+4，全部按主会话推荐通过）；裁定后用户追加**上位裁定：优先按 multica 的设计**（§12.2）。据此对 12 项做源码复审：#1 #3 与 multica 实际设计冲突，按上位裁定翻案；#2 补齐源码里的另一半语义；其余 9 项维持或找到同构印证。

| #   | 问题                   | 定案                                                                                                                                                                                                                                                    | 依据                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | 合并窗口形态           | **队列状态窗（翻案）**：无时间窗。合并条件 = (workItem, targetAgent) 已有待开（queued/dispatched）Run；持久状态 = 待开 Run 行与重放义务本身，重启天然恢复，不用 timer                                                                                   | multica 无时间窗：`idx_one_pending_task_per_issue_agent_v2` 唯一索引 + head-scoped 原子合并（comment.go，MUL-4195/#5914）   |
| 2   | 目标 agent 已有 Run    | **并入待开 Run + 完成重放（用户裁定+源码补全）**：有待开 Run → 并入（coalesced，coalesced_comment_ids 逐条留痕）；仅运行中 Run → 不排新任务、不注入，评论登记为完成后重放义务（deferred），完成 reconcile 重放，义务只传递不丢弃；steering 恒为显式动作 | 用户裁定「并入待开 Run」；源码补齐 deferred 半边（reconcileCommentsOnCompletion + propagateUncoveredCommentObligation）     |
| 3   | @all 通知语义          | **无副作用（翻案）**：不开 run、不建订阅、不产生通知；唯一语义 = 抑制隐式派发路由；显式 @agent/@squad 优先于 @all（两者并存时 @all 只抑制、不吞显式目标）                                                                                               | MUL-5411：@all 从不 enqueue；`parseUUID(“all”)` 必败 + `user_type` CHECK 拒绝订阅；通知只发订阅者（notifyIssueSubscribers） |
| 4   | /note 正文存储         | **raw + normalized 两份**：body 存原文（含前缀，审计），另存去前缀 normalized（展示）；展示不重新解析                                                                                                                                                   | 用户裁定；multica 无 /note 对应物，无冲突                                                                                   |
| 5   | Decision 子类型        | **冻结通用骨架**：等首批真实场景再闭集化（C3 前再定）                                                                                                                                                                                                   | 用户裁定；multica 无 Decision 表                                                                                            |
| 6   | Activity sequence 粒度 | **每 WorkItem**：索引 (workspaceIdentity, workItemId, sequence)；跨项聚合按 occurredAt                                                                                                                                                                  | 用户裁定；multica 仅按 created_at 排序（服务端单时钟），sequence 是我们本地多进程的必需，无冲突                             |
| 7   | 补偿性系统事件         | **允许、按写入排序**：occurredAt=补偿发生时间、sequence 顺延、payload 引用原事实 id                                                                                                                                                                     | 用户裁定；multica 的 comment.type='system' 条目与义务传递日志同向                                                           |
| 8   | 跨父/子项冒泡          | **只作用于被评论 WorkItem**；跨项触发未来须显式规则化                                                                                                                                                                                                   | 用户裁定；multica 未见评论跨 issue 冒泡触发                                                                                 |
| 9   | 内联评论代码引用       | **锚点 + baseRevision**（§3.2 字段定案）：path/行锚点 + 尽力存评论时 commit SHA，不存内容快照                                                                                                                                                           | 用户裁定                                                                                                                    |
| 10  | 远程投射/同步          | **协议层过滤**：三实体纯本地、显式排除；多设备/协作场景明确后再扩协议                                                                                                                                                                                   | 用户裁定；本地 SQLite 属 §10 有意差异（multica 为云端服务端，不适用）                                                       |
| 11  | initiatedBy 主体 id    | **本地稳定 id**：首次生成本地稳定人类主体 id（一机一主），displayName 展示快照；未来接 account 建映射不换 id                                                                                                                                            | 用户裁定；与 multica `OriginatorUserID`（链顶人类）同构，仅 id 来源不同（云端账号 vs 本地生成）                             |
| 12  | 受限状态下的评论写入   | **可审计不可派发**：Comment/comment_created 照写，dispatch 被拒并落 comment_dispatch_suppressed（带原因）；评论响应须逐目标如实上报派发结果                                                                                                             | 用户裁定；multica 同构印证：TriggerOutcomes 的 `blocked` = 「评论已发，但 N 个目标未触发」如实回传                          |

### 12.2 上位裁定与 multica 源码复审（2026-10-05）

**上位裁定（用户，2026-10-05）**：**优先按 multica 的设计**——凡我们的裁定/规格与 multica 实际设计冲突且无既定有意差异保护的，对齐 multica。取证源：`multica-ai/multica@b4ca5b4` 源码（第 57 轮同源复原）。

**源码关键事实（已吸收进 §12.1）**：

1. 派发闭环：评论触发 → 每目标 `TriggerOutcomes`（`queued | coalesced | deferred | blocked`）如实回传；创建响应即可展示「评论已发，但 N 个目标未触发」；另有 trigger preview 端点（发前预览谁会被触发/阻塞）。
2. 待开唯一性：`(issue_id, agent_id)` 唯一索引（状态 queued/dispatched）；并入 = 原子 head-scoped 合并进待开任务（coalesced_comment_ids 留痕）。
3. 运行中不排队不注入：活动任务存在时，新评论走 deferred——完成时 `reconcileCommentsOnCompletion` 按 `created_at > since` 重放；义务跨状态传递（propagateUncoveredCommentObligation），绝不静默丢弃。
4. `activity_log` 表（workspace/issue/actor_type/actor/action/details JSONB）与我们 WorkItemActivity 同构——三实体分离方向被验证；其 comment 表另带 `type ∈ comment|status_change|progress_update|system` 供线程内系统条目展示。
5. 订阅 reason 闭集：creator/assignee/commenter/mentioned/manual（迁移 249 后加 delegated、迁移 120 加 autopilot）——与我们 §7.1 六 reason 同源多 autopilot。
6. 链顶人类归因 `OriginatorUserID` 与我们 `initiatedBy` 同构；agent 评论不参与 member 驱动的会话路由。

**分歧裁定（2026-10-05 用户逐项，五项全部定案）**：

| 项                 | multica 设计                                                                             | 我们现状（裁定前）                                       | 裁定                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| a. 隐式路由        | 人类评论对 agent 语境的 issue 默认触发（级联见 §4.5）；@all/@人名 抑制；agent 评论不参与 | 原规格普通评论 → N                                       | **对齐 multica（全量级联）**——§4.2/§4.4/§4.5 已同步改写                                    |
| b. 触发源闭集      | 五源                                                                                     | 原仅 mention 一源                                        | **一次全量进 C1**（用户裁定，超出主会话建议的分期；C1 范围与验收面相应扩大，§11.2 已更新） |
| c. @squad mention  | 触发其队长（mention_squad_leader）                                                       | 无                                                       | **对齐：触发队长**（含在 §4.5 与 @squad mention 规则中）                                   |
| d. 评论表混合 type | comment.type 含 status_change/progress_update/system                                     | Comment 纯沟通 + 独立 Activity（已被 activity_log 印证） | **维持三实体分离**；线程内系统条目展示形态实现轮再议（登记为有意差异）                     |
| e. 重放义务持久化  | best-effort（durable obligation 是其 out of scope，错误日志兜底）                        | §8.4 更严                                                | **维持 §8.4 更严标准**（multica 自认短板，不跟随）                                         |

**追加裁定（同轮取证发现，三项全部吸收，2026-10-05 用户勾选）**：评论软删除（`deletedAt` 墓碑，路由级联视已删父评论不算，§3.2/§4.5）、线程解决态（`resolvedAt`，§3.2）、表情回应（轻实体，永不触发，§3.2）；均进 C1 范围。

## 13. 实现纪律

- 先按 §4 的触发穷举写测试，再写 parser/dispatch；不得只覆盖 happy path。
- 新 Repo/Service 必须沿 `packages/services/src/workitem/` 既有深模块边界；UI 不直接访问 Repo。
- 共享 SQLite 连接、追加迁移、稳定 workspace binding、数据库唯一索引和 CAS 是接线前置。
- 任何实现报告必须区分“Comment/Activity/Decision 已落库”“dispatch event 已产生”“Run 已创建”“WorkItem status 已推进”四种事实，不能用“评论触发成功”概括全部。
- 本规格不修改现有设计规格和 `progress.md`；实现轮次应另建计划并由 controller 更新进度。
