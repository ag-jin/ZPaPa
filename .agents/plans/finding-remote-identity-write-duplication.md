# 缺陷：远程写操作带 identity 会在对端库里产生重复索引行

## 现象（2026-09-26 实测）

在 A 上对 B 的会话执行 `resumeTask({taskId, workspacePath, workspaceIdentity: "remote:ssh:..."})` 后，
B 的 `~/.zcode/v2/tasks-index.sqlite` 中该会话出现**两条记录**：

| workspace_key | 来源 |
|---|---|
| `/Volumes/数据盘/网站/新赛马` | 对端本地正常写入 |
| `remote:ssh:100.66.1.2:22:linguojin:/Volumes/数据盘/网站/新赛马` | **本端 identity 被透传写入对端** |

已手工清理（`DELETE FROM tasks WHERE workspace_key LIKE 'remote:%'`）。

## 根因

写路径（`rememberTaskTarget` / `syncTaskMeta`）会把调用方传入的 `workspaceIdentity`
原样落库。远程调用时该 identity 是**本端为远程工作区起的隔离标签**，对端从未写过这个键，
于是产生一条永远不该存在的重复行。

这与读路径的修复（`60d1b9e`：远程 source 只按 workspacePath 查对端）是**同一个根因的另一面**：
**本端 identity 不应该跨机传递到对端的数据层**。

## 影响面（待评估）

- 重复行会污染对端会话列表（同一会话显示两次）
- 可能影响对端的去重、排序、归档逻辑
- 读路径已修；写路径**未修**

## 修复方向

与读路径对称：写操作（resumeTask/sendPrompt/createTask 等）在到达**对端 taskService 之前**
剥离本端 remote identity，让对端按自己的键写入。实现落点应在 host 侧的远程 service 代理层
（与 `readSourceTaskIndex` 同一位置），而非各调用点分别处理。

## 验证手段

`packages/desktop/test/e2e-remote-continue-session.ts` 已能复现该现象（脚本内 resume 后
查对端库可看到重复行）。修复后应断言：resume 后对端库中该会话**仍只有一条**记录。
