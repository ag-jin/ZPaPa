# 07: 收敛与清理

**What to build:** 把探索期留下的临时验证脚本收敛为可长期回归的资产，更新文档，并确认投射端不残留任何会话索引。

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** done（工单 03 的「添加项目」入口除外 —— 需对端写能力，见工单 05）

## 三层接缝（收敛结果）

统一入口：`node scripts/remote/regression.mjs`（npm: `pnpm remote:regression`）

| 层 | 性质 | 数量 | 跑法 |
|---|---|---|---|
| 1 | 纯函数/契约，无设备无网络，约 4 秒 | 9 项 | `pnpm remote:regression:l1` |
| 2 | 跨机只读，需 B 在线 | 5 项 | `pnpm remote:regression:l2` |
| 3 | 跨机写带回滚，需 B 在线**且会写对端** | 1 项 | `--layer=3` 或 `--layer=all` |

层 3 默认不跑：写测试必须是有意识的动作，而不是默认行为。

## 勾选

- [x] 探索期脚本中验证手段有效的收敛为回归脚本（按三层接缝归类）
      实测：层 1 9/9 通过（3.8s）、层 2 5/5 通过（跨机，含隧道端到端与索引隔离）
- [x] 一次性脚本清理，不堆积
      删除 3 个已被验收脚本完全取代的原型（`prototype-projection.ts`、
      `prototype-projection-scoped.ts`、`prototype-remote-settings.ts`）；
      其结论早已落在 `.agents/plans/prototype-projection-report.md`，
      且读/写/设置三条通路分别由 `acceptance-device-access`、
      `acceptance-projection-sync`、`acceptance-remote-device-settings` 接管
- [x] 确认投射端任务库中不存在远程前缀的索引行（当前为 0，需保持）
      新增不变量回归 `acceptance-index-isolation.ts`（层 2）：
      同时断言 A 端无远程前缀行、且 B 端返回的会话不带 A 的 identity。
      实测 A 端 214 行中 byKey/byIdentity/byTaskId 均为 0
- [x] 更新领域文档（如实现过程中出现新的术语或决策）
      CONTEXT.md 补「会话尾部窗口」「回环预览隧道」「索引隔离」术语；
      工单索引表更新到 08；新增 ADR 0002（三层回归与测试目录纳入类型检查）
- [x] 全套检查通过：类型检查、Lint、架构检查
      `pnpm typecheck` ✅（含新增的两个 test 工程）/ 改动文件 `oxlint` 0 告警 ✅ /
      `pnpm architecture:check` 0 违规 ✅
- [x] 回归脚本可自行运行并复现关键结论
      `node scripts/remote/regression.mjs --list` 列出全部 15 项；
      层 1 不依赖设备可单独跑；跨机层设备不可达时明确报错而非静默跳过

## 顺带修掉的真实缺陷

收敛过程中发现并修复（不属于原计划，但属同一约束的缺口）：

1. **controller 写路径泄漏本端 identity**（`mutationParams`）
   用户对投射条目置顶/归档/删除时，把 `remote:...` 标签发给对端 taskService，
   对端按一个它从未写过的键落库 → 重复行。实测 B 的 tasks-index 曾有 2 条这样的行
   （标题与本轮探针一致，可确认来自 A 侧写入）。
   修复后由 `writePathIdentityIsolation.test.ts` 锁定（已验证：修复前 5/6 失败）。

2. **`test/` 目录不在任何 tsconfig 里**
   这正是 `e2e-remote-continue-session.ts` 引用未定义的 `createdSessionIds` /
   `assertTestOwnedTarget` 却长期无人发现的原因（脚本运行到护栏处即崩溃，
   而那已在建完会话之后 —— 每跑一次都在对端留垃圾且拿不到结论）。
   新增 `packages/desktop/tsconfig.test.json` 与 `packages/ui/tsconfig.test.json`，
   并入 `pnpm typecheck`；顺带修掉 27 处既有类型错误（含 3 处「断言永远为真」的
   测试：union 上直接取 `remotePort`、字段名 `id` 写成 `toolId`）。

3. **回环预览测试的断言退化**
   `remoteLoopbackPreview.test.ts` 在判别联合上直接读 `.remotePort`，
   两边都是 `undefined` 也算相等 —— 断言永远为真。改为按 `kind` 收窄后取端口。

4. **`e2e-remote-continue-session.ts` 声称归档但从不归档**
   注释写「验证完即归档」，实际无归档调用。已补归档 + 隔离护栏。

## 未做 / 待办

- **工单 03 的「添加项目」入口**：需设备侧写能力（在 B 上登记新项目），
  按用户约束「涉及对端写操作需显式确认」，未擅自实现。见工单 05。
- **V4 agent 路径仍会透传本端 identity**（`remoteWorkspaceServiceCollection.ts:325`
  原样注册对端 agentService）。已记录在
  `.agents/plans/finding-v4-agent-path-identity-leak.md`：影响是 B 的列表在会话
  存活期间会多出一个 `remote:...` 命名的项目分组（B 自己的同步器会清掉）。
  改动涉及 V4 会话建立核心参数，值得独立一轮 + 层 3 验证。
