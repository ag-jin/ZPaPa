# 发现：B 上同一项目存在两个 host、各自拉起独立 runtime —— 「各执行各的」根因

日期：2026-09-27
状态：**已诊断，未修**（架构级问题，需决策）
影响：用户报告"同一个会话在两端各跑各的"、"控制一端，另一端会话记录还停在原地"

## 现象（用户报告）

- 同一个会话 ID 在 A 端操作后，B 端 UI 仍停在原地（"A 已经多跑 30 轮"）。
- 两端进度不一致，看起来像各执行各的。

## 诊断方法与结论

先排除了"同一会话被两端同时执行"这个假设（**不成立**）：

```
会话 sess_dcb48f1d-1314-4633-a194-8b5ac93f3a79
  A 端 cli db:      0 条 session 记录 / 0 条消息
  B 端 cli db:      1 条 session 记录 / 2520 条消息
两端 session 表交集：0 条（1353 vs 1788）
```

该会话物理上只存在于 B。A 只是**显示**它（投射），不持有数据。所以"两端各跑一份同一个会话"
在数据层不成立。用户观察到的真实情况是：**B 自己内部有两个运行时在各自推进同一个项目**。

## 根因：B 上有两个 host，各自拉起独立的 zcode-cli runtime

实测 B 的进程树（2026-09-27 22:50）：

```
ZCode (pid 41003, B 的桌面 UI 主进程)
├── zcode-host-local-1 (pid 41020)          ← B 本机 UI 用的本地 host
│   └── zcode-cli: 41042(新赛马) 41043(电商技能) 41045(dsh-papa)
│                  41077(plugin) 58317(中转站)
└── ZCode Helper --type=utility (pid 41028) ← 常驻主机（供 A 远程投射挂载）
    └── zcode-cli: 41681(新赛马) 42100(新赛马) 47076(中转站)
                   73695(opencode) 75568(agent军团) 89625(电商技能)
                   18704(中转站)
```

**同一项目「新赛马」有三个 runtime**：41042（本机 host）+ 41681、42100（常驻主机）。
**「中转站」同样有三个**：58317（本机 host）+ 47076、18704（常驻主机）。

三个进程都打开同一份 `/Users/linguojin/.zcode/cli/db/db.sqlite`（含 -shm/-wal），
即共享数据层但**各自持有独立的 agent 运行时**。

## 为什么表现为"停在原地"（经用户两次修正后定稿）

**不是"视图不刷新"，而是"运行时各自持有独立的内存会话状态，且互不可见"。**

用户的关键修正：**"B 端 UI 可以在原本的进度继续，不会包含 A 端执行的记录。"**
这否定了"数据一致、只是列表没刷新"的初判 —— 若是那样，B 继续执行时会带上 A 的记录。

代码层面的决定性证据（三处）：

1. **会话运行时是每进程一份内存 Map**
   `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts:260`
   ```ts
   sessions: new Map<string, ZCodeProtocolSessionRecord>(),
   ```
   两个 host 是两个进程 → 两个独立的 `context.sessions`。

2. **resume 命中内存 record 就早退，不重读库**
   `server-operations.ts:1427-1431`
   ```ts
   const existing = context.sessions.get(params.sessionId);
   if (existing) {
     return { record: existing };   // ← 命中即返回，不查 sessionStore
   }
   let session = await getPersistedSession(context, params.sessionId);
   ```
   即：只有当会话**没被本进程载入过**时才从库读（冷恢复）；
   已经在跑的会话，后续轮次全部基于本进程内存态。

3. **事件账本也是内存态**
   `server.ts:240` → `createInMemorySessionEventStore()`。
   对话上下文由该 eventStore 组装，因此看不到别的进程写进库的新消息。

**结论**：两个 host 各自持有一份独立的会话运行态。A 通过常驻主机跑出的轮次写进了
共享库，但 B 本机 host 的内存 record 里没有这些消息，且因第 2 条**永不重读库** →
B 继续执行时从它自己的旧进度往下走，两边进度永久分叉。

这解释了用户的完整观察：B 能从原进度继续、且不含 A 的记录、两端进度不一致。

## 为什么刷新事件不是主因（对初判的修正）

`workspace_task_list_changed` 确实是进程内 Emitter（`taskIndexRepo` 不 watch 文件），
但它只影响"列表何时重画"。真正的分裂在**运行态本身**——即使把刷新补上，
B 的 runtime 内存里仍然没有 A 写的消息，下一轮生成还是会基于旧上下文。
所以修法 2（跨进程刷新通知）只是必要不充分。

## 与既有设计的关系

这不是投射功能引入的 bug，而是**两个 host 并存 + 运行态内存化**的必然结果：

- B 的桌面 UI 走 `zcode-host-local-1`（main 进程的子 host）。
- 常驻主机（`resident-host`）是独立 utility process，供远程挂载用。

单机单 host 时这没问题（每个会话只有一个 runtime，内存态就是权威）。
一旦同一台机器上有两个 host 触及同一份会话库，"谁是权威运行态"就没有答案了。

## 候选修法（需用户/架构决策）

**分层看待这个缺陷**：它其实由两个独立的问题叠成，修法与成本完全不同：

| 层 | 现象 | 根因 | 状态 |
|---|---|---|---|
| A. 列表刷新 | B 的 UI 看不到外部写入（标题/时间/状态停在原地） | 轮询兜底只覆盖远程 tab，本地 tab 从不兜底 | **已修**（`8c8d3fa`） |
| B. 会话正文 | 已载入的会话，其内存态不含对方写入 | `context.sessions` 每进程一份 + resume 命中即早退 | 待决策（下述 1/2/3） |

**A 层已修**：列表数据本来就新鲜（`listTasks` 走 SQLite），缺的只是"何时重查"。
去掉轮询的远程门槛后，本地项目同样每 60s 兜底一次 —— 双方 UI 都能看到对方的写入。

**B 层更根本**：即使 A 层修好，若某会话在两侧 runtime 都已载入，打开它看到的仍是
各自的内存态。修法即下述三条；其中 1 是唯一能让"运行态权威唯一"的方案。

1. **常驻主机与本地 host 合一**（B 的 UI 也挂常驻主机，撤销 `zcode-host-local-1`）
   —— 唯一能让"运行态权威唯一"的方案，因为内存态天然无法跨进程共享。
   改动面大（UI 连接生命周期、host 选举、常驻主机故障降级），且受
   `serviceAuthorityMode` 每-host 语义阻挡（见
   `finding-direct-app-connection-feasibility.md` 的硬冲突分析）。
2. **跨进程刷新通知**（共享库加 revision 标记，各 host 监听并触发本地事件）
   —— A 层已用轮询兜底替代，此项可降级为"若 60s 延迟不可接受再做"。
3. **同一 workspace 只允许一个 runtime**（共享库加租约，第二个 host 复用/让路）
   —— 能避免"同项目多 runtime"，但**跨机场景下 A 仍可能落到另一个 runtime**，
   除非租约覆盖"会话级"而非"项目级"。

## 未验证的部分 → 已验证

- **是否真的并发写同一会话**：**否**。该会话 2520 条消息按 id 前缀（runtime 启动 epoch）
  分组后时间区间**顺序不重叠**：

  ```
  msg_mug  511 条  09-25 16:40 → 19:03
  msg_muh  178 条  09-25 22:17 → 09-26 00:42
  msg_goa    2 条  09-25 23:26 → 09-26 00:15   （旁支，极少）
  msg_mui  666 条  09-26 18:27 → 23:33
  msg_muj 1162 条  09-27 09:40 → 22:34
  ```

  每个 epoch 独占一个时间段，没有"两个 epoch 在同一分钟交替追加"的痕迹。
  即：**不存在同一会话被两个 runtime 同时执行并写库**。

- **谁在跑**：三个「新赛马」runtime 的 CPU 累计时间对采样（2 秒）几乎不动 ——
  41042（本机 host）活跃、41681/42100（常驻主机）空闲。说明当前实际执行的是
  **B 本机 host 那个 runtime**，常驻主机的那两个只是驻留未退（各自启动于
  09-26 11:23 / 11:36，之后一直挂着）。

  这修正了最初"两个 host 各跑一份"的推断：更准确的说法是——
  **同项目存在多个驻留 runtime，但任一时刻只有一个在真正执行**；
  风险在于"下一个执行会落到哪个 runtime"没有协调，A 与 B 可能各自落到不同的一个。

## 复现方式（只读）

```sh
ssh <B> 'ps -eo pid,ppid,command | grep -E "[z]code-cli|[z]code-host"' 
# 观察同一项目出现多个 zcode-cli，且 ppid 分属两个不同的 host
```

```sh
# 验证执行归属：连续采样各 runtime 的 CPU 累计时间
ssh <B> 'for p in <pid1> <pid2>; do t1=$(ps -p $p -o time=); sleep 2; t2=$(ps -p $p -o time=); echo "$p: $t1 -> $t2"; done'
```
