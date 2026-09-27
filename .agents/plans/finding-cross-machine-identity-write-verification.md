# 遗留缺陷：V4 agent 路径仍未剥离本端 remote identity

日期：2026-09-27
状态：**未修**（controller 路径已修，agent 路径待处理）
关联：`.agents/plans/finding-remote-identity-write-duplication.md`（原始缺陷）

## 已修的部分

`windowHostControllerService.ts` 的 `mutationParams` —— 用户对投射条目做
置顶/归档/删除/标记已读时，不再把本端 `remote:<kind>:...:path` 发给对端。
回归锁定：`packages/desktop/test/writePathIdentityIsolation.test.ts`（6 项，
已验证修复前 5 项失败、修复后全绿），并由三层跑器的层 1 覆盖。

## 未修的部分

`remoteWorkspaceServiceCollection.ts:325` 把对端 agentService **原样**注册：

```ts
.register(IZCodeAgentService, params.connectionServices.zcodeAgentService)
```

因此经 V4 协议发起的 `createSession` / `resumeTask` / `sendPrompt` 仍会把
本端 identity 透传到 B。实测证据：本轮修复前，B 的 tasks-index 里存在 2 条

```
remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_8c8af48f-...
remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马 | sess_e38c8742-...
```

即由 A 侧 `createTask({ workspaceIdentity })` 写出的行（标题为探针文案）。
这两行后来被 B 自己的索引同步器清掉了（B 是活跃机器），因此**该污染是自愈的**，
但它会在会话存在期间让 B 的列表多出一个以 `remote:...` 命名的项目分组。

## 为什么没在本次一并修

剥离 agent 路径的身份会改动 V4 会话建立的核心参数，而该路径同时承载
"投射端本地草稿 → 对端落库"的完整链路。修改需要：
1. 确认 V4 `createSession` 在对端是否依赖 identity 做 workspace 定位；
2. 覆盖 `resumeTask` / `sendPrompt` / `subscribe` 全部入口；
3. 用层 3 的写回归脚本验证（建会话 → 断言两端索引都只有一条）。
这三步值得独立一轮，不宜与"收敛与清理"混在一个提交里。

## 建议的下一步

在 `remoteWorkspaceServiceCollection` 里包一层剥离 identity 的 agentService，
与读路径（`readSourceTaskIndex`）和已修的写路径（`mutationParams`）同一口径：
**本端 identity 只在本端用，绝不跨机**。验收沿用
`packages/desktop/test/acceptance-write-path-isolation.ts`（层 3，
`node scripts/remote/regression.mjs --layer=3`）。
