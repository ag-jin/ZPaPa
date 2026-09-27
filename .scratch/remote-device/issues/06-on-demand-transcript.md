# 06: 会话内容按需加载

**What to build:** 在投射端打开被投射设备的会话时，先加载最近的内容即可交互；向上滚动时再加载更早的历史，不一次性拉取全部。

**Blocked by:** 01

**Status:** done（诊断确认按需加载已存在；补 parts 窗口优化，实测 9.4x）

依据：实测单个会话可能有数百条消息与数千内容片段（一个真实会话有 593 条助手消息、2792 个内容片段），一次性全量拉取既慢又占内存。

- [ ] 打开会话时先显示最近内容，即可查看与继续对话
- [ ] 向上滚动时分段加载更早历史
- [ ] 加载过程不阻塞提交框的交互
- [ ] 已加载区间不重复拉取
- [ ] 验证：分段拉取返回的区间正确，与全量内容一致


## 实施记录（2026-09-27）

**先做的诊断**：结论是按需加载**早已实现**，用户感受到的"加载慢"另有其因。

已存在（v4 协议）：
- `conversationProjectionStore.ts:988` `loadOlder(limit)` → `rowsRange(beforeRowId)`
- `core.ts:75` `snapshotTailWindowRows: 60`（首屏窗口）
- `core.ts:76` `rowsRangeMaxLimit: 200`（单次分页上限）

实测定位到真正的瓶颈（CLI 日志 `session snapshot slow` 的分阶段耗时）：
- `buildSnapshot` 746ms（74%），其中 `persistedMessages` 263ms
- 根因：`readSessionMessages` 读取**全部** 3137 条消息的 14556 块 parts，
  而调用方拿到后立刻按 messageLimit 裁剪 —— 前面几千条的 parts 白读
- 拆解：message 全量 24ms，**part 全量 209ms（87%）**

**修法**：`messages()` 增加 `tailPartLimit`，只给尾部窗口装配 parts。
裁 parts 而非 messages —— rewind 分支投影需要完整消息序列。

**效果**：338.7ms → 35.9ms（9.4x）；尾部 60 条只需 242 块 parts（-98.3%）。
验证：新增 56 项不变量断言（8 会话 × 7 种窗口），锁住顺序与完整性。
