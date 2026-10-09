# 遗留：跨机写调用把本端 identity 传给对端 —— 现存于脚本路径（产品路径未验证）

日期：2026-09-27（本节结论经复核后收窄）
状态：**脚本路径已修；产品 V4 路径未验证（不宣称有缺陷）**
关联：`.agents/plans/finding-remote-identity-write-duplication.md`（原始缺陷）

## 已确证的事实

对端（B）的 `tasks-index` 里曾出现 2 行带本端 identity 的索引：

```
remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_8c8af48f-808f-4435-9b13-dcd17bd68f50
remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_e38c8742-7e43-4058-883b-280cf1cb5023
```

**来源已定位**：两行的标题是 `[连通性探针 <ISO>] 请只回复"收到"…`，与
`packages/desktop/test/e2e-remote-continue-session.ts` 里的 `probeText` 逐字一致；
该脚本的 `createTask({ workspaceIdentity: remoteIdentity, v4Create: true })`
正是把本端标签传给对端 taskService 的地方。**即：这两行来自测试脚本，不是产品 UI 路径。**

两行后来消失（B 是活跃机器，其索引同步器把它们清掉了；B 的 tasks-index 总行数未变）。

## 已修的部分

1. **Controller 写路径**（`windowHostControllerService.ts` 的 `mutationParams`）
   用户在投射条目上做置顶/归档/删除/标记已读时，不再把本端 identity 发给对端。
   回归：`packages/desktop/test/writePathIdentityIsolation.test.ts`（6 项；
   已验证修复前 5 项失败、修复后全绿）。

2. **测试脚本的建会话路径**（本轮）
   `acceptance-write-path-isolation.ts`（层 3）改为**不传** identity 建会话，
   并由层 3 实测通过：会话落在对端自身的键
   （`/Volumes/数据盘/网站/新赛马`）上，对端 `remote:` 前缀行计数为 0，
   归档后未归档会话数回到基线 4。

## 未验证的部分（不要当成缺陷来修）

**产品 UI 的 V4 路径是否会把本端 identity 传到对端，尚无证据。**
相关事实：

- `remoteWorkspaceServiceCollection.ts:325` 把对端 agentService 原样注册
  （`.register(IZCodeAgentService, params.connectionServices.zcodeAgentService)`），
  该对象的方法参数类型 `ZCodeAgentWorkspaceTarget` **允许**携带 `workspaceIdentity`。
  "允许携带"不等于"实际携带"—— 是否携带取决于 renderer 传入什么、以及 host 转发时
  是否重写。
- 对端 bootstrap 侧对 `remote:` 前缀是 **fail-closed** 的
  （`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/workspace.ts:22-27`：
  非法 remote identity 直接抛错，不再落回本地路径），且注释明确写着
  「workspaceId 双形态（Workspace Identity 约束）…… 远程 pane（跨 workspace 分屏）
  = 远程 identity …… identity 原样保留进 workspace ref（workspaceKey = identity）」。
  这说明**远程 identity 进入对端 workspace ref 是被设计允许的语义**
  （跨 workspace 分屏要用它做隔离），并不等同于"误写重复行"。

因此不能仅凭类型允许就断言产品路径有缺陷。要判定必须实测。

## 建议的验证方式（只读，不动对端）

在 A 上通过投射 UI 新建一个会话，然后查对端库：

```sh
ssh <device> "sqlite3 ~/.zcode/v2/tasks-index.sqlite \
  \"select workspace_key, task_id from tasks where task_id='<新会话id>';\""
```

- 只有一行且键为纯项目路径 → 产品路径无泄漏，本项可结案。
- 出现两行（其中一行 `remote:` 前缀）→ 确认缺陷，再按"与读路径同口径剥离"修复，
  并补一条层 3 回归。

## 数据安全

上述"新建会话"验证会在对端产生一个真实会话（用户可见）。属于需要用户显式同意的
对端写操作，不应擅自执行。
